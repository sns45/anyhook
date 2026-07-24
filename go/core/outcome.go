package core

// Outcome is the classification of a single delivery attempt's transport status.
type Outcome string

const (
	OutcomeDelivered Outcome = "delivered"
	OutcomeRetryable Outcome = "retryable"
	OutcomePermanent Outcome = "permanent"
)

// ClassifyOutcome classifies a delivery attempt's transport status:
//
//   - 2xx                -> delivered
//   - 3xx                -> permanent (redirects are not followed; a redirect
//     on a webhook target is misconfiguration)
//   - 429                -> retryable
//   - other 4xx          -> permanent (the receiver rejected it; retrying won't help)
//   - 5xx                -> retryable
//   - timeout / network  -> retryable
//   - <200 (unexpected)  -> retryable
func ClassifyOutcome(status AttemptStatus) Outcome {
	if status == StatusTimeout || status == StatusNetwork {
		return OutcomeRetryable
	}
	s := int(status)
	if s >= 200 && s < 300 {
		return OutcomeDelivered
	}
	if s == 429 {
		return OutcomeRetryable
	}
	if s >= 300 && s < 500 {
		return OutcomePermanent
	}
	if s >= 500 {
		return OutcomeRetryable
	}
	return OutcomeRetryable // 1xx / anomalous
}
