package aws

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sns45/anyhook/go/core"
)

// FetchHTTPClientOptions configures NewFetchHTTPClient.
type FetchHTTPClientOptions struct {
	// URLPolicy is re-run immediately before dispatch (belt-and-suspenders
	// SSRF; DNS-rebinding note: net/http does not expose the resolved IP
	// before connecting, so this is the static hostname policy re-applied).
	// nil disables the pre-dispatch check (the engine's own DeliverOnce check
	// still applies).
	URLPolicy core.URLPolicy
	// SnippetLimit caps the response-body snippet retained (bytes). 0 -> 2048.
	SnippetLimit int
}

// fetchHTTPClient is core.HTTPClient backed by Go's net/http.
type fetchHTTPClient struct {
	client       *http.Client
	urlPolicy    core.URLPolicy
	snippetLimit int
}

// NewFetchHTTPClient builds a core.HTTPClient backed by net/http. Redirects
// are NOT followed (http.ErrUseLastResponse): a 3xx on a webhook target is
// treated as a delivery failure (§8), reported with its real status code (no
// TS-style opaqueredirect normalization needed in Go -- the underlying
// transport hands back the actual 3xx response as-is). Deadline-exceeded
// errors map to StatusTimeout; every other transport error maps to
// StatusNetwork. Mirrors TS createFetchHttpClient (http-fetch.ts).
func NewFetchHTTPClient(opts FetchHTTPClientOptions) core.HTTPClient {
	snippetLimit := opts.SnippetLimit
	if snippetLimit <= 0 {
		snippetLimit = 2048
	}
	return &fetchHTTPClient{
		client: &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		urlPolicy:    opts.URLPolicy,
		snippetLimit: snippetLimit,
	}
}

// Post implements core.HTTPClient.
func (c *fetchHTTPClient) Post(ctx context.Context, url string, body string, headers map[string]string, timeoutMs int64) core.HTTPResult {
	if c.urlPolicy != nil {
		if check := c.urlPolicy.Check(ctx, url); !check.Allowed {
			return core.HTTPResult{Status: core.StatusNetwork}
		}
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(timeoutCtx, http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		return core.HTTPResult{Status: core.StatusNetwork}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	res, err := c.client.Do(req)
	if err != nil {
		if errors.Is(timeoutCtx.Err(), context.DeadlineExceeded) {
			return core.HTTPResult{Status: core.StatusTimeout}
		}
		return core.HTTPResult{Status: core.StatusNetwork}
	}
	defer res.Body.Close()

	// Read generously beyond the snippet limit (response bodies can carry
	// diagnostic text worth keeping a little more of before truncation) but
	// still bound total memory use against a pathological receiver.
	limited := io.LimitReader(res.Body, int64(c.snippetLimit)*4+4096)
	text, _ := io.ReadAll(limited)
	if len(text) > c.snippetLimit {
		text = text[:c.snippetLimit]
	}

	respHeaders := make(map[string]string, len(res.Header))
	for k, v := range res.Header {
		if len(v) > 0 {
			respHeaders[strings.ToLower(k)] = v[0]
		}
	}
	return core.HTTPResult{Status: core.AttemptStatus(res.StatusCode), Body: string(text), Headers: respHeaders}
}

var _ core.HTTPClient = (*fetchHTTPClient)(nil)
