package core

import "strconv"

// AttemptStatus is a delivery attempt's transport status: either a real HTTP
// status code (>= 100) or one of the non-numeric sentinels below.
//
// TS models this as `number | 'timeout' | 'network'`; Go has no built-in
// union type, so negative sentinel values stand in for the two non-numeric
// cases (real HTTP status codes are always non-negative).
type AttemptStatus int

const (
	// StatusTimeout indicates the request exceeded its deadline.
	StatusTimeout AttemptStatus = -1
	// StatusNetwork indicates a network-level failure (e.g. connection refused, DNS, SSRF refusal).
	StatusNetwork AttemptStatus = -2
)

// String renders "timeout", "network", or the decimal status code.
func (s AttemptStatus) String() string {
	switch s {
	case StatusTimeout:
		return "timeout"
	case StatusNetwork:
		return "network"
	default:
		return strconv.Itoa(int(s))
	}
}

// IsCode reports whether s represents a real HTTP status code (as opposed to
// the timeout/network sentinels).
func (s AttemptStatus) IsCode() bool {
	return s != StatusTimeout && s != StatusNetwork
}

// AttemptOutcome is the terminal classification recorded against an Attempt
// (distinct from Outcome, which classifies a single transport result before
// it's known whether a retry follows).
type AttemptOutcome string

const (
	AttemptDelivered AttemptOutcome = "delivered"
	AttemptRetried   AttemptOutcome = "retried"
	AttemptDead      AttemptOutcome = "dead"
)

// Attempt is one HTTP POST try for a message. Append-only in the delivery log.
// Mirrors TS Attempt (packages/core/src/types/attempt.ts).
type Attempt struct {
	MessageID  string
	EndpointID string
	Tenant     string
	EventType  string
	// AttemptNo is the 0-based attempt index.
	AttemptNo int
	Status    AttemptStatus
	LatencyMs int64
	// RespSnippet is a truncated response body snippet (secrets/configured fields redacted).
	RespSnippet string
	Ts          int64
	Outcome     AttemptOutcome
}

// DlqReason is a machine-readable reason a message landed in the DLQ.
type DlqReason string

const (
	// ReasonExhaustedRetries: retry schedule ran out.
	ReasonExhaustedRetries DlqReason = "exhausted_retries"
	// ReasonPermanent4xx: receiver returned a non-retryable 4xx/3xx.
	ReasonPermanent4xx DlqReason = "permanent_4xx"
	// ReasonBlockedSSRF: target refused by the URL/SSRF policy (never delivered).
	ReasonBlockedSSRF DlqReason = "blocked_ssrf"
	// ReasonEndpointGone: endpoint was deleted/disabled after the message was enqueued.
	ReasonEndpointGone DlqReason = "endpoint_gone"
	// ReasonCircuitOpenExpired is reserved for a future "parked past max retention" path (not emitted in M1).
	ReasonCircuitOpenExpired DlqReason = "circuit_open_expired"
)
