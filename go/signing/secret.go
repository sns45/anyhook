/*
Package signing implements Standard Webhooks (https://www.standardwebhooks.com)
HMAC-SHA256 signature generation and verification. It mirrors packages/signing
in the TypeScript implementation, which remains the source of truth for
behavior and wire format.

Sign/Verify are byte-for-byte compatible with the official standardwebhooks
libraries and with the TS @anyhook/signing package -- see the golden vector
test in sign_test.go.
*/
package signing

import (
	"crypto/rand"
	"encoding/base64"
	"strings"
)

// SecretPrefix is prepended to generated signing secrets.
const SecretPrefix = "whsec_"

// DefaultSecretBytes is the number of random bytes GenerateSecret encodes by default.
const DefaultSecretBytes = 24

// GenerateSecret generates a new Standard Webhooks-compatible signing secret:
// a whsec_-prefixed, base64-encoded random byte string. Pass 0 for the
// default (24 bytes).
func GenerateSecret(numBytes int) (string, error) {
	if numBytes <= 0 {
		numBytes = DefaultSecretBytes
	}
	b := make([]byte, numBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return SecretPrefix + base64.StdEncoding.EncodeToString(b), nil
}

// ParseSecret parses a webhook signing secret into raw HMAC key bytes.
// Strips the whsec_ prefix (if present) and base64-decodes the remainder.
func ParseSecret(secret string) ([]byte, error) {
	raw := strings.TrimPrefix(secret, SecretPrefix)
	return base64.StdEncoding.DecodeString(raw)
}
