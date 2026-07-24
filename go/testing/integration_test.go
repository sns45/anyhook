package testing_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/sns45/anyhook/go/core"
	"github.com/sns45/anyhook/go/signing"
	anyhooktesting "github.com/sns45/anyhook/go/testing"
)

// newHarness builds a fully-wired in-memory Engine + its testing-package
// backing ports, for integration-style tests that drive real delivery/retry/
// circuit/DLQ behavior end-to-end.
type harness struct {
	engine    *core.Engine
	transport *anyhooktesting.MemoryTransport
	state     *anyhooktesting.MemoryStateStore
	scheduler *anyhooktesting.MemoryScheduler
	clock     *anyhooktesting.TestClock
	receiver  *anyhooktesting.MockReceiver
}

func newHarness(t *testing.T, seed uint32) *harness {
	t.Helper()
	clock := anyhooktesting.NewTestClock(0)
	transport := anyhooktesting.NewMemoryTransport()
	scheduler := anyhooktesting.NewMemoryScheduler(transport, clock)
	state := anyhooktesting.NewMemoryStateStore(clock)
	receiver := anyhooktesting.NewMockReceiver(clock)

	engine := core.NewEngine(core.EngineOptions{
		Transport: transport,
		State:     state,
		Scheduler: scheduler,
		HTTP:      receiver,
		Signer:    signing.CoreSigner{},
		Clock:     clock,
		Rng:       anyhooktesting.SeededRng(seed),
	})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("engine.Start: %v", err)
	}
	return &harness{engine: engine, transport: transport, state: state, scheduler: scheduler, clock: clock, receiver: receiver}
}

func (h *harness) run(t *testing.T) {
	t.Helper()
	if err := anyhooktesting.RunDeliveries(context.Background(), anyhooktesting.RunOptions{
		Transport: h.transport, Scheduler: h.scheduler, Clock: h.clock,
	}); err != nil {
		t.Fatalf("RunDeliveries: %v", err)
	}
}

func (h *harness) createEndpoint(t *testing.T, tenant, url string, eventTypes ...string) core.Endpoint {
	t.Helper()
	res, err := h.state.CreateEndpoint(context.Background(), core.CreateEndpointInput{
		Tenant: tenant, URL: url, EventTypes: eventTypes,
	})
	if err != nil {
		t.Fatalf("CreateEndpoint: %v", err)
	}
	return res.Endpoint
}

func (h *harness) send(t *testing.T, tenant, eventType, payload string) core.Receipt {
	t.Helper()
	receipt, err := h.engine.Send(context.Background(), core.SendEvent{
		Tenant: tenant, Type: eventType, Payload: json.RawMessage(payload),
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	return receipt
}

// ---- Message-level isolation (G3) ----

// TestMessageIsolationHealthyVsDeadEndpoint fans one event out to a healthy
// endpoint and a permanently-failing endpoint. The healthy endpoint must
// deliver exactly once, completely unaffected by the other endpoint's
// failure; the dead endpoint must independently land in the DLQ. Each
// message's retry/circuit state is a per-(tenant,endpoint) key, so one
// message's failure can never leak into another's outcome.
func TestMessageIsolationHealthyVsDeadEndpoint(t *testing.T) {
	h := newHarness(t, 42)
	healthyEP := h.createEndpoint(t, "acme", "https://good.example.com/hook", "order.*")
	deadEP := h.createEndpoint(t, "acme", "https://bad.example.com/hook", "order.*")

	h.receiver.On(healthyEP.URL, anyhooktesting.ReceiverOK())
	h.receiver.On(deadEP.URL, anyhooktesting.ReceiverPermanent(404))

	receipt := h.send(t, "acme", "order.created", `{"id":1}`)
	if receipt.MessageCount != 2 {
		t.Fatalf("MessageCount = %d, want 2", receipt.MessageCount)
	}

	h.run(t)

	if got := h.receiver.CallCount(healthyEP.URL); got != 1 {
		t.Errorf("healthy endpoint call count = %d, want 1", got)
	}
	if got := h.receiver.CallCount(deadEP.URL); got != 1 {
		t.Errorf("dead endpoint call count = %d, want 1 (permanent 4xx, no retry)", got)
	}

	deliveries, err := h.state.ListDeliveries(context.Background(), core.DeliveryQuery{Tenant: "acme"})
	if err != nil {
		t.Fatal(err)
	}
	var healthyStatus, deadStatus core.MessageStatus
	for _, d := range deliveries {
		switch d.Message.EndpointID {
		case healthyEP.EndpointID:
			healthyStatus = d.Message.Status
		case deadEP.EndpointID:
			deadStatus = d.Message.Status
		}
	}
	if healthyStatus != core.StatusDelivered {
		t.Errorf("healthy message status = %v, want delivered", healthyStatus)
	}
	if deadStatus != core.StatusDead {
		t.Errorf("dead message status = %v, want dead", deadStatus)
	}

	dlq, err := h.state.ListDlq(context.Background(), "acme", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(dlq) != 1 || dlq[0].Message.EndpointID != deadEP.EndpointID || dlq[0].Reason != core.ReasonPermanent4xx {
		t.Fatalf("DLQ = %+v, want exactly one permanent_4xx entry for the dead endpoint", dlq)
	}

	// The healthy endpoint's circuit must never have recorded a failure.
	healthyCircuit, err := h.state.GetCircuit(context.Background(), "acme", healthyEP.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if healthyCircuit.State != core.CircuitClosed || healthyCircuit.ConsecutiveFailures != 0 {
		t.Errorf("healthy endpoint circuit = %+v, want closed/0 (unaffected by dead endpoint)", healthyCircuit)
	}
}

// ---- MockReceiver matrix (see packages/testing script kinds) ----

func TestMockReceiverMatrix(t *testing.T) {
	t.Run("ok delivers on the first attempt", func(t *testing.T) {
		h := newHarness(t, 1)
		ep := h.createEndpoint(t, "t1", "https://ok.example.com/hook", "*")
		h.receiver.On(ep.URL, anyhooktesting.ReceiverOK())
		h.send(t, "t1", "e", `{}`)
		h.run(t)

		if got := h.receiver.CallCount(ep.URL); got != 1 {
			t.Errorf("call count = %d, want 1", got)
		}
		rows, _ := h.state.ListDeliveries(context.Background(), core.DeliveryQuery{Tenant: "t1"})
		if len(rows) != 1 || rows[0].Message.Status != core.StatusDelivered {
			t.Fatalf("rows = %+v, want one delivered message", rows)
		}
	})

	t.Run("failThenOk(1) delivers on the second attempt", func(t *testing.T) {
		h := newHarness(t, 2)
		ep := h.createEndpoint(t, "t1", "https://flaky.example.com/hook", "*")
		h.receiver.On(ep.URL, anyhooktesting.ReceiverFailThenOK(1))
		h.send(t, "t1", "e", `{}`)
		h.run(t)

		if got := h.receiver.CallCount(ep.URL); got != 2 {
			t.Errorf("call count = %d, want 2", got)
		}
		rows, _ := h.state.ListDeliveries(context.Background(), core.DeliveryQuery{Tenant: "t1"})
		if len(rows) != 1 || rows[0].Message.Status != core.StatusDelivered {
			t.Fatalf("rows = %+v, want one delivered message", rows)
		}
		if len(rows[0].Attempts) != 2 {
			t.Fatalf("attempts = %d, want 2 (one retried, one delivered)", len(rows[0].Attempts))
		}
	})

	t.Run("permanent(404) dead-letters as permanent_4xx after one attempt", func(t *testing.T) {
		h := newHarness(t, 3)
		ep := h.createEndpoint(t, "t1", "https://gone.example.com/hook", "*")
		h.receiver.On(ep.URL, anyhooktesting.ReceiverPermanent(404))
		h.send(t, "t1", "e", `{}`)
		h.run(t)

		if got := h.receiver.CallCount(ep.URL); got != 1 {
			t.Errorf("call count = %d, want 1", got)
		}
		dlq, _ := h.state.ListDlq(context.Background(), "t1", "")
		if len(dlq) != 1 || dlq[0].Reason != core.ReasonPermanent4xx {
			t.Fatalf("dlq = %+v, want one permanent_4xx entry", dlq)
		}
	})

	t.Run("timeout dead-letters as exhausted_retries after the full schedule", func(t *testing.T) {
		h := newHarness(t, 4)
		ep := h.createEndpoint(t, "t1", "https://timeout.example.com/hook", "*")
		h.receiver.On(ep.URL, anyhooktesting.ReceiverTimeout())
		h.send(t, "t1", "e", `{}`)
		h.run(t)

		// One initial delivery attempt (attemptNo=0) plus one retry per
		// schedule slot: attemptNo 0..len(schedule)-1 each still have a valid
		// slot and so schedule a further retry; the attempt at
		// attemptNo=len(schedule) then finds the schedule exhausted and DLQs.
		wantAttempts := len(core.DefaultScheduleMs) + 1
		if got := h.receiver.CallCount(ep.URL); got != wantAttempts {
			t.Errorf("call count = %d, want %d (initial attempt + one per schedule slot)", got, wantAttempts)
		}
		dlq, _ := h.state.ListDlq(context.Background(), "t1", "")
		if len(dlq) != 1 || dlq[0].Reason != core.ReasonExhaustedRetries {
			t.Fatalf("dlq = %+v, want one exhausted_retries entry", dlq)
		}
	})
}

// ---- Cross-tenant no-leak (G7) ----

func TestCrossTenantNoLeak(t *testing.T) {
	h := newHarness(t, 99)
	epA := h.createEndpoint(t, "tenant-a", "https://a.example.com/hook", "*")
	epB := h.createEndpoint(t, "tenant-b", "https://b.example.com/hook", "*")
	h.receiver.On(epA.URL, anyhooktesting.ReceiverOK())
	h.receiver.On(epB.URL, anyhooktesting.ReceiverPermanent(400))

	h.send(t, "tenant-a", "e", `{"who":"a"}`)
	h.send(t, "tenant-b", "e", `{"who":"b"}`)
	h.run(t)

	// tenant-a must not see tenant-b's endpoint, messages, or DLQ entries.
	aEndpoints, err := h.state.ListEndpoints(context.Background(), "tenant-a")
	if err != nil {
		t.Fatal(err)
	}
	for _, ep := range aEndpoints {
		if ep.EndpointID == epB.EndpointID {
			t.Fatal("tenant-a can see tenant-b's endpoint")
		}
	}
	if ep, err := h.state.GetEndpoint(context.Background(), "tenant-a", epB.EndpointID); err != nil || ep != nil {
		t.Fatalf("GetEndpoint(tenant-a, epB) = (%v, %v), want (nil, nil)", ep, err)
	}

	aDeliveries, err := h.state.ListDeliveries(context.Background(), core.DeliveryQuery{Tenant: "tenant-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(aDeliveries) != 1 || aDeliveries[0].Message.EndpointID != epA.EndpointID {
		t.Fatalf("tenant-a deliveries = %+v, want exactly its own message", aDeliveries)
	}

	aDlq, err := h.state.ListDlq(context.Background(), "tenant-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(aDlq) != 0 {
		t.Fatalf("tenant-a DLQ = %+v, want empty (tenant-b's failure must not leak in)", aDlq)
	}

	bDlq, err := h.state.ListDlq(context.Background(), "tenant-b", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(bDlq) != 1 || bDlq[0].Message.EndpointID != epB.EndpointID {
		t.Fatalf("tenant-b DLQ = %+v, want exactly its own dead message", bDlq)
	}

	// A message id lookup under the wrong tenant must resolve to nil, not the other tenant's row.
	bMessage := aDeliveries[0].Message // reuse a real message id, but query under tenant-b
	if m, err := h.state.GetMessage(context.Background(), "tenant-b", bMessage.MessageID); err != nil || m != nil {
		t.Fatalf("GetMessage(tenant-b, tenant-a's messageId) = (%v, %v), want (nil, nil)", m, err)
	}
}

// TestSendIdempotentReplay covers the idempotency-key replay path used by Send.
func TestSendIdempotentReplay(t *testing.T) {
	h := newHarness(t, 5)
	ep := h.createEndpoint(t, "t1", "https://ok.example.com/hook", "*")
	h.receiver.On(ep.URL, anyhooktesting.ReceiverOK())

	first, err := h.engine.Send(context.Background(), core.SendEvent{
		Tenant: "t1", Type: "e", Payload: json.RawMessage(`{"x":1}`), IdempotencyKey: "fixed-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.engine.Send(context.Background(), core.SendEvent{
		Tenant: "t1", Type: "e", Payload: json.RawMessage(`{"x":1}`), IdempotencyKey: "fixed-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.EventID != second.EventID {
		t.Errorf("replayed send got a different EventID: %q vs %q", first.EventID, second.EventID)
	}
	if second.MessageCount != first.MessageCount {
		t.Errorf("replayed send MessageCount = %d, want %d", second.MessageCount, first.MessageCount)
	}

	h.run(t)
	// Only ONE delivery attempt total: the idempotent replay must not re-fan-out.
	if got := h.receiver.CallCount(ep.URL); got != 1 {
		t.Errorf("call count after idempotent replay = %d, want 1 (no double fan-out)", got)
	}
}

// TestEndpointGoneDeadLetters covers ProcessMessage's endpoint_gone DLQ path:
// a message enqueued for an endpoint that is later deleted must dead-letter,
// not retry forever.
func TestEndpointGoneDeadLetters(t *testing.T) {
	h := newHarness(t, 6)
	ep := h.createEndpoint(t, "t1", "https://ok.example.com/hook", "*")
	h.receiver.On(ep.URL, anyhooktesting.ReceiverOK())

	// Enqueue a message directly (bypassing Send) referencing an endpoint id
	// that does not exist, simulating "deleted after enqueue".
	msg := core.Message{
		MessageID: "msg_gone", Tenant: "t1", EndpointID: "ep_does_not_exist",
		EventID: "evt_1", EventType: "e", Payload: json.RawMessage(`{}`),
		Status: core.StatusPending, CreatedAt: 0,
	}
	if err := h.state.PutMessage(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	if err := h.transport.Send(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	h.run(t)

	dlq, err := h.state.ListDlq(context.Background(), "t1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(dlq) != 1 || dlq[0].Reason != core.ReasonEndpointGone {
		t.Fatalf("dlq = %+v, want one endpoint_gone entry", dlq)
	}
}

// TestSSRFBlockedEndpointDeadLetters covers the DeliverOnce -> ProcessMessage
// SSRF path: a message targeting a private-IP endpoint must dead-letter as
// blocked_ssrf without ever reaching the HTTP client.
func TestSSRFBlockedEndpointDeadLetters(t *testing.T) {
	h := newHarness(t, 7)
	ep := h.createEndpoint(t, "t1", "http://169.254.169.254/latest/meta-data", "*")

	h.send(t, "t1", "e", `{}`)
	h.run(t)

	if got := h.receiver.CallCount(""); got != 0 {
		t.Errorf("HTTP call count = %d, want 0 (SSRF should block before any POST)", got)
	}
	dlq, err := h.state.ListDlq(context.Background(), "t1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(dlq) != 1 || dlq[0].Reason != core.ReasonBlockedSSRF {
		t.Fatalf("dlq = %+v, want one blocked_ssrf entry", dlq)
	}
	_ = ep
}
