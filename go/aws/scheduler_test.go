package aws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"

	"github.com/sns45/anyhook/go/core"
)

// fixedClock is a core.Clock that always returns t.
type fixedClock int64

func (c fixedClock) Now() int64 { return int64(c) }

func TestDynamoScheduler_ShortDelayUsesSqsNativeDelay(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)
	scheduler := NewDynamoScheduler(env, fixedClock(1_000_000))

	m := makeTestMessage(func(m *core.Message) { m.AttemptNo = 1; m.Status = core.StatusRetrying })
	if err := scheduler.ScheduleRetry(context.Background(), m, 1_000_000+500_000); err != nil { // 500s out
		t.Fatal(err)
	}

	calls := sqsClient.calls()
	if len(calls) != 1 {
		t.Fatalf("SendMessage calls = %d, want 1", len(calls))
	}
	if *calls[0].QueueUrl != env.QueueURL {
		t.Errorf("QueueUrl = %q, want %q", *calls[0].QueueUrl, env.QueueURL)
	}
	if calls[0].DelaySeconds != 500 {
		t.Errorf("DelaySeconds = %d, want 500", calls[0].DelaySeconds)
	}
	var sent core.Message
	if err := json.Unmarshal([]byte(*calls[0].MessageBody), &sent); err != nil {
		t.Fatal(err)
	}
	if sent.MessageID != m.MessageID {
		t.Errorf("sent.MessageID = %q, want %q", sent.MessageID, m.MessageID)
	}

	if ddb.has(TenantPK(m.Tenant), SchedSK(m.MessageID)) {
		t.Error("a SCHED# row was written for a short delay, want none")
	}
}

func TestDynamoScheduler_BoundaryDelayUsesSqsDelay(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)
	scheduler := NewDynamoScheduler(env, fixedClock(1_000_000))

	m := makeTestMessage(nil)
	if err := scheduler.ScheduleRetry(context.Background(), m, 1_000_000+900_000); err != nil { // exactly at the 900s boundary
		t.Fatal(err)
	}
	calls := sqsClient.calls()
	if len(calls) != 1 {
		t.Fatalf("SendMessage calls = %d, want 1", len(calls))
	}
	if calls[0].DelaySeconds != 900 {
		t.Errorf("DelaySeconds = %d, want 900 (<=, not <)", calls[0].DelaySeconds)
	}
}

func TestDynamoScheduler_LongDelayPersistsSchedRow(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)
	scheduler := NewDynamoScheduler(env, fixedClock(1_000_000))

	m := makeTestMessage(nil)
	at := int64(1_000_000 + 3_600_000) // 1 hour out
	if err := scheduler.ScheduleRetry(context.Background(), m, at); err != nil {
		t.Fatal(err)
	}

	if calls := sqsClient.calls(); len(calls) != 0 {
		t.Fatalf("SendMessage calls = %d, want 0 (delay > 900s persists a row instead)", len(calls))
	}

	row := ddb.get(TenantPK(m.Tenant), SchedSK(m.MessageID))
	if row == nil {
		t.Fatal("expected a SCHED# row")
	}
	wantDueAt := at / 1000
	if got, ok := attrInt64(row, "due_at"); !ok || got != wantDueAt {
		t.Errorf("due_at = %v, want %d", got, wantDueAt)
	}
	if got, ok := attrString(row, "gsi1pk"); !ok || got != SchedGSIPK {
		t.Errorf("gsi1pk = %v, want %s", got, SchedGSIPK)
	}
	if got, ok := attrInt64(row, "gsi1sk"); !ok || got != wantDueAt {
		t.Errorf("gsi1sk = %v, want %d", got, wantDueAt)
	}
	ttl, ok := attrInt64(row, "ttl")
	if !ok || ttl <= wantDueAt {
		t.Errorf("ttl = %v, want > due_at (%d)", ttl, wantDueAt)
	}

	var stored core.Message
	if err := attributevalue.Unmarshal(row["Message"], &stored); err != nil {
		t.Fatal(err)
	}
	if stored.MessageID != m.MessageID {
		t.Errorf("stored Message.MessageID = %q, want %q", stored.MessageID, m.MessageID)
	}
}
