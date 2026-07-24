/*
Package testing provides in-memory port implementations and deterministic
test helpers for exercising the anyhook core Engine without real
infrastructure: a controllable Clock, a seeded Rng, an in-memory Transport /
StateStore / Scheduler, a scriptable mock HTTP receiver, and a harness that
drives the in-memory delivery loop to quiescence. Mirrors packages/testing in
the TypeScript implementation.

The package is named "testing" to mirror the TS @anyhook/testing package and
this module's sibling anyq/go layout. Consumers that also need the standard
library testing package in the same file should import this package under an
alias, e.g. `anyhooktesting "github.com/sns45/anyhook/go/testing"`.
*/
package testing

import (
	"sync"

	"github.com/sns45/anyhook/go/core"
)

// TestClock is a Clock whose time only advances when the test tells it to.
// It is safe for concurrent use so it can back the engine under parallel workers.
type TestClock struct {
	mu sync.Mutex
	t  int64
}

// NewTestClock builds a TestClock starting at the given epoch-ms time.
func NewTestClock(start int64) *TestClock {
	return &TestClock{t: start}
}

// Now implements core.Clock.
func (c *TestClock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

// Tick advances the clock by ms and returns the new time.
func (c *TestClock) Tick(ms int64) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t += ms
	return c.t
}

// Set jumps to an absolute time. Never moves backwards.
func (c *TestClock) Set(ms int64) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ms > c.t {
		c.t = ms
	}
	return c.t
}

var _ core.Clock = (*TestClock)(nil)

// seededRng is a deterministic LCG Rng in [0, 1), safe for concurrent use.
type seededRng struct {
	mu sync.Mutex
	s  uint32
}

// SeededRng returns a deterministic LCG-backed Rng in [0, 1). A seed of 0
// maps to 1 (matching the TS `seed >>> 0 || 1` fallback, since 0 is falsy in JS).
func SeededRng(seed uint32) core.Rng {
	if seed == 0 {
		seed = 1
	}
	return &seededRng{s: seed}
}

// Next implements core.Rng.
func (r *seededRng) Next() float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.s = r.s*1664525 + 1013904223
	return float64(r.s) / 4294967296.0
}
