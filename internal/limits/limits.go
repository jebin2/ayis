// Package limits is the CLI side of the hard cost limits: the month's machine
// hours, one session's length, and the AWS budget's block. The cloud watchdog
// (lambda/ayis_watchdog/limits.py) is what ENFORCES them, every 5 minutes, on
// a machine that is running; this package reads where they stand, extends them
// when you ask, refuses to start a machine past one, and arms and undoes the
// budget's block.
//
// The idle guards end a machine nobody is using. These end one somebody IS
// using, because a bill has to have a ceiling that does not depend on anybody
// remembering to stop.
//
// All of it is free: the month's hours live in SSM standard parameters, the
// session's end in a tag on the instance, and the block is an IAM policy, a role
// and an action on the budget ayis already has - the first two action-enabled
// budgets in an account cost nothing.
package limits

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/jebin2/ayis/internal/ec2find"
)

// The tags and names the watchdog reads. They must match lambda/ayis_watchdog/settings.py (checked by a test).
const (
	SessionUntilTag = "ayis-session-until"
	// WarnMinutes is how long before a limit the watchdog warns.
	WarnMinutes = 30
)

// BlockPolicyName is the deny policy the budget attaches when it is spent.
func BlockPolicyName(host string) string { return host + "-budget-block" }

// BlockPolicyARN is where that policy is, whether or not it has been made yet.
func BlockPolicyARN(account, host string) string {
	return fmt.Sprintf("arn:aws:iam::%s:policy/%s", account, BlockPolicyName(host))
}

// ActionRoleName is the role AWS Budgets assumes to attach the block.
func ActionRoleName(host string) string { return host + "-budget-action" }

// BudgetName is the budget ayis arms (provision.Budget).
func BudgetName(host string) string { return host + "-monthly" }

func usageName(host string, now time.Time) string {
	return fmt.Sprintf("/ayis/%s/usage/%s", host, now.UTC().Format("2006-01"))
}

func extraName(host string, now time.Time) string { return usageName(host, now) + "-extra" }

// SSM is what reading and extending the month uses.
type SSM interface {
	GetParameter(context.Context, *ssm.GetParameterInput, ...func(*ssm.Options)) (*ssm.GetParameterOutput, error)
	PutParameter(context.Context, *ssm.PutParameterInput, ...func(*ssm.Options)) (*ssm.PutParameterOutput, error)
}

// EC2 is what reading and extending a session uses.
type EC2 interface {
	DescribeInstances(context.Context, *ec2.DescribeInstancesInput, ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error)
	CreateTags(context.Context, *ec2.CreateTagsInput, ...func(*ec2.Options)) (*ec2.CreateTagsOutput, error)
}

// IAMRead is what telling whether the budget's block is on uses.
type IAMRead interface {
	ListEntitiesForPolicy(context.Context, *iam.ListEntitiesForPolicyInput, ...func(*iam.Options)) (*iam.ListEntitiesForPolicyOutput, error)
}

func getParam(ctx context.Context, c SSM, name string) (string, bool, error) {
	o, err := c.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name)})
	if err != nil {
		var nf *ssmtypes.ParameterNotFound
		if errors.As(err, &nf) || strings.Contains(err.Error(), "ParameterNotFound") {
			return "", false, nil
		}
		return "", false, err
	}
	return aws.ToString(o.Parameter.Value), true, nil
}

// Month is where this calendar month (UTC, as AWS bills) stands.
type Month struct {
	UsedHours  float64 `json:"used_hours"`
	CapHours   float64 `json:"cap_hours"` // 0: no cap
	ExtraHours float64 `json:"extra_hours"`
	LeftHours  float64 `json:"left_hours"`
	Reached    bool    `json:"reached"`
}

// Running is a machine that is up now, for the month's count: its id and when
// this run of it started.
type Running struct {
	ID       string
	Launched time.Time
}

// ReadMonth is the month's hours. The watchdog's record is up to one check (5
// minutes) old, so a machine running now is counted from its LaunchTime, exactly
// as the watchdog counts it.
func ReadMonth(ctx context.Context, c SSM, host string, capHours int, running []Running, now time.Time) (Month, error) {
	m := Month{CapHours: float64(capHours)}
	raw, ok, err := getParam(ctx, c, usageName(host, now))
	if err != nil {
		return m, err
	}
	var u struct {
		Done float64            `json:"done"`
		Open map[string]float64 `json:"open"`
	}
	if ok {
		if err := json.Unmarshal([]byte(raw), &u); err != nil {
			return m, fmt.Errorf("the month's usage record is unreadable: %w", err)
		}
	}
	start := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	live := map[string]float64{}
	for _, r := range running {
		from := r.Launched
		if from.Before(start) {
			from = start
		}
		live[r.ID+"@"+r.Launched.UTC().Format("2006-01-02T15:04:05Z")] = math.Max(0, now.Sub(from).Seconds())
	}
	secs := u.Done
	for k, v := range u.Open {
		if _, up := live[k]; !up {
			secs += v
		}
	}
	for _, v := range live {
		secs += v
	}
	m.UsedHours = secs / 3600
	if capHours > 0 {
		x, ok, err := getParam(ctx, c, extraName(host, now))
		if err != nil {
			return m, err
		}
		if ok {
			if m.ExtraHours, err = strconv.ParseFloat(x, 64); err != nil {
				return m, fmt.Errorf("the month's extra hours are unreadable: %q", x)
			}
		}
		m.CapHours += m.ExtraHours
		m.LeftHours = math.Max(0, m.CapHours-m.UsedHours)
		m.Reached = m.UsedHours >= m.CapHours
	}
	return m, nil
}

// ExtendMonth adds hours to this month's cap only. Next month starts at the
// setting again: extending is a decision for this month, not a new limit.
func ExtendMonth(ctx context.Context, c SSM, host string, hours float64, now time.Time) (float64, error) {
	if hours <= 0 || hours > 744 {
		return 0, fmt.Errorf("hours must be between 1 and 744, not %g", hours)
	}
	cur := 0.0
	raw, ok, err := getParam(ctx, c, extraName(host, now))
	if err != nil {
		return 0, err
	}
	if ok {
		if cur, err = strconv.ParseFloat(raw, 64); err != nil {
			return 0, fmt.Errorf("the month's extra hours are unreadable: %q", raw)
		}
	}
	total := cur + hours
	_, err = c.PutParameter(ctx, &ssm.PutParameterInput{Name: aws.String(extraName(host, now)),
		Value: aws.String(strconv.FormatFloat(total, 'f', -1, 64)), Type: ssmtypes.ParameterTypeString, Overwrite: aws.Bool(true)})
	return total, err
}

// Session is where the running machine's session stands.
type Session struct {
	ID       string    `json:"id"`
	Started  time.Time `json:"started"`
	Ends     time.Time `json:"ends"`
	LeftMins int       `json:"left_minutes"`
}

func tagValue(tags []ec2types.Tag, key string) string {
	for _, t := range tags {
		if aws.ToString(t.Key) == key {
			return aws.ToString(t.Value)
		}
	}
	return ""
}

// Deadline is when a run of the machine must end: maxHours after it started, or
// later when it was extended. The watchdog's session_deadline, in Go.
func Deadline(launched time.Time, tags []ec2types.Tag, maxHours int) time.Time {
	d := launched.Add(time.Duration(maxHours) * time.Hour)
	if v := tagValue(tags, SessionUntilTag); v != "" {
		if t, err := time.Parse("2006-01-02T15:04:05Z", v); err == nil && t.After(d) {
			d = t
		}
	}
	return d
}

// Machines are this host's machines that are up.
func Machines(ctx context.Context, c EC2, host string) ([]ec2types.Instance, error) {
	return ec2find.Instances(ctx, c, host, ec2find.Up)
}

// Sessions is each running machine's session, when a session limit is set.
func Sessions(machines []ec2types.Instance, maxHours int, now time.Time) []Session {
	if maxHours <= 0 {
		return nil
	}
	var out []Session
	for _, i := range machines {
		if i.LaunchTime == nil {
			continue
		}
		end := Deadline(*i.LaunchTime, i.Tags, maxHours)
		out = append(out, Session{ID: aws.ToString(i.InstanceId), Started: *i.LaunchTime, Ends: end,
			LeftMins: int(math.Max(0, end.Sub(now).Minutes()))})
	}
	return out
}

// ExtendSession moves the end of every running machine's session to hours from
// now - or from its current end, when that is later: extending never shortens.
func ExtendSession(ctx context.Context, c EC2, machines []ec2types.Instance, maxHours int, hours float64, now time.Time) ([]Session, error) {
	if hours <= 0 || hours > 24 {
		return nil, fmt.Errorf("hours must be between 1 and 24, not %g", hours)
	}
	if len(machines) == 0 {
		return nil, errors.New("no machine is running - a session starts when you press Play")
	}
	var out []Session
	for _, i := range machines {
		from := now
		if maxHours > 0 && i.LaunchTime != nil {
			if d := Deadline(*i.LaunchTime, i.Tags, maxHours); d.After(from) {
				from = d
			}
		}
		end := from.Add(time.Duration(hours * float64(time.Hour))).UTC().Truncate(time.Second)
		if _, err := c.CreateTags(ctx, &ec2.CreateTagsInput{Resources: []string{aws.ToString(i.InstanceId)},
			Tags: []ec2types.Tag{{Key: aws.String(SessionUntilTag), Value: aws.String(end.Format("2006-01-02T15:04:05Z"))}}}); err != nil {
			return out, err
		}
		s := Session{ID: aws.ToString(i.InstanceId), Ends: end, LeftMins: int(end.Sub(now).Minutes())}
		if i.LaunchTime != nil {
			s.Started = *i.LaunchTime
		}
		out = append(out, s)
	}
	return out, nil
}

// Blocked says whether the budget's block is on: its policy attached to anyone.
// A policy not made yet is "not blocked".
func Blocked(ctx context.Context, c IAMRead, account, host string) (bool, error) {
	o, err := c.ListEntitiesForPolicy(ctx, &iam.ListEntitiesForPolicyInput{PolicyArn: aws.String(BlockPolicyARN(account, host))})
	if err != nil {
		if strings.Contains(err.Error(), "NoSuchEntity") {
			return false, nil
		}
		return false, err
	}
	return len(o.PolicyUsers)+len(o.PolicyRoles)+len(o.PolicyGroups) > 0, nil
}
