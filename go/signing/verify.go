package signing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// ToleranceSeconds is the allowed clock-skew window for Verify.
const ToleranceSeconds = 300

// WebhookVerificationError is returned when a webhook delivery fails
// signature or timestamp verification.
type WebhookVerificationError struct {
	msg string
}

func (e *WebhookVerificationError) Error() string { return e.msg }

func verificationErr(msg string) error { return &WebhookVerificationError{msg: msg} }

func lowercaseHeaders(headers map[string]string) map[string]string {
	out := make(map[string]string, len(headers))
	for k, v := range headers {
		out[strings.ToLower(k)] = v
	}
	return out
}

func extractSignatureDigest(entry string) (string, bool) {
	scheme, digest, found := strings.Cut(entry, ",")
	if !found || scheme != "v1" || digest == "" {
		return "", false
	}
	return digest, true
}

func timingSafeEqualBase64(a, b string) bool {
	bufA, errA := base64.StdEncoding.DecodeString(a)
	bufB, errB := base64.StdEncoding.DecodeString(b)
	if errA != nil || errB != nil {
		return false
	}
	if len(bufA) != len(bufB) {
		return false
	}
	return hmac.Equal(bufA, bufB)
}

// Verify verifies a Standard Webhooks delivery and returns the raw, verified
// body bytes.
//
//   - headers: the delivery headers (keys matched case-insensitively)
//   - rawBody: the exact raw request body string
//   - secret: the signing secret (with or without the whsec_ prefix)
//
// Returns a *WebhookVerificationError if headers are missing, the timestamp
// is outside tolerance, or no signature matches.
//
// Unlike the TS verify() (which returns the JSON.parse()'d body as `unknown`),
// Verify returns the raw validated bytes -- more idiomatic Go, letting the
// caller json.Unmarshal into whatever type it expects.
func Verify(headers map[string]string, rawBody string, secret string) ([]byte, error) {
	lower := lowercaseHeaders(headers)
	id := lower["webhook-id"]
	timestamp := lower["webhook-timestamp"]
	signature := lower["webhook-signature"]

	if id == "" || timestamp == "" || signature == "" {
		return nil, verificationErr("Missing required webhook headers")
	}

	timestampSeconds, err := strconv.ParseFloat(timestamp, 64)
	if err != nil || math.IsNaN(timestampSeconds) || math.IsInf(timestampSeconds, 0) {
		return nil, verificationErr("Invalid webhook timestamp")
	}

	nowSeconds := float64(time.Now().Unix())
	if math.Abs(nowSeconds-timestampSeconds) > ToleranceSeconds {
		return nil, verificationErr("Webhook timestamp is outside of tolerance")
	}

	signedContent := fmt.Sprintf("%s.%d.%s", id, int64(timestampSeconds), rawBody)
	key, err := ParseSecret(secret)
	if err != nil {
		return nil, verificationErr("Invalid signing secret")
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signedContent))
	expectedDigest := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	for _, entry := range strings.Split(signature, " ") {
		digest, ok := extractSignatureDigest(entry)
		if ok && timingSafeEqualBase64(digest, expectedDigest) {
			return []byte(rawBody), nil
		}
	}

	return nil, verificationErr("No matching signature found")
}
