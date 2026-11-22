package limitscmd

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/budgets"
	budgetstypes "github.com/aws/aws-sdk-go-v2/service/budgets/types"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	iamtypes "github.com/aws/aws-sdk-go-v2/service/iam/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/limits"
	"github.com/jebin2/ayis/internal/output"
)

var now = time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)

type ssmFake struct {
	p    map[string]string
	fail bool
}

func (f *ssmFake) GetParameter(_ context.Context, in *ssm.GetParameterInput, _ ...func(*ssm.Options)) (*ssm.GetParameterOutput, error) {
	if f.fail {
		return nil, errors.New("ThrottlingException")
	}
	v, ok := f.p[aws.ToString(in.Name)]
	if !ok {
		return nil, &ssmtypes.ParameterNotFound{}
	}
	return &ssm.GetParameterOutput{Parameter: &ssmtypes.Parameter{Value: aws.String(v)}}, nil
}

func (f *ssmFake) PutParameter(_ context.Context, in *ssm.PutParameterInput, _ ...func(*ssm.Options)) (*ssm.PutParameterOutput, error) {
	f.p[aws.ToString(in.Name)] = aws.ToString(in.Value)
	return &ssm.PutParameterOutput{}, nil
}

type ec2Fake struct {
	up   []ec2types.Instance
	fail bool
}

func (f *ec2Fake) DescribeInstances(context.Context, *ec2.DescribeInstancesInput, ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	if f.fail {
		return nil, errors.New("AuthFailure")
	}
	return &ec2.DescribeInstancesOutput{Reservations: []ec2types.Reservation{{Instances: f.up}}}, nil
}

func (f *ec2Fake) CreateTags(context.Context, *ec2.CreateTagsInput, ...func(*ec2.Options)) (*ec2.CreateTagsOutput, error) {
	return &ec2.CreateTagsOutput{}, nil
}

type iamFake struct{ attached bool }

func (f iamFake) ListEntitiesForPolicy(context.Context, *iam.ListEntitiesForPolicyInput, ...func(*iam.Options)) (*iam.ListEntitiesForPolicyOutput, error) {
	o := &iam.ListEntitiesForPolicyOutput{}
	if f.attached {
		o.PolicyUsers = []iamtypes.PolicyUser{{UserName: aws.String("me")}}
	}
	return o, nil
}

type budgetsFake struct{ armed bool }

func (f budgetsFake) DescribeBudgetActionsForBudget(context.Context, *budgets.DescribeBudgetActionsForBudgetInput, ...func(*budgets.Options)) (*budgets.DescribeBudgetActionsForBudgetOutput, error) {
	o := &budgets.DescribeBudgetActionsForBudgetOutput{}
	if f.armed {
		o.Actions = []budgetstypes.Action{{Definition: &budgetstypes.Definition{IamActionDefinition: &budgetstypes.IamActionDefinition{
			PolicyArn: aws.String(limits.BlockPolicyARN("1", "ayis"))}}}}
	}
	return o, nil
}
func (budgetsFake) CreateBudgetAction(context.Context, *budgets.CreateBudgetActionInput, ...func(*budgets.Options)) (*budgets.CreateBudgetActionOutput, error) {
	return nil, nil
}
func (budgetsFake) UpdateBudgetAction(context.Context, *budgets.UpdateBudgetActionInput, ...func(*budgets.Options)) (*budgets.UpdateBudgetActionOutput, error) {
	return nil, nil
}
func (budgetsFake) ExecuteBudgetAction(context.Context, *budgets.ExecuteBudgetActionInput, ...func(*budgets.Options)) (*budgets.ExecuteBudgetActionOutput, error) {
	return nil, nil
}

func env(t *testing.T, body string) *config.Env {
	t.Helper()
	f := filepath.Join(t.TempDir(), ".env")
	_ = os.WriteFile(f, []byte(body), 0o600)
	return config.Load(func(k string) (string, bool) {
		if k == "AYIS_ENV_FILE" {
			return f, true
		}
		return "", false
	}, "")
}

func running(launched time.Time) ec2types.Instance {
	return ec2types.Instance{InstanceId: aws.String("i-1"), LaunchTime: aws.Time(launched)}
}

func TestReadAPlayingSession(t *testing.T) {
	s := &ssmFake{p: map[string]string{"/ayis/ayis/usage/2026-11": `{"done": 36000, "open": {}}`, "/ayis/ayis/usage/2026-11-extra": "5"}}
	st := Read(context.Background(), env(t, "GAME_MAX_SESSION_HOURS=6\nGAME_MAX_HOURS_MONTH=60\n"), s,
		&ec2Fake{up: []ec2types.Instance{running(now.Add(-2 * time.Hour))}}, iamFake{}, budgetsFake{armed: true}, "1", now)
	if st.MonthError != "" || st.Month.UsedHours != 12 || st.Month.CapHours != 65 || st.Month.LeftHours != 53 || st.Month.Reached {
		t.Errorf("month: %+v %q", st.Month, st.MonthError)
	}
	if len(st.Sessions) != 1 || st.Sessions[0].LeftMins != 240 || !st.Sessions[0].Ends.Equal(now.Add(4*time.Hour)) {
		t.Errorf("session: %+v", st.Sessions)
	}
	if st.BudgetBlocked || st.BudgetArmed == nil || !*st.BudgetArmed || st.MonthResetsUTC != "2026-12-01T00:00:00Z" {
		t.Errorf("budget: %+v", st)
	}
	if Refusal(st) != "" {
		t.Error("a session inside every limit was refused")
	}
}

// Not being able to ask is said, and is never a zero: the card shows "unknown".
func TestReadWhenAWSDoesNotAnswer(t *testing.T) {
	st := Read(context.Background(), env(t, ""), &ssmFake{fail: true}, &ec2Fake{fail: true}, iamFake{}, nil, "1", now)
	if st.MonthError == "" {
		t.Error("an unreadable month read as a number")
	}
	if st.Sessions == nil {
		t.Error("sessions must be [] in JSON, not null")
	}
	if st.BudgetArmed != nil {
		t.Error("budgets not asked: armed must be unknown")
	}
}

func TestReadABlockedBudgetRefuses(t *testing.T) {
	st := Read(context.Background(), env(t, ""), &ssmFake{p: map[string]string{}}, &ec2Fake{}, iamFake{attached: true}, budgetsFake{}, "1", now)
	if !st.BudgetBlocked || Refusal(st) == "" || st.BudgetArmed == nil || *st.BudgetArmed {
		t.Errorf("%+v", st)
	}
}

func TestStatusInWords(t *testing.T) {
	var o bytes.Buffer
	out := &output.Out{Stdout: &o, Stderr: &o}
	armed := false
	show(Status{Month: limits.Month{UsedHours: 12, CapHours: 60, LeftHours: 48}, SessionHours: 6,
		Sessions: []limits.Session{{ID: "i-1", Ends: now, LeftMins: 30}}, BudgetArmed: &armed}, out)
	for _, want := range []string{"play hours this month: 12.0 of 60 - 48.0 left", "session: i-1 switches off at", "(30 min left)", "budget block: not set up"} {
		if !strings.Contains(o.String(), want) {
			t.Errorf("lacks %q:\n%s", want, o.String())
		}
	}
	o.Reset()
	show(Status{MonthError: "throttled", BudgetBlocked: true}, out)
	for _, want := range []string{"play hours this month: unknown - throttled", "session limit: off", "budget block: ON"} {
		if !strings.Contains(o.String(), want) {
			t.Errorf("lacks %q:\n%s", want, o.String())
		}
	}
}
