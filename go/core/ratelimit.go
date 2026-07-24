package core

import "math"

// CapacityFor returns the bucket capacity (max burst) for a given rate: up
// to ~1s worth of tokens, minimum 1. Mirrors TS capacityFor
// (packages/core/src/policy/ratelimit.ts).
func CapacityFor(rateLimitPerSec float64) float64 {
	return math.Max(1, rateLimitPerSec)
}

// InitialBucket returns a fresh, full bucket for an endpoint's rate limit.
func InitialBucket(rateLimitPerSec float64, now int64) RateBucket {
	return RateBucket{Tokens: CapacityFor(rateLimitPerSec), LastRefillMs: now}
}

// ConsumeToken refills bucket for elapsed time, then tries to consume one
// delivery token. When empty, it returns allowed=false with retryAfterMs set
// to the time until the next token is available -- the caller throttles by
// rescheduling the message (never dropping it). rateLimitPerSec is
// deliveries/second. Mirrors TS consumeToken.
func ConsumeToken(bucket RateBucket, rateLimitPerSec float64, now int64) (allowed bool, next RateBucket, retryAfterMs int64) {
	capacity := CapacityFor(rateLimitPerSec)
	elapsedSec := math.Max(0, float64(now-bucket.LastRefillMs)/1000)
	tokens := math.Min(capacity, bucket.Tokens+elapsedSec*rateLimitPerSec)

	if tokens >= 1 {
		return true, RateBucket{Tokens: tokens - 1, LastRefillMs: now}, 0
	}
	retryAfterMs = int64(math.Ceil(((1 - tokens) / rateLimitPerSec) * 1000))
	return false, RateBucket{Tokens: tokens, LastRefillMs: now}, retryAfterMs
}
