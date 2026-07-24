package testing

import (
	"context"
	"errors"
	"sync"

	"github.com/sns45/anyhook/go/core"
)

// MemoryTransport is an in-process FIFO transport (anyq stand-in) for tests.
// Send enqueues; Drain invokes the subscribed handler for every queued
// message (including any enqueued while draining).
type MemoryTransport struct {
	mu      sync.Mutex
	queue   []core.Message
	handler func(ctx context.Context, m core.Message) error
}

// NewMemoryTransport builds an empty MemoryTransport.
func NewMemoryTransport() *MemoryTransport {
	return &MemoryTransport{}
}

// Send implements core.Transport.
func (t *MemoryTransport) Send(_ context.Context, m core.Message) error {
	t.mu.Lock()
	t.queue = append(t.queue, m) // Message contains no exported mutable pointers the caller could race on
	t.mu.Unlock()
	return nil
}

// Subscribe implements core.Transport.
func (t *MemoryTransport) Subscribe(_ context.Context, handler func(ctx context.Context, m core.Message) error) error {
	t.mu.Lock()
	t.handler = handler
	t.mu.Unlock()
	return nil
}

// Drain processes all currently-queued messages (and any enqueued during
// processing). Returns the count processed.
func (t *MemoryTransport) Drain(ctx context.Context) (int, error) {
	t.mu.Lock()
	handler := t.handler
	t.mu.Unlock()
	if handler == nil {
		return 0, errors.New("MemoryTransport.Drain called before Subscribe")
	}

	count := 0
	for {
		t.mu.Lock()
		if len(t.queue) == 0 {
			t.mu.Unlock()
			break
		}
		m := t.queue[0]
		t.queue = t.queue[1:]
		t.mu.Unlock()

		if err := handler(ctx, m); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

// Size returns the number of currently-queued messages.
func (t *MemoryTransport) Size() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.queue)
}

var _ core.Transport = (*MemoryTransport)(nil)
