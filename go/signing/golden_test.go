package signing_test

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/sns45/anyhook/go/signing"
)

// update rewrites the golden files instead of comparing against them. Run:
//
//	go test ./signing/... -run TestGolden -update
//
// This -update pattern is a deliberate anyhook addition on top of the TS
// design (the TS test suite has no equivalent golden-file harness).
var update = flag.Bool("update", false, "update golden files")

func formatHeaders(hdrs map[string]string) string {
	keys := make([]string, 0, len(hdrs))
	for k := range hdrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := ""
	for _, k := range keys {
		out += fmt.Sprintf("%s: %s\n", k, hdrs[k])
	}
	return out
}

// TestGoldenWireFormat locks down the full Standard Webhooks header set
// (webhook-id, webhook-timestamp, webhook-signature) for a fixed input
// against a checked-in golden file, so any accidental change to the wire
// format is caught in review.
func TestGoldenWireFormat(t *testing.T) {
	cases := []struct {
		name    string
		secrets []string
		id      string
		payload string
		ts      time.Time
	}{
		{
			name:    "single_secret",
			secrets: []string{"whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"},
			id:      "msg_1",
			payload: `{"a":1}`,
			ts:      time.Unix(1700000000, 0).UTC(),
		},
		{
			name:    "rotation_two_secrets",
			secrets: []string{"whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB", "whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"},
			id:      "msg_2",
			payload: `{"nested":{"b":[1,2,3]},"unicode":"café"}`,
			ts:      time.Unix(1700000001, 0).UTC(),
		},
		{
			name:    "empty_object_payload",
			secrets: []string{"whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"},
			id:      "msg_3",
			payload: `{}`,
			ts:      time.Unix(0, 0).UTC(),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hdrs, err := signing.NewSigner(tc.secrets...).Headers(tc.id, tc.payload, tc.ts)
			if err != nil {
				t.Fatalf("Headers returned error: %v", err)
			}
			got := formatHeaders(hdrs)
			path := filepath.Join("testdata", tc.name+".golden")

			if *update {
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatalf("failed to write golden file: %v", err)
				}
			}

			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("failed to read golden file %s (run `go test ./signing/... -run TestGolden -update` to create it): %v", path, err)
			}
			if got != string(want) {
				t.Errorf("golden mismatch for %s.\n got:\n%s\nwant:\n%s", tc.name, got, string(want))
			}
		})
	}
}
