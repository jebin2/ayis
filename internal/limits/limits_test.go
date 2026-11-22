package limits

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
)

var now = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

type fakeSSM struct {
	p    map[string]string
	fail bool
}

func (f *fakeSSM) GetParameter(_ context.Context, in *ssm.GetParameterInput, _ ...func(*ssm.Options)) (*ssm.GetParameterOutput, error) {
	if f.fail {
		return nil, errors.New("ThrottlingException")
	}
	v, ok := f.p[*in.Name]
	if !ok {
		return nil, &ssmtypes.ParameterNotFound{}
	}
	return &ssm.GetParameterOutput{Parameter: &ssmtypes.Parameter{Value: aws.String(v)}}, nil
}

func (f *fakeSSM) PutParameter(_ context.Context, in *ssm.PutParameterInput, _ ...func(*ssm.Options)) (*ssm.PutParameterOutput, error) {
	f.p[*in.Name] = *in.Value
	return &ssm.PutParameterOutput{}, nil
}

func TestReadMonthCountsLikeTheWatchdog(t *testing.T) {
	s := &fakeSSM{p: map[string]string{
		"/ayis/ayis/usage/2026-11":       `{"done": 7200, "open": {"i-a@2026-11-20T11:00:00Z": 3000, "i-old@2026-11-19T00:00:00Z": 1800}}`,
		"/ayis/ayis/usage/2026-11-extra": "5",
	}}
	// i-a is up: counted from its launch (1h), not the record's 50 min. i-old has
	// ended: its last 30 min count.
	m, err := ReadMonth(context.Background(), s, "ayis", 10, []Running{{ID: "i-a", Launched: now.Add(-time.Hour)}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if m.UsedHours != 3.5 || m.CapHours != 15 || m.ExtraHours != 5 || m.LeftHours != 11.5 || m.Reached {
		t.Errorf("%+v", m)
	}
}

func TestReadMonthCapReachedAndOff(t *testing.T) {
	s := &fakeSSM{p: map[string]string{"/ayis/ayis/usage/2026-11": `{"done": 36000}`}}
	m, _ := ReadMonth(context.Background(), s, "ayis", 10, nil, now)
	if !m.Reached || m.LeftHours != 0 {
		t.Errorf("at the cap: %+v", m)
	}
	m, _ = ReadMonth(context.Background(), s, "ayis", 0, nil, now)
	if m.Reached || m.CapHours != 0 || m.UsedHours != 10 {
		t.Errorf("no cap still counts, never reached: %+v", m)
	}
}

func TestReadMonthUnreadableIsAnError(t *testing.T) {
	if _, err := ReadMonth(context.Background(), &fakeSSM{p: map[string]string{"/ayis/ayis/usage/2026-11": "{x"}}, "ayis", 10, nil, now); err == nil {
		t.Error("an unreadable record must not read as zero hours")
	}
	if _, err := ReadMonth(context.Background(), &fakeSSM{fail: true}, "ayis", 10, nil, now); err == nil {
		t.Error("SSM failing must not read as zero hours")
	}
}

func TestReadMonthFromTheFirst(t *testing.T) {
	first := time.Date(2026, 11, 1, 2, 0, 0, 0, time.UTC)
	m, _ := ReadMonth(context.Background(), &fakeSSM{p: map[string]string{}}, "ayis", 10,
		[]Running{{ID: "i-a", Launched: first.Add(-72 * time.Hour)}}, first)
	if m.UsedHours != 2 {
		t.Errorf("a machine up since last month counts from the 1st: %v", m.UsedHours)
	}
}

func TestExtendMonthAdds(t *testing.T) {
	s := &fakeSSM{p: map[string]string{}}
	if total, _ := ExtendMonth(context.Background(), s, "ayis", 5, now); total != 5 {
		t.Errorf("first: %v", total)
	}
	if total, _ := ExtendMonth(context.Background(), s, "ayis", 2.5, now); total != 7.5 {
		t.Errorf("second adds: %v", total)
	}
	if s.p["/ayis/ayis/usage/2026-11-extra"] != "7.5" {
		t.Errorf("stored: %v", s.p)
	}
	if _, err := ExtendMonth(context.Background(), s, "ayis", 0, now); err == nil {
		t.Error("0 hours is not an extension")
	}
	// Next month starts from nothing: the extra is this month's.
	m, _ := ReadMonth(context.Background(), s, "ayis", 10, nil, now.AddDate(0, 1, 0))
	if m.ExtraHours != 0 {
		t.Errorf("next month: %+v", m)
	}
}

type fakeEC2 struct {
	inst []ec2types.Instance
	tags map[string]string
}

func (f *fakeEC2) DescribeInstances(context.Context, *ec2.DescribeInstancesInput, ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	return &ec2.DescribeInstancesOutput{Reservations: []ec2types.Reservation{{Instances: f.inst}}}, nil
}

func (f *fakeEC2) CreateTags(_ context.Context, in *ec2.CreateTagsInput, _ ...func(*ec2.Options)) (*ec2.CreateTagsOutput, error) {
	f.tags[in.Resources[0]+" "+*in.Tags[0].Key] = *in.Tags[0].Value
	return &ec2.CreateTagsOutput{}, nil
}

func TestSessionDeadlineAndExtend(t *testing.T) {
	launched := now.Add(-5 * time.Hour)
	i := ec2types.Instance{InstanceId: aws.String("i-a"), LaunchTime: &launched}
	if d := Deadline(launched, nil, 6); !d.Equal(now.Add(time.Hour)) {
		t.Errorf("deadline: %v", d)
	}
	f := &fakeEC2{tags: map[string]string{}}
	ss, err := ExtendSession(context.Background(), f, []ec2types.Instance{i}, 6, 2, now)
	if err != nil {
		t.Fatal(err)
	}
	// From the current end (1h away), not from now: an extension never shortens.
	if f.tags["i-a "+SessionUntilTag] != "2026-11-20T15:00:00Z" || ss[0].LeftMins != 180 {
		t.Errorf("tags %v, sessions %+v", f.tags, ss)
	}
	i.Tags = []ec2types.Tag{{Key: aws.String(SessionUntilTag), Value: aws.String("2026-11-20T15:00:00Z")}}
	if s := Sessions([]ec2types.Instance{i}, 6, now); s[0].LeftMins != 180 {
		t.Errorf("read back: %+v", s)
	}
	// Past the deadline already: from now.
	old := now.Add(-10 * time.Hour)
	f = &fakeEC2{tags: map[string]string{}}
	_, _ = ExtendSession(context.Background(), f, []ec2types.Instance{{InstanceId: aws.String("i-b"), LaunchTime: &old}}, 6, 1, now)
	if f.tags["i-b "+SessionUntilTag] != "2026-11-20T13:00:00Z" {
		t.Errorf("past deadline: %v", f.tags)
	}
	if _, err := ExtendSession(context.Background(), f, nil, 6, 1, now); err == nil {
		t.Error("no machine: nothing to extend")
	}
}

func TestPrincipalOf(t *testing.T) {
	for arn, want := range map[string]Principal{
		"arn:aws:iam::123456789012:user/CLI":                       {"user", "CLI"},
		"arn:aws:iam::123456789012:user/team/ayis":                 {"user", "ayis"},
		"arn:aws:sts::123456789012:assumed-role/Admin/me@corp.com": {"role", "Admin"},
	} {
		if got, err := PrincipalOf(arn); err != nil || got != want {
			t.Errorf("%s: %+v %v", arn, got, err)
		}
	}
	if _, err := PrincipalOf("arn:aws:iam::123456789012:root"); err == nil || !strings.Contains(err.Error(), "root") {
		t.Errorf("root must be refused, and say so: %v", err)
	}
}

func TestBlockPolicyOnlyThisHost(t *testing.T) {
	b, _ := json.Marshal(BlockPolicy("ayis"))
	s := string(b)
	for _, want := range []string{`"Effect":"Deny"`, `"ec2:RunInstances"`, `"ec2:StartInstances"`, `"aws:RequestTag/Name":"ayis"`, `"ec2:ResourceTag/Name":"ayis"`} {
		if !strings.Contains(s, want) {
			t.Errorf("block policy lacks %s: %s", want, s)
		}
	}
	if strings.Contains(s, `"Allow"`) || strings.Contains(s, `"ec2:*"`) {
		t.Errorf("the block only denies, and only launching and starting: %s", s)
	}
	r, _ := json.Marshal(actionRolePolicy("1", "ayis"))
	if !strings.Contains(string(r), `"iam:PolicyARN":"arn:aws:iam::1:policy/ayis-budget-block"`) {
		t.Errorf("the budget's role may attach only the block: %s", r)
	}
}

type fakeIAM struct {
	IAM
	attached []string
	calls    []string
	missing  bool
}

func (f *fakeIAM) ListEntitiesForPolicy(context.Context, *iam.ListEntitiesForPolicyInput, ...func(*iam.Options)) (*iam.ListEntitiesForPolicyOutput, error) {
	if f.missing {
		return nil, errors.New("NoSuchEntity: no policy")
	}
	o := &iam.ListEntitiesForPolicyOutput{}
	for _, u := range f.attached {
		o.PolicyUsers = append(o.PolicyUsers, iamtypes.PolicyUser{UserName: aws.String(u)})
	}
	return o, nil
}

func (f *fakeIAM) DetachUserPolicy(_ context.Context, in *iam.DetachUserPolicyInput, _ ...func(*iam.Options)) (*iam.DetachUserPolicyOutput, error) {
	f.calls = append(f.calls, "detach:"+*in.UserName)
	f.attached = nil
	return &iam.DetachUserPolicyOutput{}, nil
}

type fakeBudgets struct {
	Budgets
	status budgetstypes.ActionStatus
	calls  []string
}

func (f *fakeBudgets) DescribeBudgetActionsForBudget(context.Context, *budgets.DescribeBudgetActionsForBudgetInput, ...func(*budgets.Options)) (*budgets.DescribeBudgetActionsForBudgetOutput, error) {
	return &budgets.DescribeBudgetActionsForBudgetOutput{Actions: []budgetstypes.Action{{ActionId: aws.String("a1"), Status: f.status,
		Definition: &budgetstypes.Definition{IamActionDefinition: &budgetstypes.IamActionDefinition{PolicyArn: aws.String(BlockPolicyARN("1", "ayis"))}}}}}, nil
}

func (f *fakeBudgets) ExecuteBudgetAction(_ context.Context, in *budgets.ExecuteBudgetActionInput, _ ...func(*budgets.Options)) (*budgets.ExecuteBudgetActionOutput, error) {
	f.calls = append(f.calls, string(in.ExecutionType)+":"+*in.ActionId)
	return &budgets.ExecuteBudgetActionOutput{}, nil
}

func TestBlockedAndUnblock(t *testing.T) {
	ctx := context.Background()
	if on, err := Blocked(ctx, &fakeIAM{missing: true}, "1", "ayis"); on || err != nil {
		t.Errorf("no policy yet is not blocked: %v %v", on, err)
	}
	f := &fakeIAM{attached: []string{"CLI"}}
	if on, _ := Blocked(ctx, f, "1", "ayis"); !on {
		t.Error("attached is blocked")
	}
	// AWS Budgets is asked to reverse its action (so it stays off until next month),
	// and what is still attached after that is detached here.
	bu := &fakeBudgets{status: budgetstypes.ActionStatusExecutionSuccess}
	if err := (Block{IAM: f, Budgets: bu, Account: "1", Host: "ayis"}).Unblock(ctx); err != nil {
		t.Fatal(err)
	}
	if strings.Join(bu.calls, ",") != "REVERSE_BUDGET_ACTION:a1" || strings.Join(f.calls, ",") != "detach:CLI" {
		t.Errorf("budgets %v, iam %v", bu.calls, f.calls)
	}
	// An action that never ran is not reversed.
	bu = &fakeBudgets{status: budgetstypes.ActionStatusStandby}
	_ = (Block{IAM: &fakeIAM{}, Budgets: bu, Account: "1", Host: "ayis"}).Unblock(ctx)
	if len(bu.calls) != 0 {
		t.Errorf("standby must not be executed: %v", bu.calls)
	}
}

// The watchdog that enforces the limits is Python; these names are the contract.
func TestTheWatchdogReadsTheSameNames(t *testing.T) {
	b, err := os.ReadFile("../../lambda/ayis_watchdog/settings.py")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	for _, want := range []string{
		fmt.Sprintf("SESSION_UNTIL_TAG = %q", SessionUntilTag),
		fmt.Sprintf("LIMIT_WARN_MINUTES = %d", WarnMinutes),
	} {
		if !strings.Contains(src, want) {
			t.Errorf("lambda/ayis_watchdog/settings.py lacks %s", want)
		}
	}
}
