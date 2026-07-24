package aws

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/sns45/anyhook/go/core"
)

// seedDueRow writes a SCHED# row directly into the fake table (bypassing
// DynamoScheduler), mirroring TS scheduler.test.ts's seedDueRow helper.
func seedDueRow(t *testing.T, ddb *fakeDynamo, tenant string, m core.Message, dueAtSec int64, claimedAt *int64) {
	t.Helper()
	item, err := marshalItem(schedRow{Message: m})
	if err != nil {
		t.Fatal(err)
	}
	item["PK"] = &types.AttributeValueMemberS{Value: TenantPK(tenant)}
	item["SK"] = &types.AttributeValueMemberS{Value: SchedSK(m.MessageID)}
	item["due_at"] = &types.AttributeValueMemberN{Value: formatInt64(dueAtSec)}
	item["ttl"] = &types.AttributeValueMemberN{Value: formatInt64(dueAtSec + 1000)}
	item["gsi1pk"] = &types.AttributeValueMemberS{Value: SchedGSIPK}
	item["gsi1sk"] = &types.AttributeValueMemberN{Value: formatInt64(dueAtSec)}
	if claimedAt != nil {
		item["claimed_at"] = &types.AttributeValueMemberN{Value: formatInt64(*claimedAt)}
	}
	if _, err := ddb.PutItem(context.Background(), &dynamodb.PutItemInput{TableName: aws.String("anyhook_ignored"), Item: item}); err != nil {
		t.Fatal(err)
	}
}

func TestRunSweeper_ClaimsSendsDeletes(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)

	nowMs := int64(2_000_000_000)
	m := makeTestMessage(func(m *core.Message) { m.Tenant = "tenant-a" })
	seedDueRow(t, ddb, "tenant-a", m, nowMs/1000-10, nil)

	result, err := RunSweeper(context.Background(), env, nowMs)
	if err != nil {
		t.Fatal(err)
	}
	if result != (SweeperResult{Due: 1, Claimed: 1, Sent: 1}) {
		t.Fatalf("result = %+v, want {Due:1 Claimed:1 Sent:1}", result)
	}

	calls := sqsClient.calls()
	if len(calls) != 1 {
		t.Fatalf("SendMessage calls = %d, want 1", len(calls))
	}

	// Row is gone: neither a duplicate claim nor a duplicate send can happen
	// on a second pass.
	if ddb.has(TenantPK("tenant-a"), SchedSK(m.MessageID)) {
		t.Error("SCHED# row still present after a successful sweep, want deleted")
	}
}

func TestRunSweeper_SkipsNotYetDue(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)

	nowMs := int64(2_000_000_000)
	m := makeTestMessage(func(m *core.Message) { m.Tenant = "tenant-a" })
	seedDueRow(t, ddb, "tenant-a", m, nowMs/1000+10_000, nil) // far in the future

	result, err := RunSweeper(context.Background(), env, nowMs)
	if err != nil {
		t.Fatal(err)
	}
	if result != (SweeperResult{}) {
		t.Fatalf("result = %+v, want the zero value", result)
	}
	if len(sqsClient.calls()) != 0 {
		t.Error("SendMessage was called for a not-yet-due row")
	}
}

func TestRunSweeper_SkipsFreshLease(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)

	nowMs := int64(2_000_000_000)
	m := makeTestMessage(func(m *core.Message) { m.Tenant = "tenant-a" })
	claimedAt := nowMs / 1000 // claimed_at == now -> lease is fresh, well within SweeperLeaseSeconds
	seedDueRow(t, ddb, "tenant-a", m, nowMs/1000-10, &claimedAt)

	result, err := RunSweeper(context.Background(), env, nowMs)
	if err != nil {
		t.Fatal(err)
	}
	if result != (SweeperResult{}) {
		t.Fatalf("result = %+v, want the zero value (no re-claim, no re-send)", result)
	}
	if len(sqsClient.calls()) != 0 {
		t.Error("SendMessage was called for a row with a still-valid lease")
	}
}

// TestRunSweeper_LeaseRecoveryAfterSendFailure is the key G5 guarantee this
// task calls out explicitly: lease-claim happens BEFORE SendMessage, so a
// send failure after a successful claim leaves the row lease-held (not lost,
// not deleted) and it is re-claimed and re-enqueued once the lease expires.
func TestRunSweeper_LeaseRecoveryAfterSendFailure(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)

	m := makeTestMessage(func(m *core.Message) { m.Tenant = "tenant-a" })
	t0 := int64(2_000_000_000)
	seedDueRow(t, ddb, "tenant-a", m, t0/1000-10, nil)

	// First sweep: claim succeeds, but SendMessage fails -> RunSweeper
	// propagates the error; the row keeps its lease (neither sent nor deleted).
	sqsClient.failNextSends(1, errors.New("SQS throttled"))
	if _, err := RunSweeper(context.Background(), env, t0); err == nil {
		t.Fatal("expected RunSweeper to propagate the SendMessage failure")
	}
	row := ddb.get(TenantPK("tenant-a"), SchedSK(m.MessageID))
	if row == nil {
		t.Fatal("SCHED# row was lost after a send failure, want it still present (G5)")
	}
	if _, ok := attrInt64(row, "claimed_at"); !ok {
		t.Fatal("row has no claimed_at after a successful claim, want the lease stamped")
	}

	// Before the lease expires: still skipped (no duplicate claim, no send).
	result, err := RunSweeper(context.Background(), env, t0+60_000)
	if err != nil {
		t.Fatal(err)
	}
	if result.Sent != 0 {
		t.Fatalf("Sent = %d within the lease window, want 0", result.Sent)
	}

	// After the lease expires: re-claimed and finally enqueued -- the retry
	// recovered, never dropped.
	afterLease := t0 + (SweeperLeaseSeconds+5)*1000
	recovered, err := RunSweeper(context.Background(), env, afterLease)
	if err != nil {
		t.Fatal(err)
	}
	if recovered != (SweeperResult{Due: 1, Claimed: 1, Sent: 1}) {
		t.Fatalf("recovered = %+v, want {Due:1 Claimed:1 Sent:1}", recovered)
	}
	if len(sqsClient.calls()) < 1 {
		t.Error("expected at least one successful SendMessage call after recovery")
	}
	if ddb.has(TenantPK("tenant-a"), SchedSK(m.MessageID)) {
		t.Error("SCHED# row still present after recovery, want cleaned up")
	}
}

func TestRunSweeper_LosingClaimRaceDoesNotDoubleSend(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)

	nowMs := int64(2_000_000_000)
	m := makeTestMessage(func(m *core.Message) { m.Tenant = "tenant-a" })
	seedDueRow(t, ddb, "tenant-a", m, nowMs/1000-10, nil)

	// Simulate a concurrent sweeper invocation winning the claim first: force
	// THIS row's claim UpdateItem to fail, exactly as DynamoDB would reject a
	// losing compare-and-set on attribute_not_exists(claimed_at).
	ddb.rejectNextUpdate(TenantPK("tenant-a"), SchedSK(m.MessageID), conditionalCheckFailed())

	result, err := RunSweeper(context.Background(), env, nowMs)
	if err != nil {
		t.Fatal(err)
	}
	if result != (SweeperResult{Due: 1, Claimed: 0, Sent: 0}) {
		t.Fatalf("result = %+v, want {Due:1 Claimed:0 Sent:0}", result)
	}
	if len(sqsClient.calls()) != 0 {
		t.Error("SendMessage was called despite losing the claim race")
	}

	// The row is untouched by the loser -- it's still there for whoever DID
	// win the claim to clean up.
	if !ddb.has(TenantPK("tenant-a"), SchedSK(m.MessageID)) {
		t.Error("SCHED# row was removed by the losing sweeper, want it left untouched")
	}
}
