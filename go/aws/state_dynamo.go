package aws

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/sns45/anyhook/go/core"
	"github.com/sns45/anyhook/go/signing"
)

// CircuitWriteConflictError is returned by DynamoStateStore.PutCircuit when a
// concurrent writer already advanced the circuit's version (optimistic
// concurrency, D2). Mirrors TS CircuitWriteConflictError.
type CircuitWriteConflictError struct {
	Tenant     string
	EndpointID string
}

// Error implements the error interface.
func (e *CircuitWriteConflictError) Error() string {
	return fmt.Sprintf("circuit write conflict for tenant=%s endpointId=%s", e.Tenant, e.EndpointID)
}

// storedEvent is the idempotency row shape for an IDEM# key.
type storedEvent struct {
	EventID      string
	MessageCount int
}

// dlqRow is the row shape for a DLQ# entry: a dead-lettered message plus the
// reason it was dead-lettered.
type dlqRow struct {
	Message core.Message
	Reason  core.DlqReason
}

// DynamoStateStore is core.StateStore on a single DynamoDB table
// (PK = TENANT#<tenant>, item-type-prefixed SK -- see config.go for the full
// key design). Every method takes/derives tenant first and every key is
// built from it, so no query can address another tenant's rows (G7).
// Idempotency uses a conditional PutItem (attribute_not_exists(SK)) so a
// racing duplicate RecordEvent is detected atomically.
//
// Circuit writes carry an internal _version attribute checked via
// ConditionExpression. NOTE: this guards only PutCircuit's OWN read->write
// window, not the engine's full GetCircuit -> OnFailure -> PutCircuit cycle
// (GetCircuit intentionally strips _version, so the engine can't round-trip
// it). Under heavy same-endpoint concurrency a consecutive-failure increment
// can therefore still be lost -- bounded impact: the breaker may trip
// slightly late, never data corruption or a miscount toward a false trip. A
// detected conflict returns *CircuitWriteConflictError, which the SQS
// consumer (via a returned error from ProcessMessage) turns into a
// batchItemFailures redelivery (at-least-once, self-healing). Mirrors TS
// DynamoStateStore (state-dynamo.ts).
type DynamoStateStore struct {
	env Env
}

// NewDynamoStateStore builds a DynamoStateStore over env.
func NewDynamoStateStore(env Env) *DynamoStateStore {
	return &DynamoStateStore{env: env}
}

func (s *DynamoStateStore) key(tenant, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		"PK": &types.AttributeValueMemberS{Value: TenantPK(tenant)},
		"SK": &types.AttributeValueMemberS{Value: sk},
	}
}

// ---- idempotency ----

// RecordEvent implements core.StateStore.
func (s *DynamoStateStore) RecordEvent(ctx context.Context, tenant, eventID, idemKey string) (core.EventRecordResult, error) {
	key := s.key(tenant, IdemSK(idemKey))
	item, err := marshalItem(storedEvent{EventID: eventID, MessageCount: 0})
	if err != nil {
		return core.EventRecordResult{}, err
	}
	item["PK"], item["SK"] = key["PK"], key["SK"]

	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.env.TableName),
		Item:                item,
		ConditionExpression: aws.String("attribute_not_exists(SK)"),
	})
	if err == nil {
		return core.EventRecordResult{IsNew: true, EventID: eventID, MessageCount: 0}, nil
	}
	if !isConditionalCheckFailed(err) {
		return core.EventRecordResult{}, err
	}
	// Lost the race: another writer's PutItem committed first. Read it back
	// for the original receipt.
	existing, gerr := s.env.DDB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(s.env.TableName), Key: key})
	if gerr != nil {
		return core.EventRecordResult{}, gerr
	}
	if existing.Item == nil {
		// Vanishingly unlikely delete race; treat as new.
		return core.EventRecordResult{IsNew: true, EventID: eventID, MessageCount: 0}, nil
	}
	rec, uerr := unmarshalItem[storedEvent](existing.Item)
	if uerr != nil {
		return core.EventRecordResult{}, uerr
	}
	return core.EventRecordResult{IsNew: false, EventID: rec.EventID, MessageCount: rec.MessageCount}, nil
}

// FinalizeEvent implements core.StateStore.
func (s *DynamoStateStore) FinalizeEvent(ctx context.Context, tenant, idemKey, eventID string, messageCount int) error {
	key := s.key(tenant, IdemSK(idemKey))
	item, err := marshalItem(storedEvent{EventID: eventID, MessageCount: messageCount})
	if err != nil {
		return err
	}
	item["PK"], item["SK"] = key["PK"], key["SK"]
	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: item})
	return err
}

// ---- endpoints ----

// CreateEndpoint implements core.StateStore.
func (s *DynamoStateStore) CreateEndpoint(ctx context.Context, in core.CreateEndpointInput) (core.CreateEndpointResult, error) {
	secret, err := signing.GenerateSecret(0)
	if err != nil {
		return core.CreateEndpointResult{}, err
	}
	id, err := newUUIDv4()
	if err != nil {
		return core.CreateEndpointResult{}, err
	}
	ep := core.Endpoint{
		EndpointID:  id,
		Tenant:      in.Tenant,
		URL:         in.URL,
		EventTypes:  append([]string(nil), in.EventTypes...),
		Description: in.Description,
		Disabled:    false,
		RateLimit:   in.RateLimit,
		CreatedAt:   time.Now().UnixMilli(),
		Secrets:     []string{secret},
	}
	if err := s.putEndpointItem(ctx, ep); err != nil {
		return core.CreateEndpointResult{}, err
	}
	return core.CreateEndpointResult{Endpoint: ep, Secret: secret}, nil
}

func (s *DynamoStateStore) putEndpointItem(ctx context.Context, ep core.Endpoint) error {
	item, err := marshalItem(ep)
	if err != nil {
		return err
	}
	key := s.key(ep.Tenant, EndpointSK(ep.EndpointID))
	item["PK"], item["SK"] = key["PK"], key["SK"]
	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: item})
	return err
}

// GetEndpoint implements core.StateStore.
func (s *DynamoStateStore) GetEndpoint(ctx context.Context, tenant, endpointID string) (*core.Endpoint, error) {
	res, err := s.env.DDB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(s.env.TableName), Key: s.key(tenant, EndpointSK(endpointID))})
	if err != nil {
		return nil, err
	}
	if res.Item == nil {
		return nil, nil
	}
	ep, err := unmarshalItem[core.Endpoint](res.Item)
	if err != nil {
		return nil, err
	}
	return &ep, nil
}

// ListEndpoints implements core.StateStore.
func (s *DynamoStateStore) ListEndpoints(ctx context.Context, tenant string) ([]core.Endpoint, error) {
	items, err := queryAll(ctx, s.env, TenantPK(tenant), EndpointSK(""))
	if err != nil {
		return nil, err
	}
	out := make([]core.Endpoint, 0, len(items))
	for _, item := range items {
		ep, err := unmarshalItem[core.Endpoint](item)
		if err != nil {
			return nil, err
		}
		out = append(out, ep)
	}
	return out, nil
}

// MatchEndpoints implements core.StateStore.
func (s *DynamoStateStore) MatchEndpoints(ctx context.Context, tenant, eventType string) ([]core.Endpoint, error) {
	all, err := s.ListEndpoints(ctx, tenant)
	if err != nil {
		return nil, err
	}
	out := make([]core.Endpoint, 0, len(all))
	for _, ep := range all {
		if core.Subscribes(ep, eventType) {
			out = append(out, ep)
		}
	}
	return out, nil
}

// UpdateEndpoint implements core.StateStore.
func (s *DynamoStateStore) UpdateEndpoint(ctx context.Context, tenant, endpointID string, patch core.UpdateEndpointPatch) (core.Endpoint, error) {
	existing, err := s.GetEndpoint(ctx, tenant, endpointID)
	if err != nil {
		return core.Endpoint{}, err
	}
	if existing == nil {
		return core.Endpoint{}, fmt.Errorf("endpoint not found: %s", endpointID)
	}
	updated := *existing
	if patch.URL != nil {
		updated.URL = *patch.URL
	}
	if patch.EventTypes != nil {
		updated.EventTypes = append([]string(nil), (*patch.EventTypes)...)
	}
	if patch.Disabled != nil {
		updated.Disabled = *patch.Disabled
	}
	if err := s.putEndpointItem(ctx, updated); err != nil {
		return core.Endpoint{}, err
	}
	return updated, nil
}

// RotateSecret implements core.StateStore. Keeps the previous primary secret
// valid during a dual-secret rotation window.
func (s *DynamoStateStore) RotateSecret(ctx context.Context, tenant, endpointID string) (string, error) {
	existing, err := s.GetEndpoint(ctx, tenant, endpointID)
	if err != nil {
		return "", err
	}
	if existing == nil {
		return "", fmt.Errorf("endpoint not found: %s", endpointID)
	}
	secret, err := signing.GenerateSecret(0)
	if err != nil {
		return "", err
	}
	updated := *existing
	updated.Secrets = []string{secret, existing.Secrets[0]}
	if err := s.putEndpointItem(ctx, updated); err != nil {
		return "", err
	}
	return secret, nil
}

// DeleteEndpoint implements core.StateStore.
func (s *DynamoStateStore) DeleteEndpoint(ctx context.Context, tenant, endpointID string) error {
	_, err := s.env.DDB.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: aws.String(s.env.TableName), Key: s.key(tenant, EndpointSK(endpointID))})
	return err
}

// ---- messages / attempts ----

// PutMessage implements core.StateStore.
func (s *DynamoStateStore) PutMessage(ctx context.Context, m core.Message) error {
	item, err := marshalItem(m)
	if err != nil {
		return err
	}
	key := s.key(m.Tenant, MessageSK(m.MessageID))
	item["PK"], item["SK"] = key["PK"], key["SK"]
	if _, err := s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: item}); err != nil {
		return err
	}
	// Message->endpoint index: not needed to READ in this adapter (messages
	// are already keyed by tenant+messageId, so GetMessage is a direct
	// GetItem), but kept write-only as documented in config.go -- a seam for
	// a future "messages by endpoint" GSI without a migration.
	idxItem, err := marshalItem(struct{ EndpointID string }{EndpointID: m.EndpointID})
	if err != nil {
		return err
	}
	idxKey := s.key(m.Tenant, MessageIndexSK(m.MessageID))
	idxItem["PK"], idxItem["SK"] = idxKey["PK"], idxKey["SK"]
	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: idxItem})
	return err
}

// GetMessage implements core.StateStore.
func (s *DynamoStateStore) GetMessage(ctx context.Context, tenant, messageID string) (*core.Message, error) {
	res, err := s.env.DDB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(s.env.TableName), Key: s.key(tenant, MessageSK(messageID))})
	if err != nil {
		return nil, err
	}
	if res.Item == nil {
		return nil, nil
	}
	m, err := unmarshalItem[core.Message](res.Item)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// nextSeq atomically increments and returns a per-(tenant,sk) counter (used
// for the attempt seq and the DLQ seq).
func (s *DynamoStateStore) nextSeq(ctx context.Context, tenant, sk string) (int64, error) {
	out, err := s.env.DDB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.env.TableName),
		Key:                       s.key(tenant, sk),
		UpdateExpression:          aws.String("ADD seq :one"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":one": &types.AttributeValueMemberN{Value: "1"}},
		ReturnValues:              types.ReturnValueUpdatedNew,
	})
	if err != nil {
		return 0, err
	}
	n, ok := out.Attributes["seq"].(*types.AttributeValueMemberN)
	if !ok {
		return 0, fmt.Errorf("aws.DynamoStateStore.nextSeq: missing/invalid seq attribute")
	}
	return strconv.ParseInt(n.Value, 10, 64)
}

// AppendAttempt implements core.StateStore.
func (s *DynamoStateStore) AppendAttempt(ctx context.Context, a core.Attempt) error {
	seq, err := s.nextSeq(ctx, a.Tenant, AttemptCounterSK(a.MessageID))
	if err != nil {
		return err
	}
	item, err := marshalItem(a)
	if err != nil {
		return err
	}
	key := s.key(a.Tenant, AttemptSK(a.MessageID, seq))
	item["PK"], item["SK"] = key["PK"], key["SK"]
	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: item})
	return err
}

func (s *DynamoStateStore) listAttempts(ctx context.Context, tenant, messageID string) ([]core.Attempt, error) {
	items, err := queryAll(ctx, s.env, TenantPK(tenant), AttemptSKPrefix(messageID))
	if err != nil {
		return nil, err
	}
	out := make([]core.Attempt, 0, len(items))
	for _, item := range items {
		a, err := unmarshalItem[core.Attempt](item)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

// ListDeliveries implements core.StateStore.
func (s *DynamoStateStore) ListDeliveries(ctx context.Context, q core.DeliveryQuery) ([]core.DeliveryRow, error) {
	items, err := queryAll(ctx, s.env, TenantPK(q.Tenant), MessageSK(""))
	if err != nil {
		return nil, err
	}
	rows := make([]core.Message, 0, len(items))
	for _, item := range items {
		m, err := unmarshalItem[core.Message](item)
		if err != nil {
			return nil, err
		}
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
		attempts, err := s.listAttempts(ctx, q.Tenant, m.MessageID)
		if err != nil {
			return nil, err
		}
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

// ---- circuit (optimistic concurrency via _version, D2) ----

// GetCircuit implements core.StateStore.
func (s *DynamoStateStore) GetCircuit(ctx context.Context, tenant, endpointID string) (core.CircuitRecord, error) {
	res, err := s.env.DDB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(s.env.TableName), Key: s.key(tenant, CircuitSK(endpointID))})
	if err != nil {
		return core.CircuitRecord{}, err
	}
	if res.Item == nil {
		return core.InitialCircuit(core.DefaultCooldownMs), nil
	}
	return unmarshalItem[core.CircuitRecord](res.Item)
}

// PutCircuit implements core.StateStore.
func (s *DynamoStateStore) PutCircuit(ctx context.Context, tenant, endpointID string, rec core.CircuitRecord) error {
	key := s.key(tenant, CircuitSK(endpointID))
	current, err := s.env.DDB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(s.env.TableName), Key: key})
	if err != nil {
		return err
	}
	var expectedVersion *int64
	if current.Item != nil {
		if v, ok := attrInt64(current.Item, "_version"); ok {
			expectedVersion = &v
		}
	}
	nextVersion := int64(1)
	if expectedVersion != nil {
		nextVersion = *expectedVersion + 1
	}

	item, err := marshalItem(rec)
	if err != nil {
		return err
	}
	item["PK"], item["SK"] = key["PK"], key["SK"]
	item["_version"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(nextVersion, 10)}

	input := &dynamodb.PutItemInput{
		TableName:                aws.String(s.env.TableName),
		Item:                     item,
		ExpressionAttributeNames: map[string]string{"#v": "_version"},
	}
	if expectedVersion == nil {
		input.ConditionExpression = aws.String("attribute_not_exists(#v)")
	} else {
		input.ConditionExpression = aws.String("#v = :expected")
		input.ExpressionAttributeValues = map[string]types.AttributeValue{
			":expected": &types.AttributeValueMemberN{Value: strconv.FormatInt(*expectedVersion, 10)},
		}
	}

	_, err = s.env.DDB.PutItem(ctx, input)
	if err != nil {
		if isConditionalCheckFailed(err) {
			return &CircuitWriteConflictError{Tenant: tenant, EndpointID: endpointID}
		}
		return err
	}
	return nil
}

// ---- rate limiting (§10) ----

// GetRateBucket implements core.StateStore.
func (s *DynamoStateStore) GetRateBucket(ctx context.Context, tenant, endpointID string) (*core.RateBucket, error) {
	res, err := s.env.DDB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(s.env.TableName), Key: s.key(tenant, RateSK(endpointID))})
	if err != nil {
		return nil, err
	}
	if res.Item == nil {
		return nil, nil
	}
	b, err := unmarshalItem[core.RateBucket](res.Item)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// PutRateBucket implements core.StateStore. An approximate limiter: a plain
// put is sufficient (no OCC needed -- a lost update at most lets one extra
// delivery through, which throttling tolerates).
func (s *DynamoStateStore) PutRateBucket(ctx context.Context, tenant, endpointID string, bucket core.RateBucket) error {
	item, err := marshalItem(bucket)
	if err != nil {
		return err
	}
	key := s.key(tenant, RateSK(endpointID))
	item["PK"], item["SK"] = key["PK"], key["SK"]
	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: item})
	return err
}

// ---- DLQ ----

// AddToDlq implements core.StateStore.
func (s *DynamoStateStore) AddToDlq(ctx context.Context, m core.Message, reason core.DlqReason) error {
	seq, err := s.nextSeq(ctx, m.Tenant, DlqCounterSK())
	if err != nil {
		return err
	}
	item, err := marshalItem(dlqRow{Message: m, Reason: reason})
	if err != nil {
		return err
	}
	key := s.key(m.Tenant, DlqSK(seq))
	item["PK"], item["SK"] = key["PK"], key["SK"]
	_, err = s.env.DDB.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.env.TableName), Item: item})
	return err
}

// ListDlq implements core.StateStore.
func (s *DynamoStateStore) ListDlq(ctx context.Context, tenant, endpointID string) ([]core.DlqEntry, error) {
	items, err := queryAll(ctx, s.env, TenantPK(tenant), "DLQ#")
	if err != nil {
		return nil, err
	}
	out := make([]core.DlqEntry, 0, len(items))
	for _, item := range items {
		row, err := unmarshalItem[dlqRow](item)
		if err != nil {
			return nil, err
		}
		if endpointID != "" && row.Message.EndpointID != endpointID {
			continue
		}
		out = append(out, core.DlqEntry{Message: row.Message, Reason: row.Reason})
	}
	return out, nil
}

var _ core.StateStore = (*DynamoStateStore)(nil)
