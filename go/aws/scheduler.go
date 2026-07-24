package aws

import (
	"context"
	"encoding/json"
	"math"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/sns45/anyhook/go/core"
)

// wallClock is a core.Clock backed by the real wall clock, used as the
// default when no Clock is injected.
type wallClock struct{}

// Now implements core.Clock.
func (wallClock) Now() int64 { return timeNowMs() }

// schedRow is the row shape for a SCHED# row: only the message needs to
// round-trip through attributevalue; due_at/ttl/gsi1pk/gsi1sk/claimed_at are
// system attributes read/written directly (see scheduler.go/sweeper.go).
type schedRow struct {
	Message core.Message
}

// DynamoScheduler is core.Scheduler for AWS (D2 -- "the 900-second split, no
// delay-chaining"): a retry due within SQS's 900s DelaySeconds cap is sent
// immediately with that native delay; anything further out is persisted as a
// SCHED# row carrying a due_at (epoch seconds) attribute, indexed by the
// due_at GSI, for RunSweeper to discover on its fixed interval. Per P2, the
// DynamoDB item IS the schedule; this type never chains multiple delayed
// sends to cover a longer delay. Mirrors TS DynamoScheduler (scheduler.ts).
type DynamoScheduler struct {
	env   Env
	clock core.Clock
}

// NewDynamoScheduler builds a DynamoScheduler over env. clock may be nil
// (falls back to the wall clock).
func NewDynamoScheduler(env Env, clock core.Clock) *DynamoScheduler {
	if clock == nil {
		clock = wallClock{}
	}
	return &DynamoScheduler{env: env, clock: clock}
}

// ScheduleRetry implements core.Scheduler.
func (s *DynamoScheduler) ScheduleRetry(ctx context.Context, m core.Message, at int64) error {
	delayMs := at - s.clock.Now()

	if delayMs <= SqsMaxDelayMs {
		delaySeconds := int32(math.Min(900, math.Max(0, math.Ceil(float64(delayMs)/1000))))
		body, err := json.Marshal(m)
		if err != nil {
			return err
		}
		_, err = s.env.SQS.SendMessage(ctx, &sqs.SendMessageInput{
			QueueUrl:     aws.String(s.env.QueueURL),
			MessageBody:  aws.String(string(body)),
			DelaySeconds: delaySeconds,
		})
		return err
	}

	dueAtSec := at / 1000
	item, err := marshalItem(schedRow{Message: m})
	if err != nil {
		return err
	}
	item["PK"] = &types.AttributeValueMemberS{Value: TenantPK(m.Tenant)}
	item["SK"] = &types.AttributeValueMemberS{Value: SchedSK(m.MessageID)}
	item["due_at"] = &types.AttributeValueMemberN{Value: formatInt64(dueAtSec)}
	item["ttl"] = &types.AttributeValueMemberN{Value: formatInt64(dueAtSec + SchedTTLGraceSeconds)} // GC-only (D2) -- never the scheduling trigger
	item["gsi1pk"] = &types.AttributeValueMemberS{Value: SchedGSIPK}
	item["gsi1sk"] = &types.AttributeValueMemberN{Value: formatInt64(dueAtSec)}

	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: item})
	return err
}

var _ core.Scheduler = (*DynamoScheduler)(nil)
