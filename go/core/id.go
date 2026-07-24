package core

import (
	"crypto/sha256"
	"encoding/hex"
)

const idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// DefaultIDLength is the number of random characters NewID generates after the prefix.
const DefaultIDLength = 20

// NewID generates a prefixed id (e.g. "msg_9f3k..."). Entropy comes from the
// injected Rng (deterministic in tests).
func NewID(prefix string, rng Rng) string {
	b := make([]byte, DefaultIDLength)
	for i := range b {
		idx := int(rng.Next() * float64(len(idAlphabet)))
		if idx < 0 {
			idx = 0
		}
		if idx >= len(idAlphabet) {
			idx = idx % len(idAlphabet)
		}
		b[i] = idAlphabet[idx]
	}
	return prefix + "_" + string(b)
}

// DeriveIdempotencyKey derives a stable idempotency key from the event when
// the producer omits one. Same (tenant, type, payload) -> same key; any
// difference -> a different key.
func DeriveIdempotencyKey(e SendEvent) string {
	canonical := e.Tenant + " " + e.Type + " " + string(e.Payload)
	sum := sha256.Sum256([]byte(canonical))
	return "idem_" + hex.EncodeToString(sum[:])[:32]
}
