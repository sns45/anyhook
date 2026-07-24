# ADR 0001 — anyhook v0.1 open-decision resolutions

- **Status:** Accepted
- **Date:** 2026-07-24
- **Context:** Resolves the open decisions in `requirements.md` §14 (D1–D7) plus five additional ambiguities (A1–A5) surfaced while reconciling the spec against the actual `anyq` conventions before implementation begins.

This ADR is the authority for these choices. `requirements.md` §5/§6 were amended to reference the driver names agreed in A5.

---

## Named principles established here

### P1 — Naming by axis (transport drivers named by technology)

anyq drivers are named for the transport technology they wrap, not for a cloud vendor: `@anyq/sqs`, `@anyq/sns`, `@anyq/kafka`, `@anyq/rabbitmq`, and now `@anyq/cloudflare-queues`. A vendor "meta" name such as `@anyq/aws` or `@anyq/cloudflare` is rejected because one vendor exposes several distinct transports (AWS has SQS and SNS) and because the state axis is a separate concern that must not be smuggled into a transport package. Consequence: anyhook's Cloudflare adapter composes a transport package (`@anyq/cloudflare-queues`) and owns its Durable Object state separately; the two axes never merge into one package.

### P2 — The state store is the schedule

anyhook's retry timing is owned by the durable state layer, never by the transport. On Cloudflare the Durable Object's Alarms API is the scheduler; on AWS the DynamoDB item's `due_at` attribute (indexed by a GSI) plus a fixed-interval sweeper is the scheduler. anyq only moves a message once anyhook decides it is due. This keeps the two-layer retry separation (requirements §4) structurally enforced: anyq holds no endpoint retry state, and "when to attempt next" is always answered by reading anyhook's own state, on both runtimes.

---

## Requirements §14 decisions

### D1 — Language-first order: **TypeScript first through M3, Go parity at M4.** Accepted as proposed.
TypeScript is built through M1–M3; the Go port begins at M4. Matches npm/edge-first adoption priority.

### D2 — AWS scheduler mechanism: **900-second split, no delay-chaining.** Accepted with amendment.
- Retries whose delay is **≤ 900 seconds** use native SQS `DelaySeconds` (the hard SQS cap is 900s / 15 min).
- Retries whose delay is **> 900 seconds** are stored with a `due_at` timestamp and discovered by a **fixed 60-second cron sweeper** that queries a `due_at` GSI.
- **No delay-chaining anywhere.** The earlier §14 proposal to chain multiple 15-minute SQS delays for the long tail is explicitly dropped; the long tail is the sweeper's job.
- **DynamoDB TTL is garbage-collection only.** TTL reclaims terminal rows; it is never the scheduling trigger and carries no timing SLA (DynamoDB TTL deletion can lag by up to ~48h, which is unacceptable as a retry clock).
- The sweeper **claims a due row via a conditional write** (compare-and-set on a claim/lease attribute) *before* enqueuing to SQS, so two concurrent sweeper invocations cannot double-enqueue the same message.
- Governed by principle **P2**: the DynamoDB item is the schedule, mirroring how the DO Alarm is the schedule on Cloudflare.
- **FIFO / ordering caveat:** the delay-vs-sweeper split means a message delayed just under 900s and one delayed just over it can be enqueued out of their original schedule order, and the sweeper batches by due-time not by endpoint. This is consistent with requirements §8 ("ordering: best-effort per endpoint, not guaranteed in v0.1") and must stay documented; strict per-endpoint ordering remains gated on the post-v1 D3-ordering track.

### D3 — Cloudflare DO granularity: **one Durable Object per endpoint.** Accepted as proposed.
DO id derived from `${tenant}:${endpointId}`. Gives single-threaded per-endpoint consistency and per-endpoint fairness for free. Sharding many endpoints into one DO is rejected for v0.1 (loses intra-tenant fairness). Revisit only if endpoint counts stress DO limits/pricing.

### D4 — Circuit-breaker trip metric: **5 consecutive failed messages.** Accepted as proposed.
Consecutive-failure count over failure-rate-in-window, for v0.1 simplicity. Threshold and cooldown are configurable per engine and per endpoint.

### D5 — Go parity depth: **Go reaches M1 + M2 depth (core + one runtime).** Accepted as proposed.
Proposed runtime is AWS/Lambda-native. Portal and replay Go parity may trail the first public release.

### D6 — Portal UI: **API-only for v0.1.** Accepted as proposed.
No embeddable UI in v0.1; a reference minimal UI is post-v1.

### D7 — Repo structure: **monorepo, Go under `/go`.** Accepted as proposed.
Bun workspaces for the TypeScript packages; the Go module lives in the same repo under `/go`. Mirrors anyq exactly.

---

## Additional ambiguities (surfaced during planning)

### A5 — Missing anyq transport packages. **Resolved (blocks M2/M4 only).**
`requirements.md` §5/§6 assumed `@anyq/cloudflare` and `@anyq/aws`; neither exists. anyq's AWS transport is `@anyq/sqs` (+`@anyq/sns`) and anyq has no Cloudflare queue adapter at all. Resolution:
- **AWS:** `@anyhook/aws` composes the existing **`@anyq/sqs`**.
- **Cloudflare:** a new **`@anyq/cloudflare-queues`** driver is added to the anyq repo (technology-named per **P1**), **transport only** — a Cloudflare Queues producer plus a push-consumer binding. **Durable Objects do not enter anyq**; they remain anyhook's state layer.
- **Sequencing:** do **not** pause anyhook. anyhook **M1 proceeds now** on the in-memory transport. Building `@anyq/cloudflare-queues` is a **parallel task that gates only M2**.
- `requirements.md` §5/§6 amended to name `@anyq/cloudflare-queues` and `@anyq/sqs`.

### A1 — Adapter loading shape. **Resolved.**
The `adapter: () => import('@anyhook/cloudflare')` one-liner in §6 is not anyq's mechanism (anyq uses separate package + `createX` factory, no dynamic-import registry). anyhook honors the literal documented API: `WebhookEngine` accepts an `adapter` that is an adapter module or a `() => import()` thunk resolving to one; each adapter module exposes `createAdapter(config): { transport, state, scheduler, http }`. This preserves anyq's dependency-inversion spirit while keeping the spec's one-liner.

### A2 — Golden-file `-update` flag. **Resolved.**
No such pattern exists in anyq. Added as deliberate net-new for anyhook's **Go** signing/wire-format tests (`testdata/*.golden`, `-update` regenerates). The TypeScript side uses `bun test` inline assertions.

### A3 — Core SDK-freedom enforcement. **Resolved.**
anyq relies on core simply having empty `dependencies` (no CI gate). anyhook adds a `bun test` guard (`packages/core/test/no-sdk-deps.test.ts`): asserts `@anyhook/core` declares no runtime dependencies and that no forbidden SDK import (`@anyhook/cloudflare|aws`, `@anyq/*`, `@aws-sdk`, `cloudflare:`) appears under `packages/core/src`. Wired into CI as `bun run dep-check`.

### A4 — Release tooling. **Resolved.**
anyq ships libraries, not binaries, and has no goreleaser. anyhook v0.1 publishes via tag + module proxy (TS: `bun publish`; Go: tag + `proxy.golang.org` warm), matching anyq. goreleaser is revisited only if a CLI binary is later added.

---

## Consequences for the plan

- `docs/superpowers/plans/2026-07-24-anyhook-v0.1.md` is updated so M2 references `@anyq/cloudflare-queues` (with an explicit parallel anyq-driver task gating M2) and M4.4 reflects the 900s split + `due_at` GSI + 60s sweeper + conditional-write claim + TTL-as-GC (no delay-chaining).
- M1 is unblocked and begins immediately.
