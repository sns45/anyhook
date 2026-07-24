package core_test

import (
	"testing"

	"github.com/sns45/anyhook/go/core"
)

func TestClassifyOutcome(t *testing.T) {
	tests := []struct {
		name   string
		status core.AttemptStatus
		want   core.Outcome
	}{
		{"200", 200, core.OutcomeDelivered},
		{"201", 201, core.OutcomeDelivered},
		{"299", 299, core.OutcomeDelivered},
		{"300 redirect is permanent", 300, core.OutcomePermanent},
		{"301", 301, core.OutcomePermanent},
		{"400", 400, core.OutcomePermanent},
		{"404", 404, core.OutcomePermanent},
		{"429 is retryable", 429, core.OutcomeRetryable},
		{"499", 499, core.OutcomePermanent},
		{"500", 500, core.OutcomeRetryable},
		{"503", 503, core.OutcomeRetryable},
		{"599", 599, core.OutcomeRetryable},
		{"timeout", core.StatusTimeout, core.OutcomeRetryable},
		{"network", core.StatusNetwork, core.OutcomeRetryable},
		{"1xx anomalous", 100, core.OutcomeRetryable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := core.ClassifyOutcome(tc.status); got != tc.want {
				t.Errorf("ClassifyOutcome(%v) = %v, want %v", tc.status, got, tc.want)
			}
		})
	}
}
