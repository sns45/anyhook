package testing

import (
	"context"
	"fmt"
)

// RunOptions configure RunDeliveries.
type RunOptions struct {
	Transport *MemoryTransport
	Scheduler *MemoryScheduler
	Clock     *TestClock
	// MaxRounds caps delivery rounds (defends against a non-converging
	// schedule). 0 means the default (200).
	MaxRounds int
}

// RunDeliveries repeatedly drains the transport, then jumps the clock to the
// next scheduled retry and releases it, until nothing is queued or
// scheduled. This is the in-memory analogue of a worker plus the durable
// scheduler firing over time. Returns an error if MaxRounds is exceeded.
func RunDeliveries(ctx context.Context, opts RunOptions) error {
	maxRounds := opts.MaxRounds
	if maxRounds <= 0 {
		maxRounds = 200
	}
	for round := 0; round < maxRounds; round++ {
		if _, err := opts.Transport.Drain(ctx); err != nil {
			return err
		}
		if opts.Scheduler.Size() == 0 {
			return nil
		}
		if next, ok := opts.Scheduler.NextDueAt(); ok {
			opts.Clock.Set(next)
		}
		if _, err := opts.Scheduler.Advance(ctx); err != nil {
			return err
		}
	}
	return fmt.Errorf("RunDeliveries exceeded maxRounds=%d (schedule not converging)", maxRounds)
}
