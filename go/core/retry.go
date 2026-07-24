package core

// DefaultScheduleMs is the default backoff schedule: ~5s, 30s, 2m, 10m, 30m,
// 1h, 3h, 6h (8 attempts, ~12h total) then DLQ.
var DefaultScheduleMs = []int64{
	5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000,
}

// RetryAfterCapMs caps a receiver-supplied Retry-After so it cannot push
// delivery out arbitrarily far. 6h, the largest schedule step.
const RetryAfterCapMs int64 = 21_600_000

// DefaultRetryConfig is the default RetryConfig using DefaultScheduleMs.
var DefaultRetryConfig = RetryConfig{ScheduleMs: DefaultScheduleMs}

// NextDelayMs returns the delay (ms) before the given 0-based attempt, and
// true, or (0, false) when the schedule is exhausted (caller should DLQ).
//
// When retryAfterMs is non-nil (429/503 Retry-After), it wins but is capped
// by RetryAfterCapMs. Otherwise full jitter is applied over [0, base) for
// that attempt's base delay.
func NextDelayMs(cfg RetryConfig, attemptNo int, rng Rng, retryAfterMs *int64) (int64, bool) {
	if attemptNo < 0 || attemptNo >= len(cfg.ScheduleMs) {
		return 0, false
	}
	if retryAfterMs != nil && *retryAfterMs >= 0 {
		v := *retryAfterMs
		if v > RetryAfterCapMs {
			v = RetryAfterCapMs
		}
		return v, true
	}
	return FullJitter(cfg.ScheduleMs[attemptNo], rng), true
}
