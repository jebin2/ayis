package watchdog

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
	"github.com/aws/smithy-go"
)

type beat struct {
	value string
	err   error
}

func (b beat) GetParameter(_ context.Context, in *ssm.GetParameterInput, _ ...func(*ssm.Options)) (*ssm.GetParameterOutput, error) {
	if aws.ToString(in.Name) != "/ayis/ayis/watchdog/last-ok" {
		return nil, &smithy.GenericAPIError{Code: "ParameterNotFound"}
	}
	if b.err != nil {
		return nil, b.err
	}
	return &ssm.GetParameterOutput{Parameter: &ssmtypes.Parameter{Value: aws.String(b.value)}}, nil
}

func TestHeartbeat(t *testing.T) {
	now := time.Date(2026, 11, 22, 12, 30, 0, 0, time.UTC)
	ctx := context.Background()
	fresh := ReadHeartbeat(ctx, beat{value: "2026-11-22T12:25:00Z"}, "ayis")
	if !fresh.Found || fresh.Late(now) {
		t.Errorf("5 minutes old is on time: %+v", fresh)
	}
	old := ReadHeartbeat(ctx, beat{value: "2026-11-22T12:10:00Z"}, "ayis")
	if !old.Late(now) {
		t.Error("20 minutes old is late")
	}
	never := ReadHeartbeat(ctx, beat{err: &smithy.GenericAPIError{Code: "ParameterNotFound"}}, "ayis")
	if !never.Known || never.Found || never.Late(now) {
		t.Errorf("never recorded is known, and not late - it may not have run yet: %+v", never)
	}
	unread := ReadHeartbeat(ctx, beat{err: &smithy.GenericAPIError{Code: "AccessDeniedException"}}, "ayis")
	if unread.Known || unread.Late(now) {
		t.Errorf("unreadable is unknown, not late: %+v", unread)
	}
	if ReadHeartbeat(ctx, beat{value: "soon"}, "ayis").Found {
		t.Error("a garbled value is not a run")
	}
}

// The role may write the heartbeat, and only it.
func TestTheRoleMayWriteTheHeartbeat(t *testing.T) {
	policy := Settings{Host: "ayis", Account: "1"}.Policy("r")
	for _, st := range policy["Statement"].([]any) {
		m := st.(map[string]any)
		if m["Sid"] == "Heartbeat" {
			if m["Resource"] != "arn:aws:ssm:*:1:parameter/ayis/ayis/watchdog/last-ok" || m["Action"] != "ssm:PutParameter" {
				t.Errorf("heartbeat statement %v", m)
			}
			return
		}
	}
	t.Error("no heartbeat statement")
}
