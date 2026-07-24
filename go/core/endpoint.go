package core

// Endpoint is a customer-registered delivery destination, scoped to a tenant.
// Mirrors TS Endpoint (packages/core/src/types/endpoint.ts).
type Endpoint struct {
	EndpointID string
	Tenant     string
	URL        string
	// EventTypes is the set of subscribed event types; an event fans out to
	// endpoints subscribed to its type (see Subscribes).
	EventTypes  []string
	Description string
	Disabled    bool
	// RateLimit is an optional per-endpoint delivery rate limit
	// (deliveries/sec). Nil means unset (no limit configured).
	RateLimit *float64
	CreatedAt int64
	// Secrets holds the endpoint's active signing secret(s). Secrets[0] is
	// primary; a second entry exists during a rotation window.
	Secrets []string
}

// CircuitState is the per-endpoint circuit-breaker state.
type CircuitState string

const (
	CircuitClosed   CircuitState = "closed"
	CircuitOpen     CircuitState = "open"
	CircuitHalfOpen CircuitState = "half-open"
)

// CircuitRecord is the per-endpoint circuit-breaker state persisted in the
// durable StateStore. Mirrors TS CircuitRecord.
type CircuitRecord struct {
	State               CircuitState
	ConsecutiveFailures int
	// OpenedAt is the epoch-ms the circuit opened; non-nil only while State == CircuitOpen.
	OpenedAt   *int64
	CooldownMs int64
}

// RateBucket is per-endpoint token-bucket rate-limit state persisted in the
// durable StateStore. Mirrors TS RateBucket (packages/core/src/types/endpoint.ts).
type RateBucket struct {
	// Tokens is the available delivery tokens (fractional).
	Tokens float64
	// LastRefillMs is the epoch-ms the bucket was last refilled.
	LastRefillMs int64
}
