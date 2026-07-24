package core_test

import (
	"encoding/json"
	"testing"

	"github.com/sns45/anyhook/go/core"
)

func TestSubscribes(t *testing.T) {
	tests := []struct {
		name       string
		eventTypes []string
		eventType  string
		want       bool
	}{
		{"exact match", []string{"payment.succeeded"}, "payment.succeeded", true},
		{"exact mismatch", []string{"payment.succeeded"}, "payment.failed", false},
		{"star wildcard", []string{"*"}, "anything.at.all", true},
		{"prefix wildcard match", []string{"payment.*"}, "payment.succeeded", true},
		{"prefix wildcard no dot match", []string{"payment.*"}, "paymentsucceeded", false},
		{"prefix wildcard mismatch", []string{"payment.*"}, "invoice.paid", false},
		{"multiple patterns, one matches", []string{"a.b", "payment.*", "c.d"}, "payment.refunded", true},
		{"no patterns", []string{}, "payment.succeeded", false},
		{"exact equals the prefix itself not matched by dot-wildcard", []string{"payment.*"}, "payment", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ep := core.Endpoint{EventTypes: tc.eventTypes}
			if got := core.Subscribes(ep, tc.eventType); got != tc.want {
				t.Errorf("Subscribes(%v, %q) = %v, want %v", tc.eventTypes, tc.eventType, got, tc.want)
			}
		})
	}
}

func TestFanoutSkipsDisabledAndNonSubscribers(t *testing.T) {
	rng := constRng(0.5)
	event := core.SendEvent{Type: "payment.succeeded", Tenant: "t1", Payload: json.RawMessage(`{"x":1}`)}
	endpoints := []core.Endpoint{
		{EndpointID: "ep_a", EventTypes: []string{"payment.*"}, Disabled: false},
		{EndpointID: "ep_b", EventTypes: []string{"payment.succeeded"}, Disabled: true}, // disabled
		{EndpointID: "ep_c", EventTypes: []string{"invoice.*"}, Disabled: false},        // non-subscriber
		{EndpointID: "ep_d", EventTypes: []string{"*"}, Disabled: false},
	}

	messages := core.Fanout(event, "evt_1", endpoints, rng, 1000)
	if len(messages) != 2 {
		t.Fatalf("len(messages) = %d, want 2", len(messages))
	}
	ids := map[string]bool{}
	for _, m := range messages {
		ids[m.EndpointID] = true
		if m.Tenant != "t1" || m.EventID != "evt_1" || m.EventType != "payment.succeeded" {
			t.Errorf("message fields wrong: %+v", m)
		}
		if m.AttemptNo != 0 || m.Status != core.StatusPending || m.CreatedAt != 1000 {
			t.Errorf("message initial state wrong: %+v", m)
		}
		if m.MessageID == "" {
			t.Error("expected a non-empty MessageID")
		}
	}
	if !ids["ep_a"] || !ids["ep_d"] {
		t.Fatalf("expected ep_a and ep_d, got %v", ids)
	}
}

func TestFanoutZeroMatchesIsValid(t *testing.T) {
	rng := constRng(0.5)
	event := core.SendEvent{Type: "no.subscribers", Tenant: "t1", Payload: json.RawMessage(`{}`)}
	messages := core.Fanout(event, "evt_1", nil, rng, 0)
	if len(messages) != 0 {
		t.Fatalf("len(messages) = %d, want 0", len(messages))
	}
}

func TestFanoutMessagesAreIndependent(t *testing.T) {
	// G3: each fanned-out message gets its own MessageID (independent retry/circuit state key).
	rng := newLCGRng(7)
	event := core.SendEvent{Type: "x", Tenant: "t1", Payload: json.RawMessage(`{}`)}
	endpoints := []core.Endpoint{
		{EndpointID: "ep_a", EventTypes: []string{"*"}},
		{EndpointID: "ep_b", EventTypes: []string{"*"}},
	}
	messages := core.Fanout(event, "evt_1", endpoints, rng, 0)
	if len(messages) != 2 {
		t.Fatalf("len(messages) = %d, want 2", len(messages))
	}
	if messages[0].MessageID == messages[1].MessageID {
		t.Fatal("expected distinct MessageIDs per fanned-out message")
	}
}
