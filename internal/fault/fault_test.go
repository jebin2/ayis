package fault

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"

	"github.com/aws/smithy-go"
)

func api(code string) error {
	return fmt.Errorf("operation error EC2: RunInstances, %w", &smithy.GenericAPIError{Code: code, Message: "said"})
}

func TestClasses(t *testing.T) {
	for _, c := range []struct {
		err  error
		want Class
	}{
		{nil, ""},
		{api("InvalidClientTokenId"), Yours},
		{api("ExpiredTokenException"), Yours},
		{api("AccessDeniedException"), Yours},
		{api("UnauthorizedOperation"), Yours},
		{api("VcpuLimitExceeded"), Yours},
		{api("MaxSpotInstanceCountExceeded"), Yours},
		{api("ThrottlingException"), Again},
		{api("RequestLimitExceeded"), Again},
		{api("InsufficientInstanceCapacity"), Again},
		{api("ServiceUnavailable"), Again},
		{api("InvalidParameterValue"), Bug},
		{fmt.Errorf("listing: %w", context.DeadlineExceeded), Again},
		{&net.OpError{Op: "dial", Err: errors.New("connection refused")}, Again},
		{&net.DNSError{Err: "no such host", Name: "ec2.ap-south-1.amazonaws.com"}, Again},
		{errors.New("get credentials: failed to refresh cached credentials, no EC2 IMDS role found"), Yours},
		{errors.New("failed to retrieve credentials: static credentials are empty"), Yours},
		{errors.New("index.json: unexpected end of JSON input"), Bug},
	} {
		if got := Of(c.err); got != c.want {
			t.Errorf("%v: %q, want %q", c.err, got, c.want)
		}
	}
}

// Throttling is "again" even though "RequestLimitExceeded" ends like a quota:
// the exact code wins over a suffix rule.
func TestExactCodesWinOverPatterns(t *testing.T) {
	if Of(api("RequestLimitExceeded")) != Again {
		t.Error("RequestLimitExceeded is throttling, not a quota")
	}
}

func TestEveryClassHasAdviceAndNoErrorHasNone(t *testing.T) {
	if Hint(nil) != "" {
		t.Error("nil has no advice")
	}
	for _, e := range []error{api("AccessDenied"), api("VcpuLimitExceeded"), api("OptInRequired"), api("InvalidClientTokenId"),
		api("InsufficientInstanceCapacity"), api("Throttling"), errors.New("boom")} {
		h := Hint(e)
		if h == "" || !strings.HasSuffix(h, ".") {
			t.Errorf("%v: advice %q", e, h)
		}
	}
	if !strings.Contains(Hint(api("VcpuLimitExceeded")), "quota") || !strings.Contains(Hint(api("AccessDenied")), "allowed") {
		t.Error("a quota and a permission are told apart")
	}
}
