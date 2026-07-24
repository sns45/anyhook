package aws

import (
	"context"
	"encoding/json"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/sns45/anyhook/go/core"
)

// SweeperResult summarizes one RunSweeper pass. Mirrors TS SweeperResult.
type SweeperResult struct {
	// Due is the count of rows found due (due_at <= now) and not currently
	// lease-held, across all pages this run scanned.
	Due int
	// Claimed is the count of rows this run successfully claimed (won the
	// lease compare-and-set).
	Claimed int
	// Sent is the count of rows sent to SQS and cleaned up.
	Sent int
}

// RunSweeper discovers every SCHED# row whose due_at <= now via the due_at
// GSI, lease-claims each with a conditional UpdateItem (stamp claimed_at)
// BEFORE sending it to SQS, then deletes the row.
//
// The lease is what makes two concurrent sweeper invocations safe AND
// crash/failure-safe:
//   - Only one invocation can win the conditional write for a given row, so
//     the common path enqueues a message at most once (the loser's
//     ConditionalCheckFailedException is caught and skipped).
//   - Crucially, the claim is a LEASE, not a permanent flag: if SendMessage
//     fails after a successful claim (SQS throttling/outage), the row is
//     neither sent nor deleted, but its claimed_at lease expires after
//     SweeperLeaseSeconds, so a later sweep re-claims and re-enqueues it. A
//     due retry is therefore never lost (G5) -- at worst delayed by one
//     lease interval, or (rarely, under a claim race that overlaps a lease
//     boundary) delivered twice, which the stable webhook-id dedupes.
//
// The attribute_exists(SK) guard prevents an UpdateItem from resurrecting a
// row another sweep already sent+deleted (no orphan rows). DynamoDB's ttl is
// garbage-collection only; this sweeper -- never TTL expiry -- is the
// scheduling trigger. Mirrors TS runSweeper (sweeper.ts) exactly, including
// the send-then-delete-under-lease ordering.
func RunSweeper(ctx context.Context, env Env, now int64) (SweeperResult, error) {
	nowSec := now / 1000
	leaseFloorSec := nowSec - SweeperLeaseSeconds
	var result SweeperResult

	var startKey map[string]types.AttributeValue
	for {
		out, err := env.DDB.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(env.TableName),
			IndexName:              aws.String(env.DueAtIndexName),
			KeyConditionExpression: aws.String("gsi1pk = :pk AND gsi1sk <= :now"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":  &types.AttributeValueMemberS{Value: SchedGSIPK},
				":now": &types.AttributeValueMemberN{Value: formatInt64(nowSec)},
			},
			ExclusiveStartKey: startKey,
		})
		if err != nil {
			return result, err
		}

		for _, item := range out.Items {
			// Skip a row whose lease is still valid (claimed recently by a
			// concurrent/earlier in-flight run).
			if claimedAt, ok := attrInt64(item, "claimed_at"); ok && claimedAt >= leaseFloorSec {
				continue
			}
			result.Due++

			pk, _ := attrString(item, "PK")
			sk, _ := attrString(item, "SK")
			key := map[string]types.AttributeValue{
				"PK": &types.AttributeValueMemberS{Value: pk},
				"SK": &types.AttributeValueMemberS{Value: sk},
			}

			_, err := env.DDB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName:           aws.String(env.TableName),
				Key:                 key,
				UpdateExpression:    aws.String("SET claimed_at = :now"),
				ConditionExpression: aws.String("attribute_exists(SK) AND (attribute_not_exists(claimed_at) OR claimed_at < :leaseFloor)"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":now":        &types.AttributeValueMemberN{Value: formatInt64(nowSec)},
					":leaseFloor": &types.AttributeValueMemberN{Value: formatInt64(leaseFloorSec)},
				},
			})
			if err != nil {
				if isConditionalCheckFailed(err) {
					continue // lost the claim race, or someone holds a fresh lease
				}
				return result, err
			}
			result.Claimed++

			msgAttr, ok := item["Message"]
			if !ok {
				return result, errSchedRowMissingMessage(pk, sk)
			}
			var msg core.Message
			if err := attributevalue.Unmarshal(msgAttr, &msg); err != nil {
				return result, err
			}
			body, err := json.Marshal(msg)
			if err != nil {
				return result, err
			}

			// Send-then-delete under the held lease. A failure here leaves the
			// row lease-held; it recovers after the lease expires (never lost, G5).
			if _, err := env.SQS.SendMessage(ctx, &sqs.SendMessageInput{
				QueueUrl:     aws.String(env.QueueURL),
				MessageBody:  aws.String(string(body)),
				DelaySeconds: 0,
			}); err != nil {
				return result, err
			}
			// The delete is idempotent (no-op if already gone).
			if _, err := env.DDB.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: aws.String(env.TableName), Key: key}); err != nil {
				return result, err
			}
			result.Sent++
		}

		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}

	return result, nil
}

func errSchedRowMissingMessage(pk, sk string) error {
	return &schedRowMissingMessageError{PK: pk, SK: sk}
}

// schedRowMissingMessageError indicates a SCHED# row was found via the
// due_at GSI but had no Message attribute -- a data-corruption case that
// should never happen via this package's own writes (ScheduleRetry always
// sets it); surfaced as an error rather than silently skipped so it isn't
// swallowed.
type schedRowMissingMessageError struct {
	PK, SK string
}

func (e *schedRowMissingMessageError) Error() string {
	return "aws.RunSweeper: SCHED row missing Message attribute for PK=" + e.PK + " SK=" + e.SK
}
