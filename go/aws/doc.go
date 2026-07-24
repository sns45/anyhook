/*
Package aws is the AWS-native Lambda/SQS/DynamoDB runtime for anyhook: it
implements the go/core ports (core.Transport, core.StateStore, core.Scheduler,
core.HTTPClient) against aws-sdk-go-v2 directly, and wires Lambda handler
factories for the ingest, delivery, and retry-sweeper entrypoints.

It mirrors packages/aws/src in the TypeScript implementation, which remains
the source of truth for behavior:

  - config.go      <-> config.ts       (Env/config, single-table key helpers)
  - transport_sqs.go <-> transport-sqs.ts (SQS Transport + per-record dispatch)
  - state_dynamo.go <-> state-dynamo.ts (single-table StateStore, G7 tenant scoping)
  - scheduler.go   <-> scheduler.ts    (900s SQS-delay vs. due_at row split, D2)
  - sweeper.go      <-> sweeper.ts      (lease-claim-before-send due_at sweep)
  - handlers.go     <-> handlers.ts     (Lambda entrypoints)
  - adapter.go      <-> adapter.ts      (port wiring)
  - http_fetch.go    <-> http-fetch.ts   (HTTPClient over net/http)

# Deliberate Go-side difference from TS: no cross-module anyq dependency

The TypeScript transport-sqs.ts composes @anyq/sqs's SQS producer for send()
(P1 in the TS design: transport drivers are named/owned by anyq, never
anyhook). This Go package does NOT take an equivalent dependency on anyq's Go
module (github.com/sns45/anyq/go/sqs). Instead transport_sqs.go calls
aws-sdk-go-v2's SQS client directly. This is a considered choice, not a
shortcut:

  - anyq's Go SQS producer/consumer types are built for anyq's own
    multi-broker Producer/Consumer contract (core.BaseProducer, structured
    logging, health checks, FIFO group/dedup handling). Pulling that whole
    surface in to get one SendMessage call is a heavier dependency edge than
    aws-sdk-go-v2 itself, and none of the extra surface is exercised here.
  - go/core's ports (Transport, StateStore, Scheduler, HTTPClient) are already
    plain Go interfaces satisfied structurally (no base-type wiring needed),
    so package aws only needs a `DynamoDBAPI`/`SQSAPI` slice of the real SDK
    clients -- trivial to fake in tests without anyq's own test doubles.
  - Behaviorally nothing changes: SendMessage today, durable at-least-once
    enqueue (G5), no in-process consumer loop (Lambda's SQS event-source
    mapping is already the push consumer, exactly as in TS). This is purely an
    implementation-dependency choice, not a wire-format or semantics choice --
    the Go SQS queue and the TS SQS queue are independently deployed per
    runtime and never need to interoperate at the message-bus layer.

# Fakes over LocalStack

Every port implementation here depends only on DynamoDBAPI/SQSAPI (this
package's own minimal client interfaces, see config.go), never on
*dynamodb.Client/*sqs.Client concretely. Tests inject in-memory fakes that
evaluate the small ConditionExpression/UpdateExpression vocabulary this
adapter actually emits (mirroring the TS test suite's fake-dynamo.ts) --
no LocalStack or other live AWS dependency is required to exercise the
conditional-write, lease-claim, or partial-batch-failure paths.
*/
package aws
