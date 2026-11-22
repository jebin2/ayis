// Package fault sorts an error into what the person can do about it, in one
// place, so the CLI and the app say the same thing for the same failure:
//
//   - Yours: something only you can fix - the AWS key, a permission, a quota,
//     a setting. Trying again changes nothing.
//   - Again: AWS or the network had a moment - throttled, out of capacity,
//     unreachable, too slow. Trying again later is the fix; the SDK already
//     retried (internal/awscfg), so this one outlasted that.
//   - Bug: neither. Something ayis did not expect, worth reporting.
//
// Each class comes with one sentence of advice. The error's own words are kept;
// the advice is said after them.
package fault

import (
	"context"
	"errors"
	"net"
	"strings"

	"github.com/aws/smithy-go"
)

// Class is what kind of failure an error is. Its value is what the app reads.
type Class string

const (
	Yours Class = "yours"
	Again Class = "again"
	Bug   Class = "bug"
)

// A code AWS gives, and what it means here. Prefix matches end in '*'.
var codes = map[string]Class{
	// The key, or the account behind it.
	"InvalidClientTokenId": Yours, "SignatureDoesNotMatch": Yours, "UnrecognizedClientException": Yours,
	"ExpiredToken*": Yours, "InvalidAccessKeyId": Yours, "AuthFailure": Yours, "MissingAuthenticationToken": Yours,
	"OptInRequired": Yours, "PendingVerification": Yours, "Blocked": Yours,
	// A permission.
	"AccessDenied*": Yours, "UnauthorizedOperation": Yours,
	// A quota: AWS has to raise it.
	"VcpuLimitExceeded": Yours, "MaxSpotInstanceCountExceeded": Yours, "InstanceLimitExceeded": Yours,
	"*LimitExceeded": Yours,
	// AWS's moment.
	"Throttling*": Again, "RequestLimitExceeded": Again, "TooManyRequestsException": Again, "SlowDown": Again,
	"InsufficientInstanceCapacity": Again, "InsufficientCapacity": Again, "SpotMaxPriceTooLow": Again,
	"ServiceUnavailable*": Again, "InternalError": Again, "InternalFailure": Again, "RequestTimeout*": Again,
	"Unavailable": Again,
}

// Of says which class err is. nil is not an error and has no class: "".
func Of(err error) Class {
	if err == nil {
		return ""
	}
	if code := Code(err); code != "" {
		if c, ok := lookup(code); ok {
			return c
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return Again
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return Again
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return Again
	}
	msg := strings.ToLower(err.Error())
	for _, s := range []string{"connection refused", "connection reset", "no such host", "network is unreachable", "i/o timeout", "tls handshake timeout"} {
		if strings.Contains(msg, s) {
			return Again
		}
	}
	// The SDK found no key at all.
	for _, s := range []string{"failed to retrieve credentials", "failed to refresh cached credentials", "no valid providers in chain", "static credentials are empty", "anonymous credentials"} {
		if strings.Contains(msg, s) {
			return Yours
		}
	}
	return Bug
}

// Code is the AWS error code inside err, or "".
func Code(err error) string {
	var ae smithy.APIError
	if errors.As(err, &ae) {
		return ae.ErrorCode()
	}
	return ""
}

func lookup(code string) (Class, bool) {
	if c, ok := codes[code]; ok {
		return c, true
	}
	for k, c := range codes {
		switch {
		case strings.HasSuffix(k, "*") && strings.HasPrefix(code, strings.TrimSuffix(k, "*")):
			return c, true
		case strings.HasPrefix(k, "*") && strings.HasSuffix(code, strings.TrimPrefix(k, "*")):
			return c, true
		}
	}
	return "", false
}

// Hint is the one sentence of advice for err: what to do next.
func Hint(err error) string {
	code := Code(err)
	switch Of(err) {
	case "":
		return ""
	case Yours:
		switch {
		case strings.HasPrefix(code, "AccessDenied") || code == "UnauthorizedOperation":
			return "Your AWS key is not allowed to do this - ayis check says which permission is missing."
		case strings.HasSuffix(code, "LimitExceeded") || code == "MaxSpotInstanceCountExceeded":
			return "This is an AWS quota on your account - ayis quota shows it and how to ask for more."
		case code == "OptInRequired" || code == "PendingVerification" || code == "Blocked":
			return "AWS has not finished setting up your account - check its emails, or the AWS console."
		}
		return "Your AWS key was not accepted - check it in Settings, or with ayis creds."
	case Again:
		if code == "InsufficientInstanceCapacity" || code == "InsufficientCapacity" {
			return "AWS has no machine of this kind free right now - try again in a few minutes, or another type or region."
		}
		return "AWS or the network did not answer in time - nothing is wrong on your side; try again in a minute."
	}
	return "This looks like a bug in ayis - please report it with the log."
}
