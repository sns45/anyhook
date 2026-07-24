package core

import "encoding/json"

// SendEvent is a single business occurrence submitted by a producer via
// Engine.Send. Mirrors TS SendEvent (packages/core/src/types/event.ts).
type SendEvent struct {
	// Type is the dot-namespaced event type, e.g. "payment.succeeded". Required.
	Type string
	// Tenant is the isolation scope (the producer's customer). Required.
	Tenant string
	// Payload is the JSON-serializable event payload. Required.
	//
	// Represented as json.RawMessage (raw bytes of an already-encoded JSON
	// document) rather than `any`, so the wire body used for HMAC signing and
	// idempotency-key derivation is byte-for-byte deterministic — the same
	// design anyq's Go port uses for message bodies. Callers that hold a Go
	// value should json.Marshal it first: `json.Marshal(v)`.
	Payload json.RawMessage
	// IdempotencyKey is optional; auto-derived from the event when empty (see
	// DeriveIdempotencyKey).
	IdempotencyKey string
	// Metadata carries optional, non-signed routing hints.
	Metadata map[string]string
}

// Receipt is returned by Engine.Send once the event is durably accepted. It
// never blocks on delivery (G5).
type Receipt struct {
	EventID string
	// Accepted is always true for a successfully returned Receipt; Send
	// returns an error instead of a false value on failure (idiomatic Go, in
	// place of the TS `accepted: true` literal type).
	Accepted bool
	// MessageCount is the number of matched endpoints at acceptance time. 0 is
	// valid and not an error.
	MessageCount int
}
