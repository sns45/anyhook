package testing

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/sns45/anyhook/go/core"
	"github.com/sns45/anyhook/go/signing"
)

type eventRecord struct {
	eventID      string
	messageCount int
}

type tenantData struct {
	events    map[string]eventRecord // idemKey -> record
	endpoints map[string]core.Endpoint
	messages  map[string]core.Message
	attempts  map[string][]core.Attempt
	circuits  map[string]core.CircuitRecord
	dlq       []core.DlqEntry
}

func newTenantData() *tenantData {
	return &tenantData{
		events:    map[string]eventRecord{},
		endpoints: map[string]core.Endpoint{},
		messages:  map[string]core.Message{},
		attempts:  map[string][]core.Attempt{},
		circuits:  map[string]core.CircuitRecord{},
	}
}

// MemoryStateStore is an in-memory, tenant-scoped StateStore. Every
// read/write is keyed by tenant first, so no query can ever observe another
// tenant's rows (the cross-tenant no-leak invariant, G7).
type MemoryStateStore struct {
	mu              sync.Mutex
	tenants         map[string]*tenantData
	clock           core.Clock
	endpointCounter int
}

// NewMemoryStateStore builds an empty MemoryStateStore. clock may be nil (falls back to wall time).
func NewMemoryStateStore(clock core.Clock) *MemoryStateStore {
	return &MemoryStateStore{tenants: map[string]*tenantData{}, clock: clock}
}

// tenant returns (creating if needed) the tenantData for tenant. Caller must hold s.mu.
func (s *MemoryStateStore) tenant(tenant string) *tenantData {
	d, ok := s.tenants[tenant]
	if !ok {
		d = newTenantData()
		s.tenants[tenant] = d
	}
	return d
}

func (s *MemoryStateStore) now() int64 {
	if s.clock != nil {
		return s.clock.Now()
	}
	return time.Now().UnixMilli()
}

// RecordEvent implements core.StateStore.
func (s *MemoryStateStore) RecordEvent(_ context.Context, tenant, eventID, idemKey string) (core.EventRecordResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(tenant)
	if existing, ok := d.events[idemKey]; ok {
		return core.EventRecordResult{IsNew: false, EventID: existing.eventID, MessageCount: existing.messageCount}, nil
	}
	d.events[idemKey] = eventRecord{eventID: eventID, messageCount: 0}
	return core.EventRecordResult{IsNew: true, EventID: eventID, MessageCount: 0}, nil
}

// FinalizeEvent implements core.StateStore.
func (s *MemoryStateStore) FinalizeEvent(_ context.Context, tenant, idemKey, eventID string, messageCount int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenant).events[idemKey] = eventRecord{eventID: eventID, messageCount: messageCount}
	return nil
}

// CreateEndpoint implements core.StateStore.
func (s *MemoryStateStore) CreateEndpoint(_ context.Context, in core.CreateEndpointInput) (core.CreateEndpointResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(in.Tenant)
	secret, err := signing.GenerateSecret(0)
	if err != nil {
		return core.CreateEndpointResult{}, err
	}
	s.endpointCounter++
	endpointID := fmt.Sprintf("ep_%s%s", strconv.FormatInt(int64(s.endpointCounter), 36), strconv.FormatInt(s.now(), 36))
	eventTypes := append([]string(nil), in.EventTypes...)
	ep := core.Endpoint{
		EndpointID: endpointID, Tenant: in.Tenant, URL: in.URL, EventTypes: eventTypes,
		Description: in.Description, Disabled: false, RateLimit: in.RateLimit,
		CreatedAt: s.now(), Secrets: []string{secret},
	}
	d.endpoints[endpointID] = ep
	return core.CreateEndpointResult{Endpoint: ep, Secret: secret}, nil
}

// GetEndpoint implements core.StateStore.
func (s *MemoryStateStore) GetEndpoint(_ context.Context, tenant, endpointID string) (*core.Endpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ep, ok := s.tenant(tenant).endpoints[endpointID]
	if !ok {
		return nil, nil
	}
	cp := ep
	return &cp, nil
}

// ListEndpoints implements core.StateStore.
func (s *MemoryStateStore) ListEndpoints(_ context.Context, tenant string) ([]core.Endpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(tenant)
	out := make([]core.Endpoint, 0, len(d.endpoints))
	for _, ep := range d.endpoints {
		out = append(out, ep)
	}
	return out, nil
}

// MatchEndpoints implements core.StateStore.
func (s *MemoryStateStore) MatchEndpoints(_ context.Context, tenant, eventType string) ([]core.Endpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(tenant)
	out := make([]core.Endpoint, 0, len(d.endpoints))
	for _, ep := range d.endpoints {
		if core.Subscribes(ep, eventType) {
			out = append(out, ep)
		}
	}
	return out, nil
}

// UpdateEndpoint implements core.StateStore.
func (s *MemoryStateStore) UpdateEndpoint(_ context.Context, tenant, endpointID string, patch core.UpdateEndpointPatch) (core.Endpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(tenant)
	existing, ok := d.endpoints[endpointID]
	if !ok {
		return core.Endpoint{}, fmt.Errorf("endpoint not found: %s", endpointID)
	}
	if patch.URL != nil {
		existing.URL = *patch.URL
	}
	if patch.EventTypes != nil {
		existing.EventTypes = append([]string(nil), (*patch.EventTypes)...)
	}
	if patch.Disabled != nil {
		existing.Disabled = *patch.Disabled
	}
	d.endpoints[endpointID] = existing
	return existing, nil
}

// RotateSecret implements core.StateStore. Keeps the previous primary secret
// valid during a dual-secret rotation window.
func (s *MemoryStateStore) RotateSecret(_ context.Context, tenant, endpointID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(tenant)
	existing, ok := d.endpoints[endpointID]
	if !ok {
		return "", fmt.Errorf("endpoint not found: %s", endpointID)
	}
	secret, err := signing.GenerateSecret(0)
	if err != nil {
		return "", err
	}
	existing.Secrets = []string{secret, existing.Secrets[0]}
	d.endpoints[endpointID] = existing
	return secret, nil
}

// DeleteEndpoint implements core.StateStore.
func (s *MemoryStateStore) DeleteEndpoint(_ context.Context, tenant, endpointID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tenant(tenant).endpoints, endpointID)
	return nil
}

// PutMessage implements core.StateStore.
func (s *MemoryStateStore) PutMessage(_ context.Context, m core.Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(m.Tenant).messages[m.MessageID] = m
	return nil
}

// GetMessage implements core.StateStore.
func (s *MemoryStateStore) GetMessage(_ context.Context, tenant, messageID string) (*core.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.tenant(tenant).messages[messageID]
	if !ok {
		return nil, nil
	}
	cp := m
	return &cp, nil
}

// AppendAttempt implements core.StateStore.
func (s *MemoryStateStore) AppendAttempt(_ context.Context, a core.Attempt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(a.Tenant)
	d.attempts[a.MessageID] = append(d.attempts[a.MessageID], a)
	return nil
}

// ListDeliveries implements core.StateStore.
func (s *MemoryStateStore) ListDeliveries(_ context.Context, q core.DeliveryQuery) ([]core.DeliveryRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.tenant(q.Tenant)
	rows := make([]core.Message, 0, len(d.messages))
	for _, m := range d.messages {
		rows = append(rows, m)
	}
	if q.EndpointID != "" {
		rows = filterMessages(rows, func(m core.Message) bool { return m.EndpointID == q.EndpointID })
	}
	if q.EventType != "" {
		rows = filterMessages(rows, func(m core.Message) bool { return m.EventType == q.EventType })
	}
	if q.Status != "" {
		rows = filterMessages(rows, func(m core.Message) bool { return m.Status == q.Status })
	}
	if q.Before != nil {
		before := *q.Before
		rows = filterMessages(rows, func(m core.Message) bool { return m.CreatedAt < before })
	}
	if q.After != nil {
		after := *q.After
		rows = filterMessages(rows, func(m core.Message) bool { return m.CreatedAt > after })
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt > rows[j].CreatedAt })
	if q.Limit > 0 && len(rows) > q.Limit {
		rows = rows[:q.Limit]
	}
	out := make([]core.DeliveryRow, 0, len(rows))
	for _, m := range rows {
		attempts := append([]core.Attempt(nil), d.attempts[m.MessageID]...)
		out = append(out, core.DeliveryRow{Message: m, Attempts: attempts})
	}
	return out, nil
}

func filterMessages(rows []core.Message, keep func(core.Message) bool) []core.Message {
	out := rows[:0:0]
	for _, m := range rows {
		if keep(m) {
			out = append(out, m)
		}
	}
	return out
}

// GetCircuit implements core.StateStore.
func (s *MemoryStateStore) GetCircuit(_ context.Context, tenant, endpointID string) (core.CircuitRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.tenant(tenant).circuits[endpointID]
	if !ok {
		return core.InitialCircuit(core.DefaultCooldownMs), nil
	}
	return rec, nil
}

// PutCircuit implements core.StateStore.
func (s *MemoryStateStore) PutCircuit(_ context.Context, tenant, endpointID string, rec core.CircuitRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenant).circuits[endpointID] = rec
	return nil
}

// AddToDlq implements core.StateStore.
func (s *MemoryStateStore) AddToDlq(_ context.Context, m core.Message, reason core.DlqReason) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(m.Tenant).dlq = append(s.tenant(m.Tenant).dlq, core.DlqEntry{Message: m, Reason: reason})
	return nil
}

// ListDlq implements core.StateStore.
func (s *MemoryStateStore) ListDlq(_ context.Context, tenant, endpointID string) ([]core.DlqEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := s.tenant(tenant).dlq
	out := make([]core.DlqEntry, 0, len(rows))
	for _, r := range rows {
		if endpointID != "" && r.Message.EndpointID != endpointID {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

var _ core.StateStore = (*MemoryStateStore)(nil)
