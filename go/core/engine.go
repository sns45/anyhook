package core

import (
	"context"
	"errors"
	"fmt"
)

// DefaultMaxPayloadBytes caps the JSON-encoded event payload size.
const DefaultMaxPayloadBytes int64 = 256 * 1024

// DefaultTimeoutMs is the default per-delivery HTTP timeout.
const DefaultTimeoutMs int64 = 15_000

// realClock is used when EngineOptions.Clock is nil.
type realClock struct{}

func (realClock) Now() int64 { return nowMs() }

// EngineOptions configures a new Engine.
type EngineOptions struct {
	Transport Transport
	State     StateStore
	Scheduler Scheduler
	HTTP      HTTPClient
	// Signer is injected so package core stays zero-runtime-dep (G1); build
	// one from package signing's CoreSigner.
	Signer          WebhookSigner
	URLPolicy       URLPolicy // nil -> DefaultURLPolicy(URLPolicyOptions{})
	Clock           Clock     // nil -> wall clock
	Rng             Rng       // nil -> math/rand-backed
	Retry           *RetryConfig
	Circuit         *CircuitConfig
	MaxPayloadBytes int64 // 0 -> DefaultMaxPayloadBytes
	TimeoutMs       int64 // 0 -> DefaultTimeoutMs
}

// Engine is the runtime-agnostic webhook delivery engine. Producers call
// Send; the engine fans out, signs, delivers, retries with jittered backoff,
// circuit-breaks dead endpoints, and dead-letters exhausted messages. All
// durable state lives behind the injected ports (G1/G2).
type Engine struct {
	transport       Transport
	state           StateStore
	scheduler       Scheduler
	clock           Clock
	rng             Rng
	retry           RetryConfig
	circuitCfg      CircuitConfig
	maxPayloadBytes int64
	deliverPorts    DeliverPorts
}

// NewEngine builds an Engine from EngineOptions, applying defaults for every
// unset optional field.
func NewEngine(opts EngineOptions) *Engine {
	clock := opts.Clock
	if clock == nil {
		clock = realClock{}
	}
	rng := opts.Rng
	if rng == nil {
		rng = defaultRng{}
	}
	retry := DefaultRetryConfig
	if opts.Retry != nil {
		retry = RetryConfig{ScheduleMs: opts.Retry.ScheduleMs}
		if retry.ScheduleMs == nil {
			retry.ScheduleMs = DefaultScheduleMs
		}
	}
	circuitCfg := CircuitConfig{FailureThreshold: DefaultFailureThreshold, CooldownMs: DefaultCooldownMs}
	if opts.Circuit != nil {
		if opts.Circuit.FailureThreshold > 0 {
			circuitCfg.FailureThreshold = opts.Circuit.FailureThreshold
		}
		if opts.Circuit.CooldownMs > 0 {
			circuitCfg.CooldownMs = opts.Circuit.CooldownMs
		}
	}
	maxPayloadBytes := opts.MaxPayloadBytes
	if maxPayloadBytes <= 0 {
		maxPayloadBytes = DefaultMaxPayloadBytes
	}
	timeoutMs := opts.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = DefaultTimeoutMs
	}
	urlPolicy := opts.URLPolicy
	if urlPolicy == nil {
		urlPolicy = DefaultURLPolicy(URLPolicyOptions{})
	}

	return &Engine{
		transport:       opts.Transport,
		state:           opts.State,
		scheduler:       opts.Scheduler,
		clock:           clock,
		rng:             rng,
		retry:           retry,
		circuitCfg:      circuitCfg,
		maxPayloadBytes: maxPayloadBytes,
		deliverPorts: DeliverPorts{
			HTTP: opts.HTTP, Signer: opts.Signer, URLPolicy: urlPolicy, Clock: clock, TimeoutMs: timeoutMs,
		},
	}
}

// Start registers the delivery handler with the transport (call once at worker startup).
func (e *Engine) Start(ctx context.Context) error {
	return e.transport.Subscribe(ctx, e.ProcessMessage)
}

// Send durably accepts an event and returns at acceptance -- NEVER blocks on
// delivery (G5). Records idempotency, fans out to matching endpoints, and
// enqueues one message each.
func (e *Engine) Send(ctx context.Context, event SendEvent) (Receipt, error) {
	if event.Type == "" {
		return Receipt{}, errors.New("send: event.type is required")
	}
	if event.Tenant == "" {
		return Receipt{}, errors.New("send: event.tenant is required")
	}
	if int64(len(event.Payload)) > e.maxPayloadBytes {
		return Receipt{}, fmt.Errorf("send: payload exceeds maxPayloadBytes (%d)", e.maxPayloadBytes)
	}

	idemKey := event.IdempotencyKey
	if idemKey == "" {
		idemKey = DeriveIdempotencyKey(event)
	}
	eventID := NewID("evt", e.rng)
	rec, err := e.state.RecordEvent(ctx, event.Tenant, eventID, idemKey)
	if err != nil {
		return Receipt{}, err
	}
	if !rec.IsNew {
		// Idempotent replay: return the original receipt without re-fanning-out.
		// NOTE: MessageCount reflects the value at FinalizeEvent time. A duplicate
		// that races the ORIGINAL send (before it finalizes) may observe 0.
		// Correct enforcement of "exactly-once acceptance under concurrency/crash"
		// is the state adapter's job.
		return Receipt{EventID: rec.EventID, Accepted: true, MessageCount: rec.MessageCount}, nil
	}

	endpoints, err := e.state.MatchEndpoints(ctx, event.Tenant, event.Type)
	if err != nil {
		return Receipt{}, err
	}
	messages := Fanout(event, eventID, endpoints, e.rng, e.clock.Now())
	for _, m := range messages {
		if err := e.state.PutMessage(ctx, m); err != nil {
			return Receipt{}, err
		}
		if err := e.transport.Send(ctx, m); err != nil {
			return Receipt{}, err
		}
	}
	if err := e.state.FinalizeEvent(ctx, event.Tenant, idemKey, eventID, len(messages)); err != nil {
		return Receipt{}, err
	}
	return Receipt{EventID: eventID, Accepted: true, MessageCount: len(messages)}, nil
}

// ProcessMessage delivers one message once, then advances its independent
// retry/circuit/DLQ state. Called by the transport subscription (a worker) --
// one message can never affect another (G3).
func (e *Engine) ProcessMessage(ctx context.Context, m Message) error {
	endpoint, err := e.state.GetEndpoint(ctx, m.Tenant, m.EndpointID)
	if err != nil {
		return err
	}
	if endpoint == nil || endpoint.Disabled {
		// Endpoint deleted/disabled after enqueue: dead-letter so it is visible,
		// don't retry forever. Append a terminal attempt for delivery-log
		// consistency with every other DLQ path.
		goneAttempt := Attempt{
			MessageID: m.MessageID, EndpointID: m.EndpointID, Tenant: m.Tenant, EventType: m.EventType,
			AttemptNo: m.AttemptNo, Status: StatusNetwork, LatencyMs: 0, RespSnippet: "endpoint_gone",
			Ts: e.clock.Now(), Outcome: AttemptDead,
		}
		return e.dlq(ctx, m, goneAttempt, ReasonEndpointGone)
	}

	// Circuit gate (normalize cooldown to engine config).
	circuit, err := e.state.GetCircuit(ctx, m.Tenant, m.EndpointID)
	if err != nil {
		return err
	}
	circuit.CooldownMs = e.circuitCfg.CooldownMs
	gate := CanAttempt(circuit, e.clock.Now())
	if !gate.Allow {
		// Circuit open within cooldown: park as blocked (NOT an attempt) and
		// re-probe after cooldown. Jitter the wake time so a backlog of parked
		// messages doesn't stampede the moment cooldown ends.
		blocked := m
		blocked.Status = StatusBlocked
		if err := e.state.PutMessage(ctx, blocked); err != nil {
			return err
		}
		openedAt := e.clock.Now()
		if circuit.OpenedAt != nil {
			openedAt = *circuit.OpenedAt
		}
		base := openedAt + circuit.CooldownMs
		probeAt := base + FullJitter(circuit.CooldownMs, e.rng)
		return e.scheduler.ScheduleRetry(ctx, m, probeAt)
	}
	if gate.Probe {
		circuit = ToHalfOpen(circuit)
		if err := e.state.PutCircuit(ctx, m.Tenant, m.EndpointID, circuit); err != nil {
			return err
		}
	}

	delivering := m
	delivering.Status = StatusDelivering
	if err := e.state.PutMessage(ctx, delivering); err != nil {
		return err
	}
	result := DeliverOnce(ctx, m, *endpoint, e.deliverPorts)

	attempt := Attempt{
		MessageID: m.MessageID, EndpointID: m.EndpointID, Tenant: m.Tenant, EventType: m.EventType,
		AttemptNo: m.AttemptNo, Status: result.Status, LatencyMs: result.LatencyMs, RespSnippet: result.RespSnippet,
		Ts: e.clock.Now(), Outcome: AttemptRetried,
	}

	if result.Outcome == OutcomeDelivered {
		if err := e.state.PutCircuit(ctx, m.Tenant, m.EndpointID, OnSuccess(circuit)); err != nil {
			return err
		}
		delivered := m
		delivered.Status = StatusDelivered
		if err := e.state.PutMessage(ctx, delivered); err != nil {
			return err
		}
		attempt.Outcome = AttemptDelivered
		return e.state.AppendAttempt(ctx, attempt)
	}

	if result.Outcome == OutcomePermanent {
		// 4xx (except 429) or SSRF refusal -> straight to DLQ, no retry.
		if err := e.state.PutCircuit(ctx, m.Tenant, m.EndpointID, OnFailure(circuit, e.clock.Now(), e.circuitCfg.FailureThreshold)); err != nil {
			return err
		}
		reason := ReasonPermanent4xx
		if result.BlockedBySSRF {
			reason = ReasonBlockedSSRF
		}
		return e.dlq(ctx, m, attempt, reason)
	}

	// retryable: 429 / 5xx / timeout / network
	circuit = OnFailure(circuit, e.clock.Now(), e.circuitCfg.FailureThreshold)
	if err := e.state.PutCircuit(ctx, m.Tenant, m.EndpointID, circuit); err != nil {
		return err
	}

	delay, ok := NextDelayMs(e.retry, m.AttemptNo, e.rng, result.RetryAfterMs)
	if !ok {
		return e.dlq(ctx, m, attempt, ReasonExhaustedRetries)
	}

	if err := e.state.AppendAttempt(ctx, attempt); err != nil { // outcome AttemptRetried
		return err
	}
	at := e.clock.Now() + delay
	next := m
	next.AttemptNo = m.AttemptNo + 1
	next.Status = StatusRetrying
	next.NextAttemptAt = &at
	if err := e.state.PutMessage(ctx, next); err != nil {
		return err
	}
	return e.scheduler.ScheduleRetry(ctx, next, at)
}

func (e *Engine) dlq(ctx context.Context, m Message, attempt Attempt, reason DlqReason) error {
	dead := m
	dead.Status = StatusDead
	if err := e.state.PutMessage(ctx, dead); err != nil {
		return err
	}
	attempt.Outcome = AttemptDead
	if err := e.state.AppendAttempt(ctx, attempt); err != nil {
		return err
	}
	return e.state.AddToDlq(ctx, m, reason)
}
