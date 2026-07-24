/*
Package core is the runtime-agnostic anyhook delivery engine: fan-out,
signing (via an injected port), delivery, jittered-backoff retry, per-endpoint
circuit-breaking, and dead-lettering. It mirrors packages/core/src in the
TypeScript implementation, which remains the source of truth for behavior.

Every adapter dependency (durable storage, message transport, scheduling,
outbound HTTP, webhook signing, SSRF policy, clock, randomness) is expressed
as a port (interface) in this file; core itself imports no broker or crypto
SDKs, matching the TS "zero-runtime-dep" goal (G1).
*/
package core

import "context"

// Clock is a monotonic-ish wall clock (epoch ms). Injected for deterministic tests.
type Clock interface {
	Now() int64
}

// Rng is a uniform random source in [0, 1). Injected so jitter/ids are deterministic in tests.
type Rng interface {
	Next() float64
}

// HTTPResult is the result of a single delivery POST. Headers uses lowercased
// keys so the engine can honor Retry-After. Status is either a real HTTP
// status code or one of the AttemptStatus sentinels (StatusTimeout, StatusNetwork).
type HTTPResult struct {
	Status  AttemptStatus
	Body    string
	Headers map[string]string
}

// HTTPClient is the outbound HTTP capability. Adapters enforce SSRF/redirect
// policy at connection time and translate transport failures into
// HTTPResult{Status: StatusTimeout | StatusNetwork} rather than returning a
// Go error — this mirrors the TS port, whose `post()` never rejects.
type HTTPClient interface {
	Post(ctx context.Context, url string, body string, headers map[string]string, timeoutMs int64) HTTPResult
}

// URLCheckResult is the result of a URLPolicy check.
type URLCheckResult struct {
	Allowed bool
	Reason  string
}

// URLPolicy is the SSRF/scheme policy applied before delivery.
type URLPolicy interface {
	Check(ctx context.Context, url string) URLCheckResult
}

// WebhookSigner is the Standard Webhooks signing capability, injected so
// package core stays zero-runtime-dep (G1); package signing provides a
// structurally-compatible implementation. secrets is the endpoint's active
// signing secret(s) (more than one during a rotation window).
type WebhookSigner interface {
	Sign(secrets []string, id string, payload string, timestampMs int64) map[string]string
}

// Transport is the durable-buffering axis (anyq). anyhook composes a
// transport here; endpoint retry state NEVER lives in the transport (G2).
type Transport interface {
	// Send durably enqueues a message for delivery. Returns at durable
	// acceptance (G5).
	Send(ctx context.Context, m Message) error
	// Subscribe registers the delivery handler (the engine's ProcessMessage).
	Subscribe(ctx context.Context, handler func(ctx context.Context, m Message) error) error
}

// Scheduler owns "attempt this message again at time T" (the state store is
// the schedule).
type Scheduler interface {
	ScheduleRetry(ctx context.Context, m Message, at int64) error
}

// DeliveryQuery is the query shape for the delivery-log surface. Zero values
// mean "unset" for every optional field (Status == "", Before/After == nil, Limit == 0).
type DeliveryQuery struct {
	Tenant     string
	EndpointID string
	EventType  string
	Status     MessageStatus
	Before     *int64
	After      *int64
	Limit      int
}

// EventRecordResult is returned by StateStore.RecordEvent.
type EventRecordResult struct {
	// IsNew is false if the (tenant, idemKey) pair was already accepted.
	IsNew        bool
	EventID      string
	MessageCount int
}

// CreateEndpointInput is the input to StateStore.CreateEndpoint.
type CreateEndpointInput struct {
	Tenant      string
	URL         string
	EventTypes  []string
	Description string
	RateLimit   *float64
}

// CreateEndpointResult is returned by StateStore.CreateEndpoint. The secret
// is returned once, matching the TS "secret returned only at creation" contract (G10).
type CreateEndpointResult struct {
	Endpoint Endpoint
	Secret   string
}

// UpdateEndpointPatch is a partial update to an Endpoint. A nil field means
// "leave unchanged"; EventTypes uses a pointer-to-slice for the same reason
// (a non-nil pointer to an empty slice means "clear the subscriptions").
type UpdateEndpointPatch struct {
	URL        *string
	EventTypes *[]string
	Disabled   *bool
}

// DlqEntry pairs a dead-lettered message with the reason it was dead-lettered.
type DlqEntry struct {
	Message Message
	Reason  DlqReason
}

// DeliveryRow pairs a message with its full attempt history.
type DeliveryRow struct {
	Message  Message
	Attempts []Attempt
}

// StateStore is the durable state axis: idempotency, endpoints, messages,
// attempts, circuit state, DLQ. Every method is tenant-scoped (G7).
type StateStore interface {
	// RecordEvent implements idempotency: returns IsNew == false if the
	// (tenant, idemKey) was already accepted.
	RecordEvent(ctx context.Context, tenant, eventID, idemKey string) (EventRecordResult, error)
	// FinalizeEvent persists the acceptance result for an idempotency key so
	// replays of Send return the same receipt.
	FinalizeEvent(ctx context.Context, tenant, idemKey, eventID string, messageCount int) error

	CreateEndpoint(ctx context.Context, in CreateEndpointInput) (CreateEndpointResult, error)
	// GetEndpoint returns (nil, nil) when the endpoint does not exist for this tenant.
	GetEndpoint(ctx context.Context, tenant, endpointID string) (*Endpoint, error)
	ListEndpoints(ctx context.Context, tenant string) ([]Endpoint, error)
	MatchEndpoints(ctx context.Context, tenant, eventType string) ([]Endpoint, error)
	UpdateEndpoint(ctx context.Context, tenant, endpointID string, patch UpdateEndpointPatch) (Endpoint, error)
	RotateSecret(ctx context.Context, tenant, endpointID string) (string, error)
	DeleteEndpoint(ctx context.Context, tenant, endpointID string) error

	PutMessage(ctx context.Context, m Message) error
	// GetMessage returns (nil, nil) when the message does not exist for this tenant.
	GetMessage(ctx context.Context, tenant, messageID string) (*Message, error)
	AppendAttempt(ctx context.Context, a Attempt) error
	ListDeliveries(ctx context.Context, q DeliveryQuery) ([]DeliveryRow, error)

	GetCircuit(ctx context.Context, tenant, endpointID string) (CircuitRecord, error)
	PutCircuit(ctx context.Context, tenant, endpointID string, rec CircuitRecord) error

	AddToDlq(ctx context.Context, m Message, reason DlqReason) error
	ListDlq(ctx context.Context, tenant, endpointID string) ([]DlqEntry, error)
}
