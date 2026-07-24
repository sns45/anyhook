package core_test

import (
	"testing"

	"github.com/sns45/anyhook/go/core"
)

func TestCircuitStateMachine(t *testing.T) {
	rec := core.InitialCircuit(core.DefaultCooldownMs)
	if rec.State != core.CircuitClosed || rec.ConsecutiveFailures != 0 {
		t.Fatalf("InitialCircuit = %+v, want closed/0", rec)
	}

	// Fail below threshold: stays closed.
	now := int64(0)
	for i := 0; i < core.DefaultFailureThreshold-1; i++ {
		rec = core.OnFailure(rec, now, core.DefaultFailureThreshold)
		if rec.State != core.CircuitClosed {
			t.Fatalf("after %d failures, state = %v, want closed", i+1, rec.State)
		}
	}
	if rec.ConsecutiveFailures != core.DefaultFailureThreshold-1 {
		t.Fatalf("ConsecutiveFailures = %d, want %d", rec.ConsecutiveFailures, core.DefaultFailureThreshold-1)
	}

	// One more failure reaches the threshold: opens.
	rec = core.OnFailure(rec, now, core.DefaultFailureThreshold)
	if rec.State != core.CircuitOpen {
		t.Fatalf("state = %v, want open", rec.State)
	}
	if rec.OpenedAt == nil || *rec.OpenedAt != now {
		t.Fatalf("OpenedAt = %v, want %d", rec.OpenedAt, now)
	}

	// Not attemptable before cooldown elapses.
	gate := core.CanAttempt(rec, now+rec.CooldownMs-1)
	if gate.Allow {
		t.Fatal("expected Allow=false before cooldown elapses")
	}

	// Attemptable (as a probe) once cooldown elapses.
	gate = core.CanAttempt(rec, now+rec.CooldownMs)
	if !gate.Allow || !gate.Probe {
		t.Fatalf("CanAttempt after cooldown = %+v, want {true true}", gate)
	}

	// Transition to half-open; CanAttempt is a probe there too.
	rec = core.ToHalfOpen(rec)
	if rec.State != core.CircuitHalfOpen {
		t.Fatalf("state = %v, want half-open", rec.State)
	}
	gate = core.CanAttempt(rec, now)
	if !gate.Allow || !gate.Probe {
		t.Fatalf("CanAttempt in half-open = %+v, want {true true}", gate)
	}

	// A failure while half-open re-opens immediately, resetting the cooldown clock.
	reopenAt := now + 1000
	rec = core.OnFailure(rec, reopenAt, core.DefaultFailureThreshold)
	if rec.State != core.CircuitOpen {
		t.Fatalf("state after half-open failure = %v, want open", rec.State)
	}
	if rec.OpenedAt == nil || *rec.OpenedAt != reopenAt {
		t.Fatalf("OpenedAt after half-open failure = %v, want %d", rec.OpenedAt, reopenAt)
	}

	// Success resets to closed with zero consecutive failures.
	rec = core.OnSuccess(rec)
	if rec.State != core.CircuitClosed || rec.ConsecutiveFailures != 0 || rec.OpenedAt != nil {
		t.Fatalf("OnSuccess result = %+v, want closed/0/nil", rec)
	}
	gate = core.CanAttempt(rec, now)
	if !gate.Allow || gate.Probe {
		t.Fatalf("CanAttempt when closed = %+v, want {true false}", gate)
	}
}

func TestCircuitClosedAlwaysAllowsNotAsProbe(t *testing.T) {
	rec := core.InitialCircuit(core.DefaultCooldownMs)
	gate := core.CanAttempt(rec, 12345)
	if !gate.Allow || gate.Probe {
		t.Fatalf("CanAttempt on fresh closed circuit = %+v, want {true false}", gate)
	}
}
