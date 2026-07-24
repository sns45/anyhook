package aws

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"github.com/sns45/anyhook/go/core"
)

func makeSqsEvent(t *testing.T, records []struct {
	messageID string
	m         core.Message
}) events.SQSEvent {
	t.Helper()
	out := events.SQSEvent{Records: make([]events.SQSMessage, len(records))}
	for i, r := range records {
		body, err := json.Marshal(r.m)
		if err != nil {
			t.Fatal(err)
		}
		out.Records[i] = events.SQSMessage{MessageId: r.messageID, Body: string(body)}
	}
	return out
}

func TestSqsTransport_Send(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	env := testEnv(ddb, sqsClient)
	transport := NewSqsTransport(env)

	m := makeTestMessage(nil)
	if err := transport.Send(context.Background(), m); err != nil {
		t.Fatal(err)
	}

	calls := sqsClient.calls()
	if len(calls) != 1 {
		t.Fatalf("SendMessage calls = %d, want 1", len(calls))
	}
	if *calls[0].QueueUrl != env.QueueURL {
		t.Errorf("QueueUrl = %q, want %q", *calls[0].QueueUrl, env.QueueURL)
	}
	var sent core.Message
	if err := json.Unmarshal([]byte(*calls[0].MessageBody), &sent); err != nil {
		t.Fatal(err)
	}
	if sent.MessageID != m.MessageID {
		t.Errorf("sent.MessageID = %q, want %q", sent.MessageID, m.MessageID)
	}
}

func TestSqsTransport_SendReusesClientAcrossCalls(t *testing.T) {
	ddb := newFakeDynamo()
	sqsClient := newFakeSQS()
	transport := NewSqsTransport(testEnv(ddb, sqsClient))

	if err := transport.Send(context.Background(), makeTestMessage(nil)); err != nil {
		t.Fatal(err)
	}
	if err := transport.Send(context.Background(), makeTestMessage(nil)); err != nil {
		t.Fatal(err)
	}
	if len(sqsClient.calls()) != 2 {
		t.Fatalf("SendMessage calls = %d, want 2", len(sqsClient.calls()))
	}
}

func TestSqsTransport_DispatchRecordsMapsEachRecord(t *testing.T) {
	transport := NewSqsTransport(testEnv(newFakeDynamo(), newFakeSQS()))
	var seen []string
	if err := transport.Subscribe(context.Background(), func(_ context.Context, m core.Message) error {
		seen = append(seen, m.MessageID)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	m1 := makeTestMessage(func(m *core.Message) { m.MessageID = "good-1" })
	m2 := makeTestMessage(func(m *core.Message) { m.MessageID = "good-2" })
	event := makeSqsEvent(t, []struct {
		messageID string
		m         core.Message
	}{
		{"r1", m1}, {"r2", m2},
	})

	res, err := transport.DispatchRecords(context.Background(), event, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 2 || seen[0] != "good-1" || seen[1] != "good-2" {
		t.Fatalf("seen = %v, want [good-1 good-2]", seen)
	}
	if len(res.BatchItemFailures) != 0 {
		t.Errorf("BatchItemFailures = %v, want empty", res.BatchItemFailures)
	}
}

func TestSqsTransport_DispatchRecordsPartialBatchFailure(t *testing.T) {
	transport := NewSqsTransport(testEnv(newFakeDynamo(), newFakeSQS()))
	var seen []string
	if err := transport.Subscribe(context.Background(), func(_ context.Context, m core.Message) error {
		seen = append(seen, m.MessageID)
		if m.MessageID == "bad" {
			return errors.New("delivery blew up")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	event := makeSqsEvent(t, []struct {
		messageID string
		m         core.Message
	}{
		{"r1", makeTestMessage(func(m *core.Message) { m.MessageID = "good" })},
		{"r2", makeTestMessage(func(m *core.Message) { m.MessageID = "bad" })},
		{"r3", makeTestMessage(func(m *core.Message) { m.MessageID = "good-2" })},
	})

	res, err := transport.DispatchRecords(context.Background(), event, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Every record was attempted; the batch did not short-circuit.
	if len(seen) != 3 || seen[0] != "good" || seen[1] != "bad" || seen[2] != "good-2" {
		t.Fatalf("seen = %v, want [good bad good-2]", seen)
	}
	if len(res.BatchItemFailures) != 1 || res.BatchItemFailures[0].ItemIdentifier != "r2" {
		t.Fatalf("BatchItemFailures = %v, want [{ItemIdentifier:r2}]", res.BatchItemFailures)
	}
}

func TestSqsTransport_DispatchRecordsExplicitHandlerOverridesSubscribed(t *testing.T) {
	transport := NewSqsTransport(testEnv(newFakeDynamo(), newFakeSQS()))
	var subscribed, explicit []string
	if err := transport.Subscribe(context.Background(), func(_ context.Context, m core.Message) error {
		subscribed = append(subscribed, m.MessageID)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	event := makeSqsEvent(t, []struct {
		messageID string
		m         core.Message
	}{
		{"r1", makeTestMessage(func(m *core.Message) { m.MessageID = "explicit" })},
	})
	res, err := transport.DispatchRecords(context.Background(), event, func(_ context.Context, m core.Message) error {
		explicit = append(explicit, m.MessageID)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(subscribed) != 0 {
		t.Errorf("subscribed handler was invoked = %v, want it bypassed by the explicit handler", subscribed)
	}
	if len(explicit) != 1 || explicit[0] != "explicit" {
		t.Errorf("explicit = %v, want [explicit]", explicit)
	}
	if len(res.BatchItemFailures) != 0 {
		t.Errorf("BatchItemFailures = %v, want empty", res.BatchItemFailures)
	}
}

func TestSqsTransport_DispatchRecordsBeforeSubscribeErrors(t *testing.T) {
	transport := NewSqsTransport(testEnv(newFakeDynamo(), newFakeSQS()))
	_, err := transport.DispatchRecords(context.Background(), events.SQSEvent{}, nil)
	if err == nil {
		t.Fatal("expected an error when dispatching before Subscribe with no explicit handler")
	}
}
