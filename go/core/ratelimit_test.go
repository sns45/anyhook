package core

import "testing"

// TestCapacityFor mirrors TS "capacity is ~1s of tokens, minimum 1".
func TestCapacityFor(t *testing.T) {
	tests := []struct {
		name string
		rate float64
		want float64
	}{
		{"below 1 clamps to 1", 0.5, 1},
		{"above 1 passes through", 5, 5},
		{"zero clamps to 1", 0, 1},
		{"negative clamps to 1", -3, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CapacityFor(tt.rate); got != tt.want {
				t.Errorf("CapacityFor(%v) = %v, want %v", tt.rate, got, tt.want)
			}
		})
	}
}

// TestInitialBucket mirrors the TS initialBucket helper: full capacity, last-refill == now.
func TestInitialBucket(t *testing.T) {
	b := InitialBucket(2, 1000)
	if b.Tokens != 2 {
		t.Errorf("Tokens = %v, want 2", b.Tokens)
	}
	if b.LastRefillMs != 1000 {
		t.Errorf("LastRefillMs = %v, want 1000", b.LastRefillMs)
	}
}

// TestConsumeToken mirrors TS policy-ratelimit.test.ts table-for-table.
func TestConsumeToken(t *testing.T) {
	t.Run("a full bucket allows immediately and decrements", func(t *testing.T) {
		b := InitialBucket(1, 1000)
		allowed, next, retryAfterMs := ConsumeToken(b, 1, 1000)
		if !allowed {
			t.Fatal("allowed = false, want true")
		}
		if diff := next.Tokens - 0; diff < -1e-5 || diff > 1e-5 {
			t.Errorf("next.Tokens = %v, want ~0", next.Tokens)
		}
		if retryAfterMs != 0 {
			t.Errorf("retryAfterMs = %v, want 0", retryAfterMs)
		}
	})

	t.Run("an empty bucket throttles with the correct retry-after", func(t *testing.T) {
		empty := RateBucket{Tokens: 0, LastRefillMs: 1000}
		allowed, _, retryAfterMs := ConsumeToken(empty, 1, 1000) // no time elapsed -> still empty
		if allowed {
			t.Fatal("allowed = true, want false")
		}
		if retryAfterMs != 1000 {
			t.Errorf("retryAfterMs = %v, want 1000 (1 token/sec -> 1s until the next token)", retryAfterMs)
		}
	})

	t.Run("refills over elapsed time, capped at capacity", func(t *testing.T) {
		empty := RateBucket{Tokens: 0, LastRefillMs: 1000}
		allowed, next, _ := ConsumeToken(empty, 2, 1000+1000) // 1s @ 2/sec -> +2 tokens, consume 1
		if !allowed {
			t.Fatal("allowed = false, want true")
		}
		if diff := next.Tokens - 1; diff < -1e-5 || diff > 1e-5 {
			t.Errorf("next.Tokens = %v, want ~1", next.Tokens)
		}

		_, overfull, _ := ConsumeToken(RateBucket{Tokens: 0, LastRefillMs: 0}, 2, 10_000) // huge elapsed
		if overfull.Tokens > CapacityFor(2) {
			t.Errorf("overfull.Tokens = %v, want <= capacity %v", overfull.Tokens, CapacityFor(2))
		}
	})

	t.Run("consuming past empty never goes negative on the reported retryAfterMs", func(t *testing.T) {
		empty := RateBucket{Tokens: 0, LastRefillMs: 1000}
		_, _, retryAfterMs := ConsumeToken(empty, 4, 1000) // 4/sec, still empty -> 250ms until next token
		if retryAfterMs != 250 {
			t.Errorf("retryAfterMs = %v, want 250", retryAfterMs)
		}
	})
}
