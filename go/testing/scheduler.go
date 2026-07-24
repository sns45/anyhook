package testing

import (
	"context"
	"sync"

	"github.com/sns45/anyhook/go/core"
)

type pendingRetry struct {
	at int64
	m  core.Message
}

// MemoryScheduler records scheduled retries and re-enqueues them onto the
// transport once due. Embodies "the state store is the schedule": a message
// is re-delivered only after the clock reaches its scheduled time.
type MemoryScheduler struct {
	mu        sync.Mutex
	pending   []pendingRetry
	transport *MemoryTransport
	clock     *TestClock
}

// NewMemoryScheduler builds a MemoryScheduler driven by clock and re-enqueuing onto transport.
func NewMemoryScheduler(transport *MemoryTransport, clock *TestClock) *MemoryScheduler {
	return &MemoryScheduler{transport: transport, clock: clock}
}

// ScheduleRetry implements core.Scheduler.
func (s *MemoryScheduler) ScheduleRetry(_ context.Context, m core.Message, at int64) error {
	s.mu.Lock()
	s.pending = append(s.pending, pendingRetry{at: at, m: m})
	s.mu.Unlock()
	return nil
}

// Advance re-enqueues every message whose scheduled time is <= now. Returns the count released.
func (s *MemoryScheduler) Advance(ctx context.Context) (int, error) {
	now := s.clock.Now()
	s.mu.Lock()
	var due, rest []pendingRetry
	for _, p := range s.pending {
		if p.at <= now {
			due = append(due, p)
		} else {
			rest = append(rest, p)
		}
	}
	s.pending = rest
	s.mu.Unlock()

	for _, p := range due {
		if err := s.transport.Send(ctx, p.m); err != nil {
			return 0, err
		}
	}
	return len(due), nil
}

// Size returns the number of still-pending scheduled retries.
func (s *MemoryScheduler) Size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

// NextDueAt returns the earliest scheduled time still pending, and true, or (0, false) when empty.
func (s *MemoryScheduler) NextDueAt() (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) == 0 {
		return 0, false
	}
	min := s.pending[0].at
	for _, p := range s.pending[1:] {
		if p.at < min {
			min = p.at
		}
	}
	return min, true
}

var _ core.Scheduler = (*MemoryScheduler)(nil)
