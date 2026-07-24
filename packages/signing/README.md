# @anyhook/signing

[Standard Webhooks](https://www.standardwebhooks.com) sign/verify primitives for [anyhook](https://github.com/sns45/anyhook) — usable standalone. Wire-compatible with the official `standardwebhooks` library (verified by a cross-library test).

## Install

```bash
npm i @anyhook/signing
```

## Overview

- `generateSecret(bytes?)` → `whsec_`-prefixed base64 secret (≥24 bytes entropy).
- `sign(secret, id, timestamp, payload)` → `v1,<base64 HMAC-SHA256>`.
- `Signer` — multi-secret signing (space-joined) for zero-downtime key rotation.
- `verify(headers, rawBody, secret)` — throws `WebhookVerificationError`; ±5min timestamp tolerance; timing-safe compare.
- `createSigner()` — a `WebhookSigner` implementation to inject into `@anyhook/core` (keeps core zero-dep).

```ts
import { Signer, verify } from '@anyhook/signing';

const headers = new Signer(secret).headers('msg_1', JSON.stringify(payload));
const body = verify(headers, rawBody, secret); // parsed JSON, or throws
```

Signed content is `` `${webhook-id}.${timestampSeconds}.${rawPayload}` ``; the key is the base64-decoded secret after stripping `whsec_`. MIT.
