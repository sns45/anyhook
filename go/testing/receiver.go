package testing

import (
	"context"
	"sync"

	"github.com/sns45/anyhook/go/core"
)

// ScriptKind selects a MockReceiver behavior.
type ScriptKind int

const (
	ScriptOK ScriptKind = iota
	ScriptPermanent
	ScriptFailThenOK
	ScriptTimeout
	ScriptNetwork
	ScriptSlow
)

// Script is one scripted response for a routed URL.
type Script struct {
	Kind ScriptKind
	// Status is used by ScriptPermanent (an HTTP status code).
	Status int
	// N is used by ScriptFailThenOK: the number of 500s before succeeding.
	N int
	// Ms is used by ScriptSlow: the simulated response time.
	Ms int64
}

// ReceiverOK scripts an immediate 200.
func ReceiverOK() Script { return Script{Kind: ScriptOK} }

// ReceiverPermanent scripts a non-retryable status (default 404).
func ReceiverPermanent(status int) Script {
	if status == 0 {
		status = 404
	}
	return Script{Kind: ScriptPermanent, Status: status}
}

// ReceiverFailThenOK scripts n consecutive 500s, then 200.
func ReceiverFailThenOK(n int) Script { return Script{Kind: ScriptFailThenOK, N: n} }

// ReceiverTimeout scripts a timeout on every call.
func ReceiverTimeout() Script { return Script{Kind: ScriptTimeout} }

// ReceiverNetwork scripts a network failure on every call.
func ReceiverNetwork() Script { return Script{Kind: ScriptNetwork} }

// ReceiverSlow scripts a response that takes ms to arrive; it becomes a
// timeout if ms exceeds the caller's timeoutMs.
func ReceiverSlow(ms int64) Script { return Script{Kind: ScriptSlow, Ms: ms} }

// RecordedCall is one recorded MockReceiver.Post invocation.
type RecordedCall struct {
	URL     string
	Body    string
	Headers map[string]string
	Ts      int64
}

// MockReceiver is a deterministic HTTPClient shim. Route a URL to a Script
// with On (unrouted URLs use Default). ReceiverSlow(ms) returns a timeout iff
// ms > timeoutMs. Every call is recorded for assertions (headers/body/order/count).
type MockReceiver struct {
	Default Script
	Calls   []RecordedCall

	mu       sync.Mutex
	clock    core.Clock
	routes   map[string]Script
	counters map[string]int
}

// NewMockReceiver builds a MockReceiver whose Default script is ReceiverOK.
// clock may be nil (call timestamps then default to 0).
func NewMockReceiver(clock core.Clock) *MockReceiver {
	return &MockReceiver{
		Default:  ReceiverOK(),
		clock:    clock,
		routes:   map[string]Script{},
		counters: map[string]int{},
	}
}

// On routes url to script. Returns the receiver for chaining.
func (r *MockReceiver) On(url string, script Script) *MockReceiver {
	r.mu.Lock()
	r.routes[url] = script
	r.mu.Unlock()
	return r
}

// Post implements core.HTTPClient.
func (r *MockReceiver) Post(_ context.Context, url string, body string, headers map[string]string, timeoutMs int64) core.HTTPResult {
	r.mu.Lock()
	defer r.mu.Unlock()

	ts := int64(0)
	if r.clock != nil {
		ts = r.clock.Now()
	}
	r.Calls = append(r.Calls, RecordedCall{URL: url, Body: body, Headers: headers, Ts: ts})

	script, ok := r.routes[url]
	if !ok {
		script = r.Default
	}
	n := r.counters[url]
	r.counters[url] = n + 1

	switch script.Kind {
	case ScriptOK:
		return core.HTTPResult{Status: 200, Body: "ok"}
	case ScriptPermanent:
		return core.HTTPResult{Status: core.AttemptStatus(script.Status), Body: "rejected"}
	case ScriptFailThenOK:
		if n < script.N {
			return core.HTTPResult{Status: 500, Body: "err"}
		}
		return core.HTTPResult{Status: 200, Body: "ok"}
	case ScriptTimeout:
		return core.HTTPResult{Status: core.StatusTimeout}
	case ScriptNetwork:
		return core.HTTPResult{Status: core.StatusNetwork}
	case ScriptSlow:
		if script.Ms > timeoutMs {
			return core.HTTPResult{Status: core.StatusTimeout}
		}
		return core.HTTPResult{Status: 200, Body: "ok"}
	default:
		return core.HTTPResult{Status: core.StatusNetwork}
	}
}

// CallCount returns the total number of calls, or the count for url if given (non-empty).
func (r *MockReceiver) CallCount(url string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if url == "" {
		return len(r.Calls)
	}
	c := 0
	for _, call := range r.Calls {
		if call.URL == url {
			c++
		}
	}
	return c
}

var _ core.HTTPClient = (*MockReceiver)(nil)
