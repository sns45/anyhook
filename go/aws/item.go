package aws

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// timeNowMs returns the current wall-clock time as epoch milliseconds.
func timeNowMs() int64 { return time.Now().UnixMilli() }

// formatInt64 is a small alias for strconv.FormatInt(n, 10), used when
// building Number AttributeValues.
func formatInt64(n int64) string { return strconv.FormatInt(n, 10) }

// marshalItem marshals v (a domain struct, e.g. core.Endpoint) into a
// DynamoDB item map via attributevalue, dropping any attribute that
// marshaled to NULL (Go's zero value for a nil pointer) -- the Go-side
// equivalent of the TS marshaller's `removeUndefinedValues: true` (config.ts
// resolveEnv), so an unset optional field (e.g. Endpoint.RateLimit) is simply
// absent rather than stored as an explicit null.
func marshalItem(v any) (map[string]types.AttributeValue, error) {
	m, err := attributevalue.MarshalMap(v)
	if err != nil {
		return nil, err
	}
	pruneNulls(m)
	return m, nil
}

// pruneNulls deletes every NULL-typed attribute from m in place.
func pruneNulls(m map[string]types.AttributeValue) {
	for k, v := range m {
		if _, ok := v.(*types.AttributeValueMemberNULL); ok {
			delete(m, k)
		}
	}
}

// stripSystemKeys returns a copy of item with the table's internal PK/SK/
// _version attributes removed, mirroring TS state-dynamo.ts's stripKeys.
// Domain structs have no fields of these names, so leaving them in would be
// harmless for attributevalue.UnmarshalMap (unknown keys are ignored, as in
// encoding/json), but stripping keeps behavior self-documenting and matches
// the TS adapter precisely.
func stripSystemKeys(item map[string]types.AttributeValue) map[string]types.AttributeValue {
	out := make(map[string]types.AttributeValue, len(item))
	for k, v := range item {
		switch k {
		case "PK", "SK", "_version":
			continue
		}
		out[k] = v
	}
	return out
}

// unmarshalItem decodes a DynamoDB item into T (a domain struct), stripping
// the table's internal keys first.
func unmarshalItem[T any](item map[string]types.AttributeValue) (T, error) {
	var out T
	err := attributevalue.UnmarshalMap(stripSystemKeys(item), &out)
	return out, err
}

// isConditionalCheckFailed reports whether err is (or wraps) DynamoDB's
// ConditionalCheckFailedException -- the signal a conditional Put/Update
// lost a compare-and-set race.
func isConditionalCheckFailed(err error) bool {
	var ccfe *types.ConditionalCheckFailedException
	return errors.As(err, &ccfe)
}

// attrString reads a String attribute from a raw item map (used for reading
// system attributes such as PK/SK back off a Query result row).
func attrString(item map[string]types.AttributeValue, key string) (string, bool) {
	v, ok := item[key]
	if !ok {
		return "", false
	}
	s, ok := v.(*types.AttributeValueMemberS)
	if !ok {
		return "", false
	}
	return s.Value, true
}

// attrInt64 reads a Number attribute from a raw item map as an int64.
func attrInt64(item map[string]types.AttributeValue, key string) (int64, bool) {
	v, ok := item[key]
	if !ok {
		return 0, false
	}
	n, ok := v.(*types.AttributeValueMemberN)
	if !ok {
		return 0, false
	}
	i, err := strconv.ParseInt(n.Value, 10, 64)
	if err != nil {
		return 0, false
	}
	return i, true
}

// queryAll pages through a Query for PK + begins_with(SK, skPrefix) until exhausted.
func queryAll(ctx context.Context, env Env, pk, skPrefix string) ([]map[string]types.AttributeValue, error) {
	var items []map[string]types.AttributeValue
	var startKey map[string]types.AttributeValue
	for {
		out, err := env.DDB.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(env.TableName),
			KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :skPrefix)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":       &types.AttributeValueMemberS{Value: pk},
				":skPrefix": &types.AttributeValueMemberS{Value: skPrefix},
			},
			ExclusiveStartKey: startKey,
		})
		if err != nil {
			return nil, err
		}
		items = append(items, out.Items...)
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}
	return items, nil
}

// newUUIDv4 generates a random RFC 4122 version-4 UUID string. Mirrors TS
// state-dynamo.ts's `randomUUID()` use for endpointId generation.
func newUUIDv4() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
