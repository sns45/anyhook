package core_test

import (
	"testing"

	"github.com/sns45/anyhook/go/core"
)

type constRng float64

func (r constRng) Next() float64 { return float64(r) }

type sequenceRng struct {
	vals []float64
	i    int
}

func (r *sequenceRng) Next() float64 {
	v := r.vals[r.i%len(r.vals)]
	r.i++
	return v
}

// lcgRng is a simple non-repeating (for practical test lengths) deterministic
// Rng, used where a test needs many distinct draws (e.g. distinct ids).
type lcgRng struct{ s uint32 }

func newLCGRng(seed uint32) *lcgRng {
	if seed == 0 {
		seed = 1
	}
	return &lcgRng{s: seed}
}

func (r *lcgRng) Next() float64 {
	r.s = r.s*1664525 + 1013904223
	return float64(r.s) / 4294967296.0
}

func TestDefaultScheduleMs(t *testing.T) {
	want := []int64{5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000}
	if len(core.DefaultScheduleMs) != len(want) {
		t.Fatalf("len(DefaultScheduleMs) = %d, want %d", len(core.DefaultScheduleMs), len(want))
	}
	for i, v := range want {
		if core.DefaultScheduleMs[i] != v {
			t.Errorf("DefaultScheduleMs[%d] = %d, want %d", i, core.DefaultScheduleMs[i], v)
		}
	}
}

func TestFullJitterBounds(t *testing.T) {
	tests := []struct {
		name string
		r    float64
	}{
		{"zero", 0},
		{"low", 0.001},
		{"mid", 0.5},
		{"high", 0.999999},
	}
	base := int64(120_000)
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := core.FullJitter(base, constRng(tc.r))
			if got < 0 || got > base {
				t.Errorf("FullJitter(%d, %v) = %d, out of [0,%d]", base, tc.r, got, base)
			}
		})
	}
}

func TestNextDelayMsSchedule(t *testing.T) {
	cfg := core.RetryConfig{ScheduleMs: core.DefaultScheduleMs}
	rng := constRng(1) // full jitter always returns exactly the base (rng.Next() == 1 is the sup, but constRng lets us pin it)

	for attempt := 0; attempt < len(cfg.ScheduleMs); attempt++ {
		delay, ok := core.NextDelayMs(cfg, attempt, rng, nil)
		if !ok {
			t.Fatalf("attempt %d: expected ok=true", attempt)
		}
		if delay < 0 || delay > cfg.ScheduleMs[attempt] {
			t.Errorf("attempt %d: delay %d out of [0,%d]", attempt, delay, cfg.ScheduleMs[attempt])
		}
	}

	// Exhausted schedule -> DLQ sentinel.
	if _, ok := core.NextDelayMs(cfg, len(cfg.ScheduleMs), rng, nil); ok {
		t.Error("expected ok=false once the schedule is exhausted")
	}
	if _, ok := core.NextDelayMs(cfg, -1, rng, nil); ok {
		t.Error("expected ok=false for a negative attempt number")
	}
}

func TestNextDelayMsRetryAfterWins(t *testing.T) {
	cfg := core.RetryConfig{ScheduleMs: core.DefaultScheduleMs}
	rng := constRng(0.5)

	retryAfter := int64(2_000)
	delay, ok := core.NextDelayMs(cfg, 0, rng, &retryAfter)
	if !ok || delay != retryAfter {
		t.Fatalf("NextDelayMs with retryAfterMs=%d = (%d, %v), want (%d, true)", retryAfter, delay, ok, retryAfter)
	}
}

func TestNextDelayMsRetryAfterCapped(t *testing.T) {
	cfg := core.RetryConfig{ScheduleMs: core.DefaultScheduleMs}
	rng := constRng(0.5)

	huge := int64(999_999_999)
	delay, ok := core.NextDelayMs(cfg, 0, rng, &huge)
	if !ok || delay != core.RetryAfterCapMs {
		t.Fatalf("NextDelayMs with huge retryAfterMs = (%d, %v), want (%d, true)", delay, ok, core.RetryAfterCapMs)
	}
}

func TestNextDelayMsNegativeRetryAfterIgnored(t *testing.T) {
	cfg := core.RetryConfig{ScheduleMs: core.DefaultScheduleMs}
	rng := constRng(1)
	neg := int64(-1)
	delay, ok := core.NextDelayMs(cfg, 0, rng, &neg)
	if !ok {
		t.Fatal("expected ok=true")
	}
	// Negative retryAfterMs is ignored; falls back to jittered schedule base.
	if delay != cfg.ScheduleMs[0] {
		t.Fatalf("delay = %d, want fallback to schedule base %d", delay, cfg.ScheduleMs[0])
	}
}
