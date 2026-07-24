package aws

// Test-only in-memory DynamoDB/SQS fakes implementing DynamoDBAPI/SQSAPI:
// evaluate the small ConditionExpression/UpdateExpression vocabulary this
// adapter actually emits, mirroring packages/aws/test/fake-dynamo.ts. No
// LocalStack or other live AWS dependency is required.

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// conditionalCheckFailed builds the exact exception type DynamoDB returns
// for a failed ConditionExpression, so production isConditionalCheckFailed
// matching is exercised for real, not just mocked away.
func conditionalCheckFailed() error {
	return &types.ConditionalCheckFailedException{Message: aws.String("The conditional request failed")}
}

func fakeItemKey(pk, sk string) string { return pk + "#" + sk }

func cloneItem(item map[string]types.AttributeValue) map[string]types.AttributeValue {
	if item == nil {
		return nil
	}
	out := make(map[string]types.AttributeValue, len(item))
	for k, v := range item {
		out[k] = v
	}
	return out
}

func avString(v types.AttributeValue) string {
	if s, ok := v.(*types.AttributeValueMemberS); ok {
		return s.Value
	}
	return ""
}

func avNumber(v types.AttributeValue) int64 {
	if n, ok := v.(*types.AttributeValueMemberN); ok {
		i, _ := strconv.ParseInt(n.Value, 10, 64)
		return i
	}
	return 0
}

// fakeDynamo is a minimal in-memory DynamoDB covering exactly the vocabulary
// state_dynamo.go / scheduler.go / sweeper.go emit: Get/Put/Delete by
// {PK,SK}, Query by PK + begins_with(SK, prefix) OR by the due_at GSI
// (gsi1pk/gsi1sk), Update for the two expressions this adapter writes ("ADD
// seq :one", "SET claimed_at = :now"), and ConditionExpression evaluation for
// attribute_not_exists(...)/attribute_exists(...)/#alias = :value/< so a
// genuine optimistic-concurrency race (read stale version, write, get
// rejected) is reproducible in a unit test, not just mocked away.
type fakeDynamo struct {
	mu    sync.Mutex
	table map[string]map[string]types.AttributeValue

	// One-shot, key-matched failure injection -- the Go analogue of the TS
	// tests' payload-specific aws-sdk-client-mock override, used to force a
	// SPECIFIC PutItem/UpdateItem call to lose a conditional-write race
	// deterministically (see state_dynamo_test.go / sweeper_test.go).
	rejectPut    map[string]error
	rejectUpdate map[string]error
}

func newFakeDynamo() *fakeDynamo {
	return &fakeDynamo{
		table:        map[string]map[string]types.AttributeValue{},
		rejectPut:    map[string]error{},
		rejectUpdate: map[string]error{},
	}
}

func (f *fakeDynamo) clear() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.table = map[string]map[string]types.AttributeValue{}
	f.rejectPut = map[string]error{}
	f.rejectUpdate = map[string]error{}
}

// rejectNextPut forces the NEXT PutItem targeting (pk,sk) to fail with err,
// simulating a concurrent writer winning the race between a caller's read
// and its write (one-shot).
func (f *fakeDynamo) rejectNextPut(pk, sk string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rejectPut[fakeItemKey(pk, sk)] = err
}

// rejectNextUpdate forces the NEXT UpdateItem targeting (pk,sk) to fail with
// err (one-shot).
func (f *fakeDynamo) rejectNextUpdate(pk, sk string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rejectUpdate[fakeItemKey(pk, sk)] = err
}

func (f *fakeDynamo) get(pk, sk string) map[string]types.AttributeValue {
	f.mu.Lock()
	defer f.mu.Unlock()
	return cloneItem(f.table[fakeItemKey(pk, sk)])
}

func (f *fakeDynamo) has(pk, sk string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.table[fakeItemKey(pk, sk)]
	return ok
}

// GetItem implements DynamoDBAPI.
func (f *fakeDynamo) GetItem(_ context.Context, in *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := fakeItemKey(avString(in.Key["PK"]), avString(in.Key["SK"]))
	return &dynamodb.GetItemOutput{Item: cloneItem(f.table[k])}, nil
}

// PutItem implements DynamoDBAPI.
func (f *fakeDynamo) PutItem(_ context.Context, in *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := fakeItemKey(avString(in.Item["PK"]), avString(in.Item["SK"]))
	if err, ok := f.rejectPut[k]; ok {
		delete(f.rejectPut, k)
		return nil, err
	}
	existing := f.table[k]
	if !evalCondition(in.ConditionExpression, existing, in.ExpressionAttributeNames, in.ExpressionAttributeValues) {
		return nil, conditionalCheckFailed()
	}
	f.table[k] = cloneItem(in.Item)
	return &dynamodb.PutItemOutput{}, nil
}

// UpdateItem implements DynamoDBAPI. Supports exactly the two
// UpdateExpressions this adapter emits.
func (f *fakeDynamo) UpdateItem(_ context.Context, in *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	pk, sk := avString(in.Key["PK"]), avString(in.Key["SK"])
	k := fakeItemKey(pk, sk)
	if err, ok := f.rejectUpdate[k]; ok {
		delete(f.rejectUpdate, k)
		return nil, err
	}
	existing := f.table[k]
	if !evalCondition(in.ConditionExpression, existing, in.ExpressionAttributeNames, in.ExpressionAttributeValues) {
		return nil, conditionalCheckFailed()
	}

	expr := aws.ToString(in.UpdateExpression)
	switch expr {
	case "ADD seq :one":
		var seq int64
		if existing != nil {
			seq = avNumber(existing["seq"])
		}
		seq++
		next := cloneItem(existing)
		if next == nil {
			next = map[string]types.AttributeValue{"PK": in.Key["PK"], "SK": in.Key["SK"]}
		}
		next["seq"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(seq, 10)}
		f.table[k] = next
		return &dynamodb.UpdateItemOutput{Attributes: map[string]types.AttributeValue{"seq": next["seq"]}}, nil
	case "SET claimed_at = :now":
		next := cloneItem(existing)
		if next == nil {
			next = map[string]types.AttributeValue{"PK": in.Key["PK"], "SK": in.Key["SK"]}
		}
		next["claimed_at"] = in.ExpressionAttributeValues[":now"]
		f.table[k] = next
		return &dynamodb.UpdateItemOutput{Attributes: cloneItem(next)}, nil
	default:
		return nil, fmt.Errorf("fakeDynamo: unsupported UpdateExpression %q", expr)
	}
}

// DeleteItem implements DynamoDBAPI.
func (f *fakeDynamo) DeleteItem(_ context.Context, in *dynamodb.DeleteItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.table, fakeItemKey(avString(in.Key["PK"]), avString(in.Key["SK"])))
	return &dynamodb.DeleteItemOutput{}, nil
}

// Query implements DynamoDBAPI: either the due_at GSI (IndexName set) or a
// PK + begins_with(SK, prefix) table query.
func (f *fakeDynamo) Query(_ context.Context, in *dynamodb.QueryInput, _ ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if in.IndexName != nil {
		pk := avString(in.ExpressionAttributeValues[":pk"])
		max := avNumber(in.ExpressionAttributeValues[":now"])
		var items []map[string]types.AttributeValue
		for _, item := range f.table {
			gpk, ok := item["gsi1pk"].(*types.AttributeValueMemberS)
			if !ok || gpk.Value != pk {
				continue
			}
			gsk, ok := item["gsi1sk"].(*types.AttributeValueMemberN)
			if !ok {
				continue
			}
			v, err := strconv.ParseInt(gsk.Value, 10, 64)
			if err != nil || v > max {
				continue
			}
			items = append(items, cloneItem(item))
		}
		return &dynamodb.QueryOutput{Items: items}, nil
	}

	pk := avString(in.ExpressionAttributeValues[":pk"])
	prefix := avString(in.ExpressionAttributeValues[":skPrefix"])
	var items []map[string]types.AttributeValue
	for _, item := range f.table {
		ipk, ok := item["PK"].(*types.AttributeValueMemberS)
		if !ok || ipk.Value != pk {
			continue
		}
		isk, ok := item["SK"].(*types.AttributeValueMemberS)
		if !ok || !strings.HasPrefix(isk.Value, prefix) {
			continue
		}
		items = append(items, cloneItem(item))
	}
	sort.Slice(items, func(i, j int) bool {
		return avString(items[i]["SK"]) < avString(items[j]["SK"])
	})
	return &dynamodb.QueryOutput{Items: items}, nil
}

var _ DynamoDBAPI = (*fakeDynamo)(nil)

// ---- condition-expression evaluator (mirrors fake-dynamo.ts's evalCondition) ----

// evalCondition evaluates the small boolean-expression vocabulary this
// adapter emits: attribute_exists/attribute_not_exists, `A = :v`, `A < :v`,
// combined with AND/OR and parentheses. A nil/empty expression is always
// satisfied.
func evalCondition(exprPtr *string, existing map[string]types.AttributeValue, names map[string]string, values map[string]types.AttributeValue) bool {
	if exprPtr == nil || *exprPtr == "" {
		return true
	}
	return evalConditionStr(*exprPtr, existing, names, values)
}

func evalConditionStr(expr string, existing map[string]types.AttributeValue, names map[string]string, values map[string]types.AttributeValue) bool {
	s := stripOuterParens(expr)

	if ors := splitTop(s, " OR "); len(ors) > 1 {
		for _, p := range ors {
			if evalConditionStr(p, existing, names, values) {
				return true
			}
		}
		return false
	}
	if ands := splitTop(s, " AND "); len(ands) > 1 {
		for _, p := range ands {
			if !evalConditionStr(p, existing, names, values) {
				return false
			}
		}
		return true
	}

	p := strings.TrimSpace(s)
	switch {
	case strings.HasPrefix(p, "attribute_not_exists("):
		attr := resolveAttr(p[len("attribute_not_exists("):len(p)-1], names)
		if existing == nil {
			return true
		}
		_, ok := existing[attr]
		return !ok
	case strings.HasPrefix(p, "attribute_exists("):
		attr := resolveAttr(p[len("attribute_exists("):len(p)-1], names)
		if existing == nil {
			return false
		}
		_, ok := existing[attr]
		return ok
	case strings.Contains(p, "<"):
		rawAttr, rawVal, _ := strings.Cut(p, "<")
		attr := resolveAttr(strings.TrimSpace(rawAttr), names)
		if existing == nil {
			return false
		}
		ev, ok := existing[attr]
		if !ok {
			return false
		}
		cmp, ok := values[strings.TrimSpace(rawVal)]
		if !ok {
			return false
		}
		return avNumber(ev) < avNumber(cmp)
	case strings.Contains(p, "="):
		rawAttr, rawVal, _ := strings.Cut(p, "=")
		attr := resolveAttr(strings.TrimSpace(rawAttr), names)
		if existing == nil {
			return false
		}
		ev, ok := existing[attr]
		if !ok {
			return false
		}
		cmp, ok := values[strings.TrimSpace(rawVal)]
		if !ok {
			return false
		}
		return attrEqual(ev, cmp)
	default:
		return true
	}
}

func resolveAttr(raw string, names map[string]string) string {
	if strings.HasPrefix(raw, "#") {
		return names[raw]
	}
	return raw
}

func attrEqual(a, b types.AttributeValue) bool {
	switch av := a.(type) {
	case *types.AttributeValueMemberS:
		bv, ok := b.(*types.AttributeValueMemberS)
		return ok && av.Value == bv.Value
	case *types.AttributeValueMemberN:
		bv, ok := b.(*types.AttributeValueMemberN)
		return ok && av.Value == bv.Value
	case *types.AttributeValueMemberBOOL:
		bv, ok := b.(*types.AttributeValueMemberBOOL)
		return ok && av.Value == bv.Value
	default:
		return false
	}
}

// splitTop splits s on top-level (paren-depth-0) occurrences of op.
func splitTop(s, op string) []string {
	var parts []string
	depth := 0
	last := 0
	for i := 0; i < len(s); {
		switch {
		case s[i] == '(':
			depth++
			i++
		case s[i] == ')':
			depth--
			i++
		case depth == 0 && strings.HasPrefix(s[i:], op):
			parts = append(parts, s[last:i])
			i += len(op)
			last = i
		default:
			i++
		}
	}
	parts = append(parts, s[last:])
	return parts
}

// stripOuterParens removes a single layer of fully-wrapping parentheses,
// repeatedly.
func stripOuterParens(s string) string {
	s = strings.TrimSpace(s)
	for strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		depth := 0
		wraps := true
		for i := 0; i < len(s); i++ {
			switch s[i] {
			case '(':
				depth++
			case ')':
				depth--
				if depth == 0 && i < len(s)-1 {
					wraps = false
				}
			}
			if !wraps {
				break
			}
		}
		if !wraps {
			break
		}
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	return s
}

// fakeSQS is a minimal in-memory SQS client: records every SendMessage call
// and can be configured to fail the next N calls (used to simulate a
// send-after-claim failure in sweeper_test.go).
type fakeSQS struct {
	mu       sync.Mutex
	sent     []sqs.SendMessageInput
	failNext int
	failErr  error
}

func newFakeSQS() *fakeSQS {
	return &fakeSQS{}
}

func (f *fakeSQS) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = nil
	f.failNext = 0
	f.failErr = nil
}

// failNextSends makes the next n SendMessage calls fail with err.
func (f *fakeSQS) failNextSends(n int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext = n
	f.failErr = err
}

func (f *fakeSQS) calls() []sqs.SendMessageInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]sqs.SendMessageInput, len(f.sent))
	copy(out, f.sent)
	return out
}

// SendMessage implements SQSAPI.
func (f *fakeSQS) SendMessage(_ context.Context, in *sqs.SendMessageInput, _ ...func(*sqs.Options)) (*sqs.SendMessageOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext > 0 {
		f.failNext--
		return nil, f.failErr
	}
	f.sent = append(f.sent, *in)
	return &sqs.SendMessageOutput{MessageId: aws.String(fmt.Sprintf("fake-msg-%d", len(f.sent)))}, nil
}

var _ SQSAPI = (*fakeSQS)(nil)
