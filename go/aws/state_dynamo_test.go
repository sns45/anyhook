package aws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/sns45/anyhook/go/core"
)

func testEnv(ddb *fakeDynamo, sqsClient *fakeSQS) Env {
	return Env{
		TableName:      "anyhook",
		QueueURL:       "https://sqs.us-east-1.amazonaws.com/123456789/anyhook",
		DueAtIndexName: DefaultDueAtIndexName,
		DDB:            ddb,
		SQS:            sqsClient,
	}
}

func makeTestMessage(overrides func(*core.Message)) core.Message {
	m := core.Message{
		MessageID:  "msg_" + mustUUID(),
		Tenant:     "tenant-a",
		EndpointID: "ep_unset",
		EventID:    "evt_" + mustUUID(),
		EventType:  "payment.succeeded",
		Payload:    json.RawMessage(`{"hello":"world"}`),
		AttemptNo:  0,
		Status:     core.StatusPending,
		CreatedAt:  1_000,
	}
	if overrides != nil {
		overrides(&m)
	}
	return m
}

func mustUUID() string {
	id, err := newUUIDv4()
	if err != nil {
		panic(err)
	}
	return id
}

// ---- endpoint CRUD + tenant scoping (G7) ----

func TestDynamoStateStore_CreateEndpointListable(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/hook", EventTypes: []string{"payment.*"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Secret == "" {
		t.Fatal("expected a non-empty secret")
	}
	if len(res.Endpoint.Secrets) != 1 || res.Endpoint.Secrets[0] != res.Secret {
		t.Errorf("Secrets = %v, want [%s]", res.Endpoint.Secrets, res.Secret)
	}
	if res.Endpoint.Disabled {
		t.Error("Disabled = true, want false")
	}

	fetched, err := store.GetEndpoint(ctx, "tenant-a", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched == nil || fetched.EndpointID != res.Endpoint.EndpointID || fetched.URL != res.Endpoint.URL {
		t.Fatalf("GetEndpoint = %+v, want %+v", fetched, res.Endpoint)
	}

	listed, err := store.ListEndpoints(ctx, "tenant-a")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range listed {
		if e.EndpointID == res.Endpoint.EndpointID {
			found = true
		}
	}
	if !found {
		t.Errorf("ListEndpoints = %+v, want to include %s", listed, res.Endpoint.EndpointID)
	}
}

func TestDynamoStateStore_MatchEndpointsWildcards(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/match", EventTypes: []string{"order.*"}})
	if err != nil {
		t.Fatal(err)
	}

	matched, err := store.MatchEndpoints(ctx, "tenant-a", "order.created")
	if err != nil {
		t.Fatal(err)
	}
	if !containsEndpoint(matched, res.Endpoint.EndpointID) {
		t.Errorf("MatchEndpoints(order.created) = %+v, want to include %s", matched, res.Endpoint.EndpointID)
	}

	notMatched, err := store.MatchEndpoints(ctx, "tenant-a", "shipment.created")
	if err != nil {
		t.Fatal(err)
	}
	if containsEndpoint(notMatched, res.Endpoint.EndpointID) {
		t.Errorf("MatchEndpoints(shipment.created) unexpectedly matched %s", res.Endpoint.EndpointID)
	}
}

func containsEndpoint(eps []core.Endpoint, id string) bool {
	for _, e := range eps {
		if e.EndpointID == id {
			return true
		}
	}
	return false
}

func TestDynamoStateStore_UpdateEndpointPatchesFields(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/orig", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	newURL := "https://example.com/new"
	disabled := true
	updated, err := store.UpdateEndpoint(ctx, "tenant-a", res.Endpoint.EndpointID, core.UpdateEndpointPatch{URL: &newURL, Disabled: &disabled})
	if err != nil {
		t.Fatal(err)
	}
	if updated.URL != newURL {
		t.Errorf("URL = %q, want %q", updated.URL, newURL)
	}
	if !updated.Disabled {
		t.Error("Disabled = false, want true")
	}
	if len(updated.EventTypes) != 1 || updated.EventTypes[0] != "a" {
		t.Errorf("EventTypes = %v, want [a] (unchanged)", updated.EventTypes)
	}
}

func TestDynamoStateStore_RotateSecretKeepsOldPrimary(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/rotate", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := store.RotateSecret(ctx, "tenant-a", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if rotated == res.Secret {
		t.Fatal("rotated secret must differ from the original")
	}
	fetched, err := store.GetEndpoint(ctx, "tenant-a", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(fetched.Secrets) != 2 || fetched.Secrets[0] != rotated || fetched.Secrets[1] != res.Secret {
		t.Errorf("Secrets = %v, want [%s, %s]", fetched.Secrets, rotated, res.Secret)
	}
}

func TestDynamoStateStore_DeleteEndpointRemovesIt(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/gone", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteEndpoint(ctx, "tenant-a", res.Endpoint.EndpointID); err != nil {
		t.Fatal(err)
	}
	fetched, err := store.GetEndpoint(ctx, "tenant-a", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched != nil {
		t.Errorf("GetEndpoint after delete = %+v, want nil", fetched)
	}
}

func TestDynamoStateStore_TenantScoping(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/private", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	fetched, err := store.GetEndpoint(ctx, "tenant-b", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched != nil {
		t.Errorf("tenant-b GetEndpoint(tenant-a's id) = %+v, want nil (G7)", fetched)
	}
	listedB, err := store.ListEndpoints(ctx, "tenant-b")
	if err != nil {
		t.Fatal(err)
	}
	if containsEndpoint(listedB, res.Endpoint.EndpointID) {
		t.Error("tenant-b can see tenant-a's endpoint (G7 violation)")
	}
}

// ---- idempotency (conditional PutItem) ----

func TestDynamoStateStore_RecordEventDuplicateReturnsOriginal(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	idemKey := "idem_" + mustUUID()
	first, err := store.RecordEvent(ctx, "tenant-a", "evt_1", idemKey)
	if err != nil {
		t.Fatal(err)
	}
	if !first.IsNew || first.EventID != "evt_1" || first.MessageCount != 0 {
		t.Fatalf("first RecordEvent = %+v, want {IsNew:true EventID:evt_1 MessageCount:0}", first)
	}

	if err := store.FinalizeEvent(ctx, "tenant-a", idemKey, "evt_1", 3); err != nil {
		t.Fatal(err)
	}

	second, err := store.RecordEvent(ctx, "tenant-a", "evt_should_be_ignored", idemKey)
	if err != nil {
		t.Fatal(err)
	}
	if second.IsNew || second.EventID != "evt_1" || second.MessageCount != 3 {
		t.Fatalf("second RecordEvent = %+v, want {IsNew:false EventID:evt_1 MessageCount:3}", second)
	}
}

func TestDynamoStateStore_RecordEventTenantScoped(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	idemKey := "idem_" + mustUUID()
	a, err := store.RecordEvent(ctx, "tenant-a", "evt_a", idemKey)
	if err != nil {
		t.Fatal(err)
	}
	b, err := store.RecordEvent(ctx, "tenant-b", "evt_b", idemKey)
	if err != nil {
		t.Fatal(err)
	}
	if !a.IsNew || a.EventID != "evt_a" {
		t.Errorf("tenant-a RecordEvent = %+v, want IsNew:true EventID:evt_a", a)
	}
	if !b.IsNew || b.EventID != "evt_b" {
		t.Errorf("tenant-b RecordEvent = %+v, want IsNew:true EventID:evt_b (same idemKey, independent per tenant)", b)
	}
}

// ---- messages, attempts, DLQ ----

func TestDynamoStateStore_PutGetMessageRoundTrip(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/msg", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	m := makeTestMessage(func(m *core.Message) { m.EndpointID = res.Endpoint.EndpointID })
	if err := store.PutMessage(ctx, m); err != nil {
		t.Fatal(err)
	}
	fetched, err := store.GetMessage(ctx, "tenant-a", m.MessageID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched == nil || fetched.MessageID != m.MessageID || fetched.EndpointID != m.EndpointID || string(fetched.Payload) != string(m.Payload) {
		t.Fatalf("GetMessage = %+v, want %+v", fetched, m)
	}
}

func TestDynamoStateStore_GetMessageUnknownReturnsNil(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	m, err := store.GetMessage(context.Background(), "tenant-a", "msg_does_not_exist")
	if err != nil {
		t.Fatal(err)
	}
	if m != nil {
		t.Errorf("GetMessage(unknown) = %+v, want nil", m)
	}
}

func TestDynamoStateStore_AppendAttemptListDeliveriesOrder(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/attempts", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	m := makeTestMessage(func(m *core.Message) { m.EndpointID = res.Endpoint.EndpointID; m.EventType = "attempts.test" })
	if err := store.PutMessage(ctx, m); err != nil {
		t.Fatal(err)
	}

	attempt1 := core.Attempt{
		MessageID: m.MessageID, EndpointID: res.Endpoint.EndpointID, Tenant: "tenant-a", EventType: m.EventType,
		AttemptNo: 0, Status: 500, LatencyMs: 12, RespSnippet: "err", Ts: 1, Outcome: core.AttemptRetried,
	}
	attempt2 := attempt1
	attempt2.AttemptNo = 1
	attempt2.Status = 200
	attempt2.Outcome = core.AttemptDelivered

	if err := store.AppendAttempt(ctx, attempt1); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendAttempt(ctx, attempt2); err != nil {
		t.Fatal(err)
	}

	rows, err := store.ListDeliveries(ctx, core.DeliveryQuery{Tenant: "tenant-a", EndpointID: res.Endpoint.EndpointID, EventType: "attempts.test"})
	if err != nil {
		t.Fatal(err)
	}
	var row *core.DeliveryRow
	for i := range rows {
		if rows[i].Message.MessageID == m.MessageID {
			row = &rows[i]
		}
	}
	if row == nil {
		t.Fatal("expected a delivery row for the message")
	}
	if len(row.Attempts) != 2 || row.Attempts[0].AttemptNo != 0 || row.Attempts[1].AttemptNo != 1 {
		t.Fatalf("Attempts = %+v, want [attempt1, attempt2] in order", row.Attempts)
	}
}

func TestDynamoStateStore_ListDeliveriesFiltersSortLimit(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	tenant := "tenant-filter-" + mustUUID()
	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: tenant, URL: "https://example.com/filter", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	older := makeTestMessage(func(m *core.Message) {
		m.Tenant = tenant
		m.EndpointID = res.Endpoint.EndpointID
		m.CreatedAt = 1000
		m.Status = core.StatusDelivered
		m.EventType = "x"
	})
	middle := makeTestMessage(func(m *core.Message) {
		m.Tenant = tenant
		m.EndpointID = res.Endpoint.EndpointID
		m.CreatedAt = 2000
		m.Status = core.StatusDead
		m.EventType = "x"
	})
	newer := makeTestMessage(func(m *core.Message) {
		m.Tenant = tenant
		m.EndpointID = res.Endpoint.EndpointID
		m.CreatedAt = 3000
		m.Status = core.StatusDelivered
		m.EventType = "y"
	})
	for _, m := range []core.Message{older, middle, newer} {
		if err := store.PutMessage(ctx, m); err != nil {
			t.Fatal(err)
		}
	}

	byStatus, err := store.ListDeliveries(ctx, core.DeliveryQuery{Tenant: tenant, Status: core.StatusDelivered})
	if err != nil {
		t.Fatal(err)
	}
	if !sameMessageIDs(byStatus, newer.MessageID, older.MessageID) {
		t.Errorf("byStatus = %+v, want [%s, %s] (any order)", ids(byStatus), newer.MessageID, older.MessageID)
	}

	byEventType, err := store.ListDeliveries(ctx, core.DeliveryQuery{Tenant: tenant, EventType: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if !sameMessageIDs(byEventType, older.MessageID, middle.MessageID) {
		t.Errorf("byEventType = %+v, want [%s, %s] (any order)", ids(byEventType), older.MessageID, middle.MessageID)
	}

	before := int64(3000)
	after := int64(1000)
	byWindow, err := store.ListDeliveries(ctx, core.DeliveryQuery{Tenant: tenant, After: &after, Before: &before})
	if err != nil {
		t.Fatal(err)
	}
	if len(byWindow) != 1 || byWindow[0].Message.MessageID != middle.MessageID {
		t.Errorf("byWindow = %+v, want [%s]", ids(byWindow), middle.MessageID)
	}

	all, err := store.ListDeliveries(ctx, core.DeliveryQuery{Tenant: tenant})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 || all[0].Message.MessageID != newer.MessageID || all[1].Message.MessageID != middle.MessageID || all[2].Message.MessageID != older.MessageID {
		t.Errorf("all = %+v, want [newer, middle, older] sorted by createdAt desc", ids(all))
	}

	limited, err := store.ListDeliveries(ctx, core.DeliveryQuery{Tenant: tenant, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 1 || limited[0].Message.MessageID != newer.MessageID {
		t.Errorf("limited = %+v, want [%s]", ids(limited), newer.MessageID)
	}
}

func ids(rows []core.DeliveryRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Message.MessageID
	}
	return out
}

func sameMessageIDs(rows []core.DeliveryRow, want ...string) bool {
	if len(rows) != len(want) {
		return false
	}
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.Message.MessageID] = true
	}
	for _, w := range want {
		if !seen[w] {
			return false
		}
	}
	return true
}

func TestDynamoStateStore_AddToDlqListDlq(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	tenant := "tenant-dlq-" + mustUUID()
	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: tenant, URL: "https://example.com/dlq", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	m := makeTestMessage(func(m *core.Message) {
		m.Tenant = tenant
		m.EndpointID = res.Endpoint.EndpointID
		m.Status = core.StatusDead
	})
	if err := store.AddToDlq(ctx, m, core.ReasonExhaustedRetries); err != nil {
		t.Fatal(err)
	}

	scoped, err := store.ListDlq(ctx, tenant, res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(scoped) != 1 || scoped[0].Message.MessageID != m.MessageID || scoped[0].Reason != core.ReasonExhaustedRetries {
		t.Fatalf("scoped ListDlq = %+v, want one exhausted_retries entry for %s", scoped, m.MessageID)
	}

	fannedOut, err := store.ListDlq(ctx, tenant, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(fannedOut) != 1 || fannedOut[0].Message.MessageID != m.MessageID {
		t.Fatalf("tenant-wide ListDlq = %+v, want one entry for %s", fannedOut, m.MessageID)
	}
}

// ---- circuit (optimistic concurrency, D2) ----

func TestDynamoStateStore_GetCircuitDefaultsPutPersists(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/circuit", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.GetCircuit(ctx, "tenant-a", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	want := core.InitialCircuit(core.DefaultCooldownMs)
	if got != want {
		t.Errorf("GetCircuit (unset) = %+v, want %+v", got, want)
	}

	openedAt := int64(12345)
	rec := core.CircuitRecord{State: core.CircuitOpen, ConsecutiveFailures: 5, OpenedAt: &openedAt, CooldownMs: 30_000}
	if err := store.PutCircuit(ctx, "tenant-a", res.Endpoint.EndpointID, rec); err != nil {
		t.Fatal(err)
	}
	got2, err := store.GetCircuit(ctx, "tenant-a", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if got2.State != rec.State || got2.ConsecutiveFailures != rec.ConsecutiveFailures || got2.CooldownMs != rec.CooldownMs ||
		got2.OpenedAt == nil || *got2.OpenedAt != *rec.OpenedAt {
		t.Errorf("GetCircuit (after put) = %+v, want %+v", got2, rec)
	}
}

func TestDynamoStateStore_PutCircuitConflict(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	res, err := store.CreateEndpoint(ctx, core.CreateEndpointInput{Tenant: "tenant-a", URL: "https://example.com/circuit-conflict", EventTypes: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	// First write succeeds and establishes _version=1.
	if err := store.PutCircuit(ctx, "tenant-a", res.Endpoint.EndpointID, core.CircuitRecord{State: core.CircuitClosed, ConsecutiveFailures: 1, CooldownMs: 30_000}); err != nil {
		t.Fatal(err)
	}

	// Simulate a concurrent writer winning the race between OUR read and OUR
	// write: force-fail the NEXT PutItem to this exact row.
	ddb.rejectNextPut(TenantPK("tenant-a"), CircuitSK(res.Endpoint.EndpointID), conditionalCheckFailed())

	openedAt := int64(1)
	err = store.PutCircuit(ctx, "tenant-a", res.Endpoint.EndpointID, core.CircuitRecord{State: core.CircuitOpen, ConsecutiveFailures: 5, OpenedAt: &openedAt, CooldownMs: 30_000})
	var conflict *CircuitWriteConflictError
	if err == nil {
		t.Fatal("expected a CircuitWriteConflictError, got nil")
	}
	if !isCircuitWriteConflict(err, &conflict) {
		t.Fatalf("PutCircuit error = %v (%T), want *CircuitWriteConflictError", err, err)
	}

	// The rejected write must not have landed: the record from the first
	// successful write stands.
	got, err := store.GetCircuit(ctx, "tenant-a", res.Endpoint.EndpointID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != core.CircuitClosed || got.ConsecutiveFailures != 1 || got.CooldownMs != 30_000 {
		t.Errorf("GetCircuit after conflict = %+v, want the first write to still stand", got)
	}
}

func isCircuitWriteConflict(err error, target **CircuitWriteConflictError) bool {
	c, ok := err.(*CircuitWriteConflictError)
	if ok {
		*target = c
	}
	return ok
}

func TestDynamoStateStore_PutCircuitFreshEndpointUsesAttributeNotExists(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	rec := core.CircuitRecord{State: core.CircuitClosed, ConsecutiveFailures: 0, CooldownMs: 30_000}
	if err := store.PutCircuit(ctx, "tenant-a", "ep_fresh", rec); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetCircuit(ctx, "tenant-a", "ep_fresh")
	if err != nil {
		t.Fatal(err)
	}
	if got != rec {
		t.Errorf("GetCircuit = %+v, want %+v", got, rec)
	}
}

// ---- rate limiting (§10) ----

func TestDynamoStateStore_RateBucketRoundTrip(t *testing.T) {
	ddb := newFakeDynamo()
	store := NewDynamoStateStore(testEnv(ddb, nil))
	ctx := context.Background()

	got, err := store.GetRateBucket(ctx, "tenant-a", "ep_1")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("GetRateBucket (unset) = %+v, want nil", got)
	}

	bucket := core.RateBucket{Tokens: 2.5, LastRefillMs: 1000}
	if err := store.PutRateBucket(ctx, "tenant-a", "ep_1", bucket); err != nil {
		t.Fatal(err)
	}
	got2, err := store.GetRateBucket(ctx, "tenant-a", "ep_1")
	if err != nil {
		t.Fatal(err)
	}
	if got2 == nil || *got2 != bucket {
		t.Errorf("GetRateBucket (after put) = %+v, want %+v", got2, bucket)
	}
}
