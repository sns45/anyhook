package signing_test

import (
	"errors"
	"testing"
	"time"

	"github.com/sns45/anyhook/go/signing"
)

const testSecret = "whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"

func TestSignVerifyRoundTrip(t *testing.T) {
	body := `{"hello":"world"}`
	hdrs, err := signing.NewSigner(testSecret).Headers("msg_rt", body, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	got, err := signing.Verify(hdrs, body, testSecret)
	if err != nil {
		t.Fatalf("Verify returned error: %v", err)
	}
	if string(got) != body {
		t.Fatalf("Verify body = %q, want %q", got, body)
	}
}

func TestVerifyRejectsTamperedBody(t *testing.T) {
	body := `{"hello":"world"}`
	hdrs, err := signing.NewSigner(testSecret).Headers("msg_tamper", body, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = signing.Verify(hdrs, `{"hello":"mallory"}`, testSecret)
	if err == nil {
		t.Fatal("expected Verify to reject a tampered body, got nil error")
	}
	var verr *signing.WebhookVerificationError
	if !errors.As(err, &verr) {
		t.Fatalf("expected *WebhookVerificationError, got %T: %v", err, err)
	}
}

func TestVerifyRejectsStaleTimestamp(t *testing.T) {
	body := `{"hello":"world"}`
	stale := time.Now().Add(-10 * time.Minute) // outside the 300s tolerance
	hdrs, err := signing.NewSigner(testSecret).Headers("msg_stale", body, stale)
	if err != nil {
		t.Fatal(err)
	}
	_, err = signing.Verify(hdrs, body, testSecret)
	if err == nil {
		t.Fatal("expected Verify to reject a stale timestamp, got nil error")
	}
}

func TestVerifyRejectsFutureTimestamp(t *testing.T) {
	body := `{"hello":"world"}`
	future := time.Now().Add(10 * time.Minute)
	hdrs, err := signing.NewSigner(testSecret).Headers("msg_future", body, future)
	if err != nil {
		t.Fatal(err)
	}
	_, err = signing.Verify(hdrs, body, testSecret)
	if err == nil {
		t.Fatal("expected Verify to reject a future timestamp outside tolerance, got nil error")
	}
}

func TestVerifyRejectsMissingHeaders(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
	}{
		{"missing all", map[string]string{}},
		{"missing signature", map[string]string{"webhook-id": "msg_1", "webhook-timestamp": "1700000000"}},
		{"missing timestamp", map[string]string{"webhook-id": "msg_1", "webhook-signature": "v1,abc="}},
		{"missing id", map[string]string{"webhook-timestamp": "1700000000", "webhook-signature": "v1,abc="}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := signing.Verify(tc.headers, "{}", testSecret); err == nil {
				t.Fatal("expected an error, got nil")
			}
		})
	}
}

func TestVerifyRejectsWrongSecret(t *testing.T) {
	body := `{"hello":"world"}`
	hdrs, err := signing.NewSigner(testSecret).Headers("msg_wrong", body, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	otherSecret := "whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
	if _, err := signing.Verify(hdrs, body, otherSecret); err == nil {
		t.Fatal("expected Verify to reject a signature from a different secret, got nil error")
	}
}

func TestVerifyHeaderKeysCaseInsensitive(t *testing.T) {
	body := `{"hello":"world"}`
	hdrs, err := signing.NewSigner(testSecret).Headers("msg_case", body, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	upper := map[string]string{
		"Webhook-Id":        hdrs["webhook-id"],
		"WEBHOOK-TIMESTAMP": hdrs["webhook-timestamp"],
		"Webhook-Signature": hdrs["webhook-signature"],
	}
	if _, err := signing.Verify(upper, body, testSecret); err != nil {
		t.Fatalf("Verify with mixed-case headers failed: %v", err)
	}
}

func TestVerifyAcceptsAnyMatchingSecretDuringRotation(t *testing.T) {
	body := `{"hello":"world"}`
	newSecret := "whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
	// Signed with both (rotation window); verify against the OLD secret only.
	hdrs, err := signing.NewSigner(newSecret, testSecret).Headers("msg_rot", body, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signing.Verify(hdrs, body, testSecret); err != nil {
		t.Fatalf("Verify should accept a match against any signed secret: %v", err)
	}
}
