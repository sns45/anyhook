package core

import (
	"context"
	"math"
	"strconv"
	"strings"
)

// DeliverPorts are the ports DeliverOnce needs.
type DeliverPorts struct {
	HTTP      HTTPClient
	Signer    WebhookSigner
	URLPolicy URLPolicy
	Clock     Clock
	TimeoutMs int64
	// SnippetLimit caps the response snippet stored in the delivery log. 0 means the default (512).
	SnippetLimit int
}

// DeliveryResult is the outcome of one DeliverOnce call.
type DeliveryResult struct {
	Status      AttemptStatus
	Outcome     Outcome
	LatencyMs   int64
	RespSnippet string
	// RetryAfterMs is the parsed, capped Retry-After in ms (429/503 only), when present.
	RetryAfterMs *int64
	// BlockedBySSRF is true when the target was refused by the URL policy (SSRF), before any POST.
	BlockedBySSRF bool
}

// parseRetryAfterMs parses a Retry-After header (integer seconds) into ms.
// Ignores the HTTP-date form, matching the TS M1 scope.
func parseRetryAfterMs(headers map[string]string) *int64 {
	if headers == nil {
		return nil
	}
	raw, ok := headers["retry-after"]
	if !ok || raw == "" {
		return nil
	}
	secs, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(secs) || math.IsInf(secs, 0) || secs < 0 {
		return nil
	}
	ms := int64(secs * 1000)
	return &ms
}

// DeliverOnce performs ONE delivery POST for a message. Assumes the caller
// already checked the circuit. Signs the body (Standard Webhooks;
// "webhook-id" = the stable messageId so retries dedupe), enforces the URL
// policy first (SSRF -> permanent), and classifies the transport outcome.
func DeliverOnce(ctx context.Context, m Message, endpoint Endpoint, p DeliverPorts) DeliveryResult {
	limit := p.SnippetLimit
	if limit <= 0 {
		limit = 512
	}
	body := string(m.Payload)

	ssrf := p.URLPolicy.Check(ctx, endpoint.URL)
	if !ssrf.Allowed {
		reason := ssrf.Reason
		if reason == "" {
			reason = "denied"
		}
		return DeliveryResult{
			Status: StatusNetwork, Outcome: OutcomePermanent, LatencyMs: 0,
			RespSnippet: "ssrf_blocked:" + reason, BlockedBySSRF: true,
		}
	}

	headers := map[string]string{"content-type": "application/json"}
	for k, v := range p.Signer.Sign(endpoint.Secrets, m.MessageID, body, p.Clock.Now()) {
		headers[k] = v
	}

	start := p.Clock.Now()
	res := p.HTTP.Post(ctx, endpoint.URL, body, headers, p.TimeoutMs)
	latencyMs := p.Clock.Now() - start
	if latencyMs < 0 {
		latencyMs = 0
	}

	if !res.Status.IsCode() {
		return DeliveryResult{Status: res.Status, Outcome: OutcomeRetryable, LatencyMs: latencyMs, RespSnippet: res.Status.String()}
	}

	outcome := ClassifyOutcome(res.Status)
	var retryAfterMs *int64
	if res.Status == 429 || res.Status == 503 {
		retryAfterMs = parseRetryAfterMs(res.Headers)
	}
	snippet := res.Body
	if len(snippet) > limit {
		snippet = snippet[:limit]
	}
	return DeliveryResult{Status: res.Status, Outcome: outcome, LatencyMs: latencyMs, RespSnippet: snippet, RetryAfterMs: retryAfterMs}
}
