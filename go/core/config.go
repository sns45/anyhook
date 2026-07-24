package core

// RetryConfig is the retry backoff configuration. Base delays in ms; full
// jitter is applied per attempt (see NextDelayMs). Length of ScheduleMs is
// the max attempts before DLQ.
type RetryConfig struct {
	ScheduleMs []int64
}

// CircuitConfig is circuit-breaker tuning. Engine-level in M1 (per-endpoint
// override is a post-v1 option, matching TS).
type CircuitConfig struct {
	// FailureThreshold: consecutive failed messages before the circuit opens (default 5).
	FailureThreshold int
	// CooldownMs: cooldown before an open circuit transitions to half-open.
	CooldownMs int64
}
