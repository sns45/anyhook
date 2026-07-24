package aws

import (
	"github.com/sns45/anyhook/go/core"
	"github.com/sns45/anyhook/go/signing"
)

// AdapterOptions configures NewAdapter/BuildEngine.
type AdapterOptions struct {
	// URLPolicy is applied by the HTTP client's pre-dispatch re-check.
	// nil -> core.DefaultURLPolicy(core.URLPolicyOptions{}). Mirrors TS
	// CreateAdapterOptions.urlPolicy.
	URLPolicy core.URLPolicy
	// Telemetry is an optional observability sink (§11) threaded into the
	// engine; nil -> core.NoopTelemetry. The current TS adapter.ts snapshot
	// does not yet forward a telemetry option through buildEngine -- this
	// Go port adds the wiring per the same zero-behavioral-drift default
	// (NoopTelemetry) established by the core engine backport.
	Telemetry core.Telemetry
}

// Adapter bundles the four AWS-backed engine ports plus the resolved Env
// they share. Mirrors TS AwsAdapter (adapter.ts).
type Adapter struct {
	Transport *SqsTransport
	State     *DynamoStateStore
	Scheduler *DynamoScheduler
	HTTP      core.HTTPClient
	Env       Env
}

// NewAdapter builds the four engine ports for the AWS runtime from an
// already-resolved Env (see ResolveEnv). Mirrors TS createAdapter.
func NewAdapter(env Env, opts AdapterOptions) *Adapter {
	urlPolicy := opts.URLPolicy
	if urlPolicy == nil {
		urlPolicy = core.DefaultURLPolicy(core.URLPolicyOptions{})
	}
	return &Adapter{
		Transport: NewSqsTransport(env),
		State:     NewDynamoStateStore(env),
		Scheduler: NewDynamoScheduler(env, nil),
		HTTP:      NewFetchHTTPClient(FetchHTTPClientOptions{URLPolicy: urlPolicy}),
		Env:       env,
	}
}

// BuildEngine builds a ready-to-use core.Engine wired to the AWS adapter
// (used by every Lambda handler factory in handlers.go). Mirrors TS
// buildEngine.
func BuildEngine(env Env, opts AdapterOptions) (*core.Engine, *Adapter) {
	adapter := NewAdapter(env, opts)
	engine := core.NewEngine(core.EngineOptions{
		Transport:       adapter.Transport,
		State:           adapter.State,
		Scheduler:       adapter.Scheduler,
		HTTP:            adapter.HTTP,
		Signer:          signing.CoreSigner{},
		Telemetry:       opts.Telemetry, // nil -> core.NewEngine defaults to core.NoopTelemetry
		MaxPayloadBytes: MaxPayloadBytes,
	})
	return engine, adapter
}
