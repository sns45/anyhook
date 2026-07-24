package aws

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// DefaultDueAtIndexName names the GSI indexing due_at (partition key gsi1pk,
// sort key gsi1sk) that RunSweeper queries. Mirrors TS DEFAULT_DUE_AT_INDEX_NAME.
const DefaultDueAtIndexName = "due_at-index"

// SchedGSIPK is the constant GSI partition key value every SCHED# row is
// written under. A single logical partition is an accepted v0.1 scale
// tradeoff (see sweeper.go); revisit with a bucketed key if volume demands
// it. Mirrors TS SCHED_GSI_PK.
const SchedGSIPK = "SCHED"

// SqsMaxDelayMs is SQS's hard cap on native DelaySeconds. Retries due sooner
// than this use SQS delay directly (D2). Mirrors TS SQS_MAX_DELAY_MS.
const SqsMaxDelayMs int64 = 900_000

// SchedTTLGraceSeconds is how long a swept SCHED# row survives before
// DynamoDB TTL reclaims it. GC only -- never the scheduling trigger (D2).
// Mirrors TS SCHED_TTL_GRACE_SECONDS.
const SchedTTLGraceSeconds int64 = 7 * 24 * 60 * 60

// SweeperLeaseSeconds is the lease duration for a sweeper claim. A claim
// stamps claimed_at; a row whose claim is older than this is re-claimable.
// This makes the claim crash/failure-safe: if SendMessage fails after a
// successful claim, the lease expires and a later sweep re-enqueues the
// retry rather than losing it (G5). Must exceed the sweep interval (60s) so
// an in-flight claim isn't re-swept early. Mirrors TS SWEEPER_LEASE_SECONDS.
const SweeperLeaseSeconds int64 = 300

// MaxPayloadBytes is the max event payload for the AWS runtime. The SQS
// message body is the JSON encoding of a Message -- the payload PLUS the
// envelope (ids, tenant, timestamps) -- and SQS caps a body at 256KB. Cap the
// payload below that (~200KB) so a near-limit payload plus envelope still
// fits and enqueues. Mirrors TS AWS_MAX_PAYLOAD_BYTES.
const MaxPayloadBytes int64 = 200 * 1024

// DynamoDBAPI is the subset of *dynamodb.Client this package calls, expressed
// as an interface so tests can inject an in-memory fake instead of a live
// DynamoDB table (see doc.go "Fakes over LocalStack"). The real
// *dynamodb.Client satisfies this interface as-is.
type DynamoDBAPI interface {
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(ctx context.Context, params *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	DeleteItem(ctx context.Context, params *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
}

// SQSAPI is the subset of *sqs.Client this package calls. The real
// *sqs.Client satisfies this interface as-is.
type SQSAPI interface {
	SendMessage(ctx context.Context, params *sqs.SendMessageInput, optFns ...func(*sqs.Options)) (*sqs.SendMessageOutput, error)
}

// Config is deploy-time configuration for the AWS adapter. TableName/QueueURL
// name the single DynamoDB table and SQS queue this adapter owns. DDB/SQS can
// be pre-built (or faked) and injected directly -- required for tests and
// useful for a custom endpoint (e.g. LocalStack) or credential chain.
type Config struct {
	TableName string
	QueueURL  string
	// DueAtIndexName names the GSI indexing due_at (partition key gsi1pk,
	// sort key gsi1sk). "" -> DefaultDueAtIndexName.
	DueAtIndexName string
	Region         string
	// Endpoint overrides both clients' endpoint (e.g. LocalStack
	// http://localhost:4566). Ignored for a client that was injected directly.
	Endpoint string
	// DDB is a pre-built (or faked) DynamoDB client. nil -> built from
	// Region/Endpoint via the default AWS credential chain.
	DDB DynamoDBAPI
	// SQS is a pre-built (or faked) SQS client. nil -> built from
	// Region/Endpoint via the default AWS credential chain.
	SQS SQSAPI
}

// Env is the resolved runtime environment: config plus the concrete client
// interfaces every port implementation in this package shares.
type Env struct {
	TableName      string
	QueueURL       string
	DueAtIndexName string
	DDB            DynamoDBAPI
	SQS            SQSAPI
}

// ResolveEnv builds the resolved Env from Config, constructing default SDK
// clients only for those not already injected.
func ResolveEnv(ctx context.Context, cfg Config) (Env, error) {
	dueAtIndexName := cfg.DueAtIndexName
	if dueAtIndexName == "" {
		dueAtIndexName = DefaultDueAtIndexName
	}

	env := Env{
		TableName:      cfg.TableName,
		QueueURL:       cfg.QueueURL,
		DueAtIndexName: dueAtIndexName,
		DDB:            cfg.DDB,
		SQS:            cfg.SQS,
	}
	if env.DDB != nil && env.SQS != nil {
		return env, nil
	}

	var loadOpts []func(*awsconfig.LoadOptions) error
	if cfg.Region != "" {
		loadOpts = append(loadOpts, awsconfig.WithRegion(cfg.Region))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return Env{}, fmt.Errorf("aws.ResolveEnv: %w", err)
	}

	if env.DDB == nil {
		env.DDB = dynamodb.NewFromConfig(awsCfg, func(o *dynamodb.Options) {
			if cfg.Endpoint != "" {
				o.BaseEndpoint = aws.String(cfg.Endpoint)
			}
		})
	}
	if env.SQS == nil {
		env.SQS = sqs.NewFromConfig(awsCfg, func(o *sqs.Options) {
			if cfg.Endpoint != "" {
				o.BaseEndpoint = aws.String(cfg.Endpoint)
			}
		})
	}
	return env, nil
}

// ConfigFromEnv reads Config from the conventional Lambda environment
// variables (used by the deployed handlers' entrypoint). getenv is typically
// os.Getenv; injected so tests don't need real process env vars.
func ConfigFromEnv(getenv func(string) string) (Config, error) {
	tableName := getenv("ANYHOOK_TABLE_NAME")
	queueURL := getenv("ANYHOOK_QUEUE_URL")
	if tableName == "" {
		return Config{}, fmt.Errorf("aws.ConfigFromEnv: ANYHOOK_TABLE_NAME is required")
	}
	if queueURL == "" {
		return Config{}, fmt.Errorf("aws.ConfigFromEnv: ANYHOOK_QUEUE_URL is required")
	}
	return Config{
		TableName:      tableName,
		QueueURL:       queueURL,
		DueAtIndexName: getenv("ANYHOOK_DUE_AT_INDEX_NAME"),
		Region:         getenv("AWS_REGION"),
	}, nil
}

// ---- Single-table key helpers (shared by state_dynamo.go / scheduler.go / sweeper.go) ----
//
// PK = "TENANT#<tenant>" for every item (G7: every query is tenant-partitioned by construction).
// SK is prefixed by item type:
//
//	EP#<endpointId>          endpoint
//	MSG#<messageId>          message
//	MIDX#<messageId>         message->endpoint index (write-only seam for a future by-endpoint GSI)
//	ATT#<messageId>#<seq>    one delivery attempt (zero-padded seq preserves insertion order on read)
//	ATTCOUNT#<messageId>     atomic attempt-sequence counter
//	CIRCUIT#<endpointId>     circuit-breaker record (+ internal _version for optimistic concurrency)
//	RATE#<endpointId>        rate-limit token bucket (§10)
//	DLQ#<seq>                one dead-lettered message (zero-padded global-per-tenant seq)
//	DLQSEQ                   atomic DLQ-sequence counter
//	IDEM#<idemKey>           idempotency record
//	SCHED#<messageId>        a scheduled-in-the-future retry, discovered via the due_at GSI

// TenantPK is the partition key every item for tenant lives under (G7:
// tenant scoping by construction).
func TenantPK(tenant string) string { return "TENANT#" + tenant }

// EndpointSK is the sort key for an endpoint row.
func EndpointSK(endpointID string) string { return "EP#" + endpointID }

// MessageSK is the sort key for a message row.
func MessageSK(messageID string) string { return "MSG#" + messageID }

// MessageIndexSK is the sort key for a message's write-only endpoint index row.
func MessageIndexSK(messageID string) string { return "MIDX#" + messageID }

// AttemptSK is the sort key for one delivery attempt (zero-padded seq
// preserves insertion order on a begins_with query).
func AttemptSK(messageID string, seq int64) string {
	return fmt.Sprintf("ATT#%s#%010d", messageID, seq)
}

// AttemptSKPrefix is the sort-key prefix for querying every attempt of a message.
func AttemptSKPrefix(messageID string) string { return "ATT#" + messageID + "#" }

// AttemptCounterSK is the sort key for a message's atomic attempt-sequence counter.
func AttemptCounterSK(messageID string) string { return "ATTCOUNT#" + messageID }

// CircuitSK is the sort key for an endpoint's circuit-breaker record.
func CircuitSK(endpointID string) string { return "CIRCUIT#" + endpointID }

// RateSK is the sort key for an endpoint's rate-limit token bucket.
func RateSK(endpointID string) string { return "RATE#" + endpointID }

// DlqSK is the sort key for one dead-lettered message (zero-padded global-per-tenant seq).
func DlqSK(seq int64) string { return fmt.Sprintf("DLQ#%016d", seq) }

// DlqCounterSK is the sort key for the tenant's atomic DLQ-sequence counter.
func DlqCounterSK() string { return "DLQSEQ" }

// IdemSK is the sort key for an idempotency record.
func IdemSK(idemKey string) string { return "IDEM#" + idemKey }

// SchedSK is the sort key for a scheduled-in-the-future retry row.
func SchedSK(messageID string) string { return "SCHED#" + messageID }
