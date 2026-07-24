package core_test

import (
	"context"
	"testing"

	"github.com/sns45/anyhook/go/core"
)

func checkURL(t *testing.T, policy core.URLPolicy, url string) core.URLCheckResult {
	t.Helper()
	return policy.Check(context.Background(), url)
}

func TestDefaultURLPolicyAllowsPublicHosts(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	tests := []string{
		"https://example.com/webhook",
		"http://example.com/webhook",
		"https://api.example.com:8443/hooks/1",
		"https://1.2.3.4.example.com/x", // hostname that merely contains digits, not a numeric literal
	}
	for _, url := range tests {
		res := checkURL(t, policy, url)
		if !res.Allowed {
			t.Errorf("Check(%q) = denied (%q), want allowed", url, res.Reason)
		}
	}
}

func TestDefaultURLPolicyBlocksSchemes(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	tests := []string{"ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)"}
	for _, url := range tests {
		res := checkURL(t, policy, url)
		if res.Allowed {
			t.Errorf("Check(%q) = allowed, want denied", url)
		}
	}
}

func TestDefaultURLPolicyRequireHTTPSWhenConfigured(t *testing.T) {
	no := false
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{AllowHTTP: &no})
	if res := checkURL(t, policy, "http://example.com"); res.Allowed {
		t.Error("expected http:// to be denied when AllowHTTP=false")
	}
	if res := checkURL(t, policy, "https://example.com"); !res.Allowed {
		t.Errorf("expected https:// to be allowed when AllowHTTP=false, got %v", res.Reason)
	}
}

func TestDefaultURLPolicyBlocksLoopbackHostname(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	for _, url := range []string{"http://localhost/x", "http://sub.localhost/x"} {
		if res := checkURL(t, policy, url); res.Allowed {
			t.Errorf("Check(%q) = allowed, want denied", url)
		}
	}
}

func TestDefaultURLPolicyExtraDeny(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{ExtraDeny: []string{"Evil.Example.com"}})
	if res := checkURL(t, policy, "http://evil.example.com/x"); res.Allowed {
		t.Error("expected case-insensitive extra-deny match to deny")
	}
}

func TestDefaultURLPolicyInvalidURL(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	for _, url := range []string{"", "not a url", "http://"} {
		if res := checkURL(t, policy, url); res.Allowed {
			t.Errorf("Check(%q) = allowed, want denied (invalid_url)", url)
		}
	}
}

// TestDefaultURLPolicyBlocksPrivateIPv4 covers the straightforward dotted-decimal ranges.
func TestDefaultURLPolicyBlocksPrivateIPv4(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	blocked := []string{
		"http://127.0.0.1/", "http://127.1.2.3/",
		"http://10.0.0.1/", "http://10.255.255.255/",
		"http://192.168.1.1/",
		"http://172.16.0.1/", "http://172.31.255.255/",
		"http://169.254.169.254/", // cloud metadata
		"http://0.0.0.0/",
		"http://100.64.0.1/", "http://100.127.255.255/", // CGNAT
		"http://224.0.0.1/", // multicast/reserved
	}
	for _, url := range blocked {
		if res := checkURL(t, policy, url); res.Allowed {
			t.Errorf("Check(%q) = allowed, want denied (private/reserved ipv4)", url)
		}
	}
	// 172.15/172.32 fall just outside the blocked /12 range.
	allowed := []string{"http://172.15.255.255/", "http://172.32.0.0/", "http://8.8.8.8/"}
	for _, url := range allowed {
		if res := checkURL(t, policy, url); !res.Allowed {
			t.Errorf("Check(%q) = denied (%q), want allowed", url, res.Reason)
		}
	}
}

// TestDefaultURLPolicyBlocksObfuscatedIPv4 is the hardened-parity check: decimal,
// octal, and hex encodings of loopback/private addresses must all be refused,
// matching the TS defaultUrlPolicy hardening.
func TestDefaultURLPolicyBlocksObfuscatedIPv4(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	blocked := []string{
		"http://2130706433/",       // decimal for 127.0.0.1
		"http://0x7f000001/",       // hex for 127.0.0.1
		"http://0177.0.0.1/",       // octal first octet for 127.0.0.1
		"http://0x7f.0.0.1/",       // hex first octet for 127.0.0.1
		"http://0x7f.0x0.0x0.0x1/", // all-hex octets for 127.0.0.1
		"http://017700000001/",     // octal for 127.0.0.1 as a single field
		"http://0xA9FEA9FE/",       // hex for 169.254.169.254 (cloud metadata)
		"http://3232235521/",       // decimal for 192.168.0.1
	}
	for _, url := range blocked {
		if res := checkURL(t, policy, url); res.Allowed {
			t.Errorf("Check(%q) = allowed, want denied (obfuscated private ipv4)", url)
		}
	}
}

// TestDefaultURLPolicyRefusesAmbiguousNumericHosts covers hosts that look
// like a numeric IP literal but don't parse cleanly -- these must be refused,
// never treated as a public hostname.
func TestDefaultURLPolicyRefusesAmbiguousNumericHosts(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	tests := []string{
		"http://999.999.999.999/", // out-of-range octets, still "numeric-looking"
		"http://1.2.3.4.5/",       // too many dotted fields
		"http://0x1ffffffff/",     // overflows 32 bits
		"http://256.1.1.1/",       // one octet out of range
	}
	for _, url := range tests {
		if res := checkURL(t, policy, url); res.Allowed {
			t.Errorf("Check(%q) = allowed, want denied (ambiguous_numeric_host)", url)
		}
	}
}

// TestDefaultURLPolicyBlocksIPv6Loopback covers both compressed and full-form
// IPv6 loopback/unspecified addresses.
func TestDefaultURLPolicyBlocksIPv6Loopback(t *testing.T) {
	policy := core.DefaultURLPolicy(core.URLPolicyOptions{})
	blocked := []string{
		"http://[::1]/",                // compressed loopback
		"http://[0:0:0:0:0:0:0:1]/",    // full-form loopback
		"http://[::]/",                 // compressed unspecified
		"http://[0:0:0:0:0:0:0:0]/",    // full-form unspecified
		"http://[fe80::1]/",            // link-local
		"http://[fc00::1]/",            // unique-local
		"http://[fd12:3456:789a::1]/",  // unique-local
		"http://[::ffff:127.0.0.1]/",   // IPv4-mapped loopback
		"http://[::ffff:192.168.1.1]/", // IPv4-mapped private
	}
	for _, url := range blocked {
		if res := checkURL(t, policy, url); res.Allowed {
			t.Errorf("Check(%q) = allowed, want denied (private/reserved ipv6)", url)
		}
	}
	if res := checkURL(t, policy, "http://[2001:4860:4860::8888]/"); !res.Allowed {
		t.Errorf("expected a public IPv6 literal to be allowed, got denied: %v", res.Reason)
	}
}
