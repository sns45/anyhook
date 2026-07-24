# @anyhook/aws

AWS adapter for [anyhook](https://github.com/sns45/anyhook): run the outbound webhook engine on Lambda with **no server to operate**.

- **Transport:** [`@anyq/sqs`](https://www.npmjs.com/package/@anyq/sqs) over SQS (Lambda event-source consumer with partial-batch failures).
- **State:** a single **DynamoDB** table (`PK = TENANT#<tenant>`), conditional writes for circuit + idempotency.
- **Scheduler (D2):** retries ≤900s use native SQS `DelaySeconds`; longer retries persist a `due_at` row discovered by a fixed-interval **sweeper** that lease-claims each row before enqueue (crash-safe, at-least-once). DynamoDB TTL is GC-only.

## Install

```bash
npm i @anyhook/core @anyhook/aws
```

## Overview

Provides `createAdapter(config)` / `buildEngine(config)` and Lambda handler factories:

```ts
import { createIngestHandler, createDeliverHandler, createSweeperHandler } from '@anyhook/aws';

export const ingest = createIngestHandler(config);   // API Gateway → portal + send()
export const deliver = createDeliverHandler(config); // SQS event → engine.processMessage
export const sweep = createSweeperHandler(config);   // scheduled (~60s) → re-enqueue due retries
```

Point `config` at your DynamoDB table (with a `due_at` GSI) and SQS queue. Mount the portal behind your own auth (see the root `docs/composition-auth.md`). MIT.
