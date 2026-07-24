package core

import (
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// URLPolicyOptions configures DefaultURLPolicy.
type URLPolicyOptions struct {
	// AllowHTTP allows plain http: targets. Nil means true (the default);
	// set a pointer to false to require https.
	AllowHTTP *bool
	// ExtraDeny lists extra hostnames/IPs to always deny (exact, case-insensitive).
	ExtraDeny []string
}

var (
	hexFieldRe          = regexp.MustCompile(`(?i)^0x[0-9a-f]+$`)
	octFieldRe          = regexp.MustCompile(`^0[0-7]+$`)
	decFieldRe          = regexp.MustCompile(`^[0-9]+$`)
	numericHostRe       = regexp.MustCompile(`(?i)^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$`)
	ipv4MappedRe        = regexp.MustCompile(`::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$`)
	fullLoopbackV6Re    = regexp.MustCompile(`^(0:){7}1$`)
	fullUnspecifiedV6Re = regexp.MustCompile(`^(0:){7}0$`)
	compressedZeroV6Re  = regexp.MustCompile(`^0(:0)*::?0?$`)
)

// parseIPField parses one IPv4 field in decimal, octal (0...), or hex
// (0x...) -- the forms inet_aton accepts.
func parseIPField(s string) (int64, bool) {
	switch {
	case hexFieldRe.MatchString(s):
		v, err := strconv.ParseInt(s[2:], 16, 64)
		return v, err == nil
	case octFieldRe.MatchString(s):
		v, err := strconv.ParseInt(s, 8, 64)
		return v, err == nil
	case decFieldRe.MatchString(s):
		v, err := strconv.ParseInt(s, 10, 64)
		return v, err == nil
	}
	return 0, false
}

// ipv4ToOctets parses an IPv4 literal in any common encoding into octets:
// dotted-decimal, dotted octal/hex (0177.0.0.1, 0x7f.0.0.1), or a single
// 32-bit integer (2130706433, 0x7f000001). ok is false when host is not a
// numeric IPv4 literal in any of these forms.
func ipv4ToOctets(host string) (octets [4]int, ok bool) {
	parts := strings.Split(host, ".")
	if len(parts) == 4 {
		for i, p := range parts {
			v, valid := parseIPField(p)
			if !valid || v < 0 || v > 255 {
				return [4]int{}, false
			}
			octets[i] = int(v)
		}
		return octets, true
	}
	if len(parts) == 1 {
		v, valid := parseIPField(parts[0])
		if !valid || v < 0 || v > 0xffffffff {
			return [4]int{}, false
		}
		n := uint32(v)
		return [4]int{int(n >> 24 & 255), int(n >> 16 & 255), int(n >> 8 & 255), int(n & 255)}, true
	}
	return [4]int{}, false // 2/3-part inet_aton forms are rare and ambiguous -- handled by the numeric-host guard
}

// looksNumeric reports whether host looks like an obfuscated numeric IP
// (decimal/hex fields, possibly dotted) even if it did not parse cleanly to a
// valid IPv4 -- such hosts are refused, never allowed as a public hostname.
func looksNumeric(host string) bool {
	hasDigit := false
	for _, r := range host {
		if r >= '0' && r <= '9' {
			hasDigit = true
			break
		}
	}
	return hasDigit && numericHostRe.MatchString(host)
}

// isBlockedIPv4 reports whether octets fall in a private/loopback/link-local/reserved IPv4 range.
func isBlockedIPv4(octets [4]int) bool {
	a, b := octets[0], octets[1]
	switch {
	case a == 10: // 10.0.0.0/8
		return true
	case a == 127: // loopback
		return true
	case a == 0: // 0.0.0.0/8
		return true
	case a == 169 && b == 254: // link-local (incl. cloud metadata 169.254.169.254)
		return true
	case a == 172 && b >= 16 && b <= 31: // 172.16.0.0/12
		return true
	case a == 192 && b == 168: // 192.168.0.0/16
		return true
	case a == 100 && b >= 64 && b <= 127: // 100.64.0.0/10 CGNAT
		return true
	case a >= 224: // multicast / reserved
		return true
	}
	return false
}

// isBlockedIPv6 reports whether raw (an IPv6 literal, optionally bracketed) is
// loopback/unspecified/link-local/unique-local, or an IPv4-mapped address
// whose embedded v4 is blocked.
func isBlockedIPv6(raw string) bool {
	h := strings.ToLower(raw)
	if strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = h[1 : len(h)-1]
	}
	if h == "::1" || h == "::" {
		return true // loopback / unspecified (compressed)
	}
	if fullLoopbackV6Re.MatchString(h) {
		return true // full-form loopback 0:0:0:0:0:0:0:1
	}
	if fullUnspecifiedV6Re.MatchString(h) || compressedZeroV6Re.MatchString(h) {
		return true // full-form unspecified
	}
	if strings.HasPrefix(h, "fe8") || strings.HasPrefix(h, "fe9") || strings.HasPrefix(h, "fea") || strings.HasPrefix(h, "feb") {
		return true // fe80::/10 link-local
	}
	if strings.HasPrefix(h, "fc") || strings.HasPrefix(h, "fd") {
		return true // fc00::/7 unique-local
	}
	if m := ipv4MappedRe.FindStringSubmatch(h); m != nil {
		octets, ok := ipv4ToOctets(m[1])
		if !ok {
			return true
		}
		return isBlockedIPv4(octets)
	}
	return false
}

type urlPolicyFunc func(ctx context.Context, url string) URLCheckResult

func (f urlPolicyFunc) Check(ctx context.Context, url string) URLCheckResult { return f(ctx, url) }

// DefaultURLPolicy is the default deny-list SSRF policy. Refuses non-http(s)
// schemes and private/loopback/link-local literal-IP targets, including
// obfuscated IPv4 (decimal/octal/hex) and full-form IPv6 loopback/unspecified
// forms. Public hostnames are allowed.
//
// KNOWN LIMITATION (accepted, not delegated): this is a static hostname/literal-IP
// check. A public hostname that resolves to a private IP (DNS rebinding) is NOT
// caught -- net/http exposes no pre-dial hook here, so adapters cannot fully
// close this either. Operators on shared infra needing that guarantee must run
// anyhook behind egress network controls.
func DefaultURLPolicy(opts URLPolicyOptions) URLPolicy {
	allowHTTP := true
	if opts.AllowHTTP != nil {
		allowHTTP = *opts.AllowHTTP
	}
	deny := make(map[string]struct{}, len(opts.ExtraDeny))
	for _, s := range opts.ExtraDeny {
		deny[strings.ToLower(s)] = struct{}{}
	}

	return urlPolicyFunc(func(_ context.Context, raw string) URLCheckResult {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return URLCheckResult{Allowed: false, Reason: "invalid_url"}
		}

		scheme := parsed.Scheme
		if scheme != "https" && !(allowHTTP && scheme == "http") {
			return URLCheckResult{Allowed: false, Reason: "blocked_scheme:" + scheme}
		}

		host := strings.ToLower(parsed.Hostname())
		if _, denied := deny[host]; denied {
			return URLCheckResult{Allowed: false, Reason: "denied_host"}
		}
		if host == "localhost" || strings.HasSuffix(host, ".localhost") {
			return URLCheckResult{Allowed: false, Reason: "loopback_hostname"}
		}

		if octets, ok := ipv4ToOctets(host); ok {
			if isBlockedIPv4(octets) {
				return URLCheckResult{Allowed: false, Reason: "private_or_reserved_ipv4"}
			}
			return URLCheckResult{Allowed: true}
		}

		// A host that looks like an obfuscated numeric IP but didn't parse to a
		// valid IPv4 is refused, never treated as a public hostname (defends
		// against inet_aton edge encodings).
		if looksNumeric(host) {
			return URLCheckResult{Allowed: false, Reason: "ambiguous_numeric_host"}
		}

		if strings.Contains(host, ":") {
			if isBlockedIPv6(host) {
				return URLCheckResult{Allowed: false, Reason: "private_or_reserved_ipv6"}
			}
			return URLCheckResult{Allowed: true}
		}

		// Non-literal hostname: allowed statically; adapter re-checks resolved IP at connect time.
		return URLCheckResult{Allowed: true}
	})
}
