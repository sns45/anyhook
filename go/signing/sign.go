package signing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Sign computes a single Standard Webhooks "v1,<sig>" signature.
//
//   - secret: the signing secret (with or without the whsec_ prefix)
//   - id: the webhook delivery id
//   - timestamp: the delivery timestamp
//   - payload: the exact raw JSON payload string
func Sign(secret string, id string, timestamp time.Time, payload string) (string, error) {
	timestampSeconds := timestamp.Unix()
	signedContent := fmt.Sprintf("%s.%d.%s", id, timestampSeconds, payload)
	key, err := ParseSecret(secret)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signedContent))
	digest := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return "v1," + digest, nil
}

// Signer computes Standard Webhooks delivery headers, optionally signing with
// multiple secrets for zero-downtime key rotation.
type Signer struct {
	secrets []string
}

// NewSigner builds a Signer over one or more secrets (space-joined in the
// webhook-signature header, one v1,<sig> entry per secret).
func NewSigner(secrets ...string) *Signer {
	return &Signer{secrets: secrets}
}

// Headers computes the webhook-id, webhook-timestamp, and webhook-signature headers.
//
//   - id: the webhook delivery id
//   - payload: the exact raw JSON payload string
//   - timestamp: the delivery timestamp
func (s *Signer) Headers(id string, payload string, timestamp time.Time) (map[string]string, error) {
	timestampSeconds := timestamp.Unix()
	sigs := make([]string, 0, len(s.secrets))
	for _, secret := range s.secrets {
		sig, err := Sign(secret, id, timestamp, payload)
		if err != nil {
			return nil, err
		}
		sigs = append(sigs, sig)
	}
	return map[string]string{
		"webhook-id":        id,
		"webhook-timestamp": strconv.FormatInt(timestampSeconds, 10),
		"webhook-signature": strings.Join(sigs, " "),
	}, nil
}

// CoreSigner adapts Signer to the shape of anyhook-core's WebhookSigner port
// (Sign(secrets []string, id, payload string, timestampMs int64) map[string]string).
// Package core is never imported here (by design, G1): Go's structural
// interface satisfaction means CoreSigner implements core.WebhookSigner
// purely by matching its method signature, the same "structural" trick the
// TS package uses to avoid a hard dependency edge on @anyhook/core.
//
// Sign is infallible by port contract (mirrors the TS synchronous, non-throwing
// port): a malformed secret (e.g. invalid base64) is a configuration error
// that should be caught at secret-creation/rotation time, not at delivery
// time, so this adapter degrades to an empty signature for that entry rather
// than panicking or returning an error.
type CoreSigner struct{}

// Sign implements the core.WebhookSigner port shape.
func (CoreSigner) Sign(secrets []string, id string, payload string, timestampMs int64) map[string]string {
	ts := time.UnixMilli(timestampMs)
	hdrs, err := NewSigner(secrets...).Headers(id, payload, ts)
	if err != nil {
		return map[string]string{
			"webhook-id":        id,
			"webhook-timestamp": strconv.FormatInt(ts.Unix(), 10),
			"webhook-signature": "",
		}
	}
	return hdrs
}
