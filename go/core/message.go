package core

import "encoding/json"

// MessageStatus is the delivery status for one message.
type MessageStatus string

const (
	// StatusPending: accepted, not yet attempted.
	StatusPending MessageStatus = "pending"
	// StatusDelivering: attempt in flight.
	StatusDelivering MessageStatus = "delivering"
	// StatusDelivered: received a 2xx.
	StatusDelivered MessageStatus = "delivered"
	// StatusRetrying: transient failure, scheduled for a future attempt.
	StatusRetrying MessageStatus = "retrying"
	// StatusBlocked: endpoint circuit is open; parked, not counted as an attempt.
	StatusBlocked MessageStatus = "blocked"
	// StatusDead: moved to the DLQ (exhausted or permanent failure).
	StatusDead MessageStatus = "dead"
)

// Message is one (event x endpoint) delivery obligation. Fan-out turns one
// event into N messages, each with INDEPENDENT retry/circuit state (the key
// isolation invariant, G3). Mirrors TS Message (packages/core/src/types/message.ts).
type Message struct {
	MessageID  string
	Tenant     string
	EndpointID string
	EventID    string
	EventType  string
	Payload    json.RawMessage
	// AttemptNo is the 0-based attempt index into the retry schedule.
	AttemptNo int
	Status    MessageStatus
	// NextAttemptAt is the epoch-ms of the next scheduled attempt, set when
	// Status == StatusRetrying.
	NextAttemptAt *int64
	CreatedAt     int64
}
