// Package awscfg builds the AWS SDK configuration every command uses: the
// region, the credentials, a User-Agent that names ayis, an endpoint override
// so tests can point the SDK at a fake, and the ONE retry and timeout policy
// every AWS call follows:
//
//   - Retries: the SDK's standard mode, up to Attempts tries. A throttled or
//     briefly failing call is tried again with jittered backoff; a mistake
//     (a missing parameter, a denied permission) is an answer and is not.
//     Not adaptive mode: its client-side rate limiter starts from the rate it
//     has measured, and a CLI that has made two calls waited seconds for a
//     third after one throttle (tested).
//   - Deadline: no call waits for ever. A call made with a context that has no
//     deadline gets CallTimeout, retries included, so a dead network ends in an
//     error a person can read instead of a window that never finishes.
package awscfg

import (
	"context"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsmiddleware "github.com/aws/aws-sdk-go-v2/aws/middleware"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/ec2/imds"
	"github.com/aws/smithy-go/middleware"
)

// The policy. Variables only so the tests can shorten them.
var (
	// Attempts is how many times one call is tried, the first included.
	Attempts = 5
	// MaxBackoff is the longest wait between two tries.
	MaxBackoff = 20 * time.Second
	// CallTimeout bounds one call, every retry included, when the caller set no
	// deadline of its own. Generous: the slowest call ayis makes is a server-side
	// copy of one 5 GB part between buckets.
	CallTimeout = 2 * time.Minute
)

// streams are the calls whose answer is read AFTER the call returns (a body);
// their deadline must outlive the call, so it is left to run out on its own.
var streams = map[string]bool{"GetObject": true}

// New returns the SDK config for a region. AYIS_AWS_ENDPOINT, if set, sends
// every call to that URL; it exists for the tests and is not documented to
// users.
func New(ctx context.Context, region string) (aws.Config, error) {
	// ayis runs on a laptop, never on an EC2 instance, so it never asks the
	// instance metadata service for credentials: that only added a delay and a
	// warning to the message when the access key is missing.
	opts := []func(*config.LoadOptions) error{
		config.WithAppID("ayis"),
		config.WithEC2IMDSClientEnableState(imds.ClientDisabled),
		config.WithRetryer(Retryer),
		config.WithAPIOptions([]func(*middleware.Stack) error{Deadline}),
	}
	if region != "" {
		opts = append(opts, config.WithRegion(region))
	}
	if u := Endpoint(); u != "" {
		opts = append(opts, config.WithBaseEndpoint(u))
	}
	return config.LoadDefaultConfig(ctx, opts...)
}

// Retryer is the retry policy: standard mode, Attempts tries, MaxBackoff at most
// between them.
func Retryer() aws.Retryer {
	return retry.NewStandard(func(so *retry.StandardOptions) {
		so.MaxAttempts = Attempts
		so.MaxBackoff = MaxBackoff
	})
}

// Deadline adds CallTimeout to a call whose context has no deadline. It runs in
// the first step, before retries are made, so the deadline covers them all.
func Deadline(stack *middleware.Stack) error {
	return stack.Initialize.Add(middleware.InitializeMiddlewareFunc("ayisDeadline",
		func(ctx context.Context, in middleware.InitializeInput, next middleware.InitializeHandler) (middleware.InitializeOutput, middleware.Metadata, error) {
			if _, ok := ctx.Deadline(); ok {
				return next.HandleInitialize(ctx, in)
			}
			ctx, cancel := context.WithTimeout(ctx, CallTimeout)
			if streams[awsmiddleware.GetOperationName(ctx)] {
				// Released when CallTimeout passes; the body is read until then.
				_ = cancel
			} else {
				defer cancel()
			}
			return next.HandleInitialize(ctx, in)
		}), middleware.After)
}

// Endpoint is AYIS_AWS_ENDPOINT: every AWS call sent to one address instead of
// AWS, for tests against a local fake. "" in normal use.
func Endpoint() string { return os.Getenv("AYIS_AWS_ENDPOINT") }
