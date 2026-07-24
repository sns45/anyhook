package aws

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/sns45/anyhook/go/core"
)

// SqsTransport is core.Transport backed directly by AWS SQS (see doc.go for
// why this package calls aws-sdk-go-v2's SQS client directly rather than
// composing anyq's Go SQS producer/consumer).
//
// There is no consumer LOOP here: on AWS, delivery runs on Lambda's native
// SQS event-source mapping, which is already a push consumer. DispatchRecords
// is the seam NewDeliverHandler calls once per invocation, mapping each
// record 1:1 to one Engine.ProcessMessage call. A record whose handler
// returns an error is reported back via BatchItemFailures (Lambda's
// ReportBatchItemFailures partial-batch-failure mechanism) so ONLY that
// record is redelivered -- one record's failure must never fail the whole
// invocation, which under Lambda's default SQS semantics would redeliver
// every record in the batch and defeat per-message isolation (G3). Mirrors
// TS SqsTransport (transport-sqs.ts).
type SqsTransport struct {
	env Env

	mu      sync.Mutex
	handler func(ctx context.Context, m core.Message) error
}

// NewSqsTransport builds an SqsTransport over env.
func NewSqsTransport(env Env) *SqsTransport {
	return &SqsTransport{env: env}
}

// Send implements core.Transport: durably enqueues m onto the configured queue.
func (t *SqsTransport) Send(ctx context.Context, m core.Message) error {
	body, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = t.env.SQS.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(t.env.QueueURL),
		MessageBody: aws.String(string(body)),
	})
	return err
}

// Subscribe implements core.Transport: registers the engine's ProcessMessage
// handler, invoked per-record by DispatchRecords.
func (t *SqsTransport) Subscribe(_ context.Context, handler func(ctx context.Context, m core.Message) error) error {
	t.mu.Lock()
	t.handler = handler
	t.mu.Unlock()
	return nil
}

// DispatchRecords maps one SQS event batch (as delivered to a Lambda by the
// event-source mapping) to per-record engine deliveries, returning
// BatchItemFailures for any record whose handler returned an error or whose
// body failed to parse. handler overrides the Subscribe-registered handler
// when non-nil (used by tests and by handlers that want an explicit handler
// without going through Subscribe first).
func (t *SqsTransport) DispatchRecords(ctx context.Context, event events.SQSEvent, handler func(ctx context.Context, m core.Message) error) (events.SQSEventResponse, error) {
	h := handler
	if h == nil {
		t.mu.Lock()
		h = t.handler
		t.mu.Unlock()
	}
	if h == nil {
		return events.SQSEventResponse{}, errors.New("aws.SqsTransport.DispatchRecords called before Subscribe (and no handler was passed)")
	}

	var failures []events.SQSBatchItemFailure
	for _, record := range event.Records {
		var m core.Message
		if err := json.Unmarshal([]byte(record.Body), &m); err != nil {
			failures = append(failures, events.SQSBatchItemFailure{ItemIdentifier: record.MessageId})
			continue
		}
		if err := h(ctx, m); err != nil {
			failures = append(failures, events.SQSBatchItemFailure{ItemIdentifier: record.MessageId})
		}
	}
	return events.SQSEventResponse{BatchItemFailures: failures}, nil
}

var _ core.Transport = (*SqsTransport)(nil)
