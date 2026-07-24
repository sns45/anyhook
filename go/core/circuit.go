package core

// DefaultFailureThreshold: open the circuit after 5 consecutive failed messages.
const DefaultFailureThreshold = 5

// DefaultCooldownMs is the default circuit-breaker cooldown before an open
// circuit transitions to half-open.
const DefaultCooldownMs int64 = 30_000

// InitialCircuit returns a fresh, closed circuit with the given cooldown.
func InitialCircuit(cooldownMs int64) CircuitRecord {
	return CircuitRecord{State: CircuitClosed, ConsecutiveFailures: 0, CooldownMs: cooldownMs}
}

// OnFailure applies a delivery failure. A failure in half-open re-opens
// immediately and resets the cooldown clock. Otherwise it increments the
// consecutive-failure count and opens once it reaches threshold.
func OnFailure(rec CircuitRecord, now int64, threshold int) CircuitRecord {
	if rec.State == CircuitHalfOpen {
		openedAt := now
		return CircuitRecord{
			State: CircuitOpen, ConsecutiveFailures: rec.ConsecutiveFailures + 1,
			OpenedAt: &openedAt, CooldownMs: rec.CooldownMs,
		}
	}
	consecutiveFailures := rec.ConsecutiveFailures + 1
	if consecutiveFailures >= threshold {
		openedAt := now
		return CircuitRecord{
			State: CircuitOpen, ConsecutiveFailures: consecutiveFailures,
			OpenedAt: &openedAt, CooldownMs: rec.CooldownMs,
		}
	}
	return CircuitRecord{State: CircuitClosed, ConsecutiveFailures: consecutiveFailures, OpenedAt: nil, CooldownMs: rec.CooldownMs}
}

// OnSuccess applies a delivery success: reset to closed.
func OnSuccess(rec CircuitRecord) CircuitRecord {
	return CircuitRecord{State: CircuitClosed, ConsecutiveFailures: 0, OpenedAt: nil, CooldownMs: rec.CooldownMs}
}

// ToHalfOpen transitions an open circuit whose cooldown elapsed into half-open.
func ToHalfOpen(rec CircuitRecord) CircuitRecord {
	rec.State = CircuitHalfOpen
	return rec
}

// CircuitGate is the result of CanAttempt.
type CircuitGate struct {
	Allow bool
	Probe bool
}

// CanAttempt reports whether a delivery may be attempted now:
//
//   - closed    -> allowed (not a probe)
//   - open      -> allowed only once the cooldown elapsed, as a single probe
//     (caller then calls ToHalfOpen)
//   - half-open -> allowed as the single probe
func CanAttempt(rec CircuitRecord, now int64) CircuitGate {
	switch rec.State {
	case CircuitClosed:
		return CircuitGate{Allow: true, Probe: false}
	case CircuitHalfOpen:
		return CircuitGate{Allow: true, Probe: true}
	default: // open
		openedAt := int64(0)
		if rec.OpenedAt != nil {
			openedAt = *rec.OpenedAt
		}
		elapsed := now - openedAt
		if elapsed >= rec.CooldownMs {
			return CircuitGate{Allow: true, Probe: true}
		}
		return CircuitGate{Allow: false, Probe: false}
	}
}
