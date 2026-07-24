package core_test

import (
	"encoding/json"
	"regexp"
	"testing"

	"github.com/sns45/anyhook/go/core"
)

var idPattern = regexp.MustCompile(`^msg_[a-z0-9]{20}$`)

func TestNewIDFormat(t *testing.T) {
	rng := &sequenceRng{vals: []float64{0.01, 0.11, 0.21, 0.31, 0.41, 0.51, 0.61, 0.71, 0.81, 0.91, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95}}
	id := core.NewID("msg", rng)
	if !idPattern.MatchString(id) {
		t.Fatalf("NewID output %q does not match %s", id, idPattern.String())
	}
}

func TestNewIDDeterministicUnderSameRng(t *testing.T) {
	seq := func() core.Rng {
		return &sequenceRng{vals: []float64{0.01, 0.11, 0.21, 0.31, 0.41, 0.51, 0.61, 0.71, 0.81, 0.91, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95}}
	}
	a := core.NewID("evt", seq())
	b := core.NewID("evt", seq())
	if a != b {
		t.Fatalf("NewID not deterministic for identical Rng sequence: %q vs %q", a, b)
	}
}

func TestDeriveIdempotencyKeyStableAndDistinct(t *testing.T) {
	e1 := core.SendEvent{Tenant: "t1", Type: "payment.succeeded", Payload: json.RawMessage(`{"a":1}`)}
	e2 := core.SendEvent{Tenant: "t1", Type: "payment.succeeded", Payload: json.RawMessage(`{"a":1}`)}
	e3 := core.SendEvent{Tenant: "t1", Type: "payment.succeeded", Payload: json.RawMessage(`{"a":2}`)}
	e4 := core.SendEvent{Tenant: "t2", Type: "payment.succeeded", Payload: json.RawMessage(`{"a":1}`)}
	e5 := core.SendEvent{Tenant: "t1", Type: "payment.failed", Payload: json.RawMessage(`{"a":1}`)}

	k1 := core.DeriveIdempotencyKey(e1)
	k2 := core.DeriveIdempotencyKey(e2)
	if k1 != k2 {
		t.Fatalf("same (tenant,type,payload) produced different keys: %q vs %q", k1, k2)
	}
	if !regexp.MustCompile(`^idem_[a-f0-9]{32}$`).MatchString(k1) {
		t.Fatalf("key format wrong: %q", k1)
	}

	for name, e := range map[string]core.SendEvent{"different payload": e3, "different tenant": e4, "different type": e5} {
		if k := core.DeriveIdempotencyKey(e); k == k1 {
			t.Errorf("%s: expected a different key, got the same %q", name, k)
		}
	}
}
