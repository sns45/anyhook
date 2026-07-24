package core

import (
	"math/rand"
	"time"
)

// nowMs returns the current wall-clock time in epoch ms.
func nowMs() int64 { return time.Now().UnixMilli() }

// defaultRng is the fallback Rng used when EngineOptions.Rng is nil: an
// unseeded math/rand source. NOT deterministic -- tests should always inject
// their own Rng (see package testing's SeededRng).
type defaultRng struct{}

func (defaultRng) Next() float64 { return rand.Float64() }
