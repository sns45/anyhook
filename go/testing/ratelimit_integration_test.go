package testing_test

import (
	"context"
	"fmt"
	"sort"
	"testing"

	"github.com/sns45/anyhook/go/core"
	anyhooktesting "github.com/sns45/anyhook/go/testing"
)

// TestRateLimitThrottlesNeverDrops mirrors
// packages/core/test/ratelimit-integration.test.ts: 3 events sent to a
// 1/sec-limited endpoint must all deliver, spaced ~1s apart -- rate limiting
// throttles by rescheduling, it never drops a message.
func TestRateLimitThrottlesNeverDrops(t *testing.T) {
	h := newHarness(t, 11)
	h.clock.Set(1_000)
	url := "https://slow.example.com/hook"
	h.receiver.On(url, anyhooktesting.ReceiverOK())

	rate := 1.0
	if _, err := h.state.CreateEndpoint(context.Background(), core.CreateEndpointInput{
		Tenant: "acme", URL: url, EventTypes: []string{"*"}, RateLimit: &rate,
	}); err != nil {
		t.Fatalf("CreateEndpoint: %v", err)
	}

	for i := 0; i < 3; i++ {
		// Distinct payloads: identical (tenant, type, payload) would derive the
		// same idempotency key and collapse to a single accepted event.
		h.send(t, "acme", "e.t", fmt.Sprintf(`{"i":%d}`, i))
	}
	h.run(t)

	// All three delivered -- throttling reschedules, never drops.
	delivered, err := h.state.ListDeliveries(context.Background(), core.DeliveryQuery{Tenant: "acme", Status: core.StatusDelivered})
	if err != nil {
		t.Fatal(err)
	}
	if len(delivered) != 3 {
		t.Fatalf("delivered count = %d, want 3", len(delivered))
	}
	dlq, err := h.state.ListDlq(context.Background(), "acme", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(dlq) != 0 {
		t.Fatalf("dlq = %+v, want empty", dlq)
	}

	// Deliveries are spaced by ~1s (the rate). 3 deliveries at 1/sec span ~2s.
	var ts []int64
	for _, c := range h.receiver.Calls {
		if c.URL == url {
			ts = append(ts, c.Ts)
		}
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
	if len(ts) != 3 {
		t.Fatalf("call count = %d, want 3", len(ts))
	}
	if span := ts[len(ts)-1] - ts[0]; span < 1_900 {
		t.Errorf("delivery span = %dms, want >= 1900ms (throttled to ~1/sec)", span)
	}

	// Each throttled attempt did NOT count as a delivery attempt (no wasted
	// attempts on the log): exactly one delivered attempt per message.
	for _, d := range delivered {
		if len(d.Attempts) != 1 {
			t.Errorf("message %s attempts = %d, want 1", d.Message.MessageID, len(d.Attempts))
			continue
		}
		if d.Attempts[0].Outcome != core.AttemptDelivered {
			t.Errorf("message %s attempt outcome = %v, want delivered", d.Message.MessageID, d.Attempts[0].Outcome)
		}
	}
}

// TestNoRateLimitNoThrottle mirrors the TS "no rateLimit -> no throttling
// (delivers immediately)" case: an endpoint with no RateLimit configured
// must deliver at the same tick it was sent.
func TestNoRateLimitNoThrottle(t *testing.T) {
	h := newHarness(t, 12)
	h.clock.Set(1_000)
	url := "https://fast.example.com/hook"
	h.receiver.On(url, anyhooktesting.ReceiverOK())
	h.createEndpoint(t, "acme", url, "*") // no rateLimit
	h.send(t, "acme", "e.t", `{}`)

	if _, err := h.transport.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.receiver.Calls) != 1 {
		t.Fatalf("call count = %d, want 1", len(h.receiver.Calls))
	}
	if got := h.receiver.Calls[0].Ts; got != 1_000 {
		t.Errorf("delivery ts = %d, want 1000 (delivered at t0, unthrottled)", got)
	}
}
