// Package limitscmd is `ayis limits`: where the hard cost limits stand, and the
// three ways past one - more hours this month, a longer session, or lifting the
// budget's block. The limits themselves are enforced by the cloud watchdog.
package limitscmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/budgets"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/sts"

	"github.com/jebin2/ayis/internal/awscfg"
	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/limits"
	"github.com/jebin2/ayis/internal/output"
)

const usage = "usage: ayis limits [status|extend-month <hours>|extend-session [hours]|unblock|arm] [--json]"

// Status is `ayis limits --json`, which the app reads.
type Status struct {
	Month         limits.Month     `json:"month"`
	MonthError    string           `json:"month_error,omitempty"`
	SessionHours  int              `json:"session_hours"`
	Sessions      []limits.Session `json:"sessions"`
	BudgetBlocked bool             `json:"budget_blocked"`
	// BudgetArmed: the budget carries the block. Nil when it could not be read.
	BudgetArmed    *bool  `json:"budget_armed"`
	BudgetError    string `json:"budget_error,omitempty"`
	WarnMinutes    int    `json:"warn_minutes"`
	MonthResetsUTC string `json:"month_resets"`
}

// Read is where every limit stands now. b, when not nil, says whether the
// budget carries the block.
func Read(ctx context.Context, env *config.Env, s limits.SSM, e limits.EC2, i limits.IAMRead, b limits.Budgets, account string, now time.Time) Status {
	host := env.Host()
	st := Status{SessionHours: env.Int("GAME_MAX_SESSION_HOURS"), WarnMinutes: limits.WarnMinutes,
		MonthResetsUTC: time.Date(now.UTC().Year(), now.UTC().Month()+1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)}
	machines, err := limits.Machines(ctx, e, host)
	if err != nil {
		st.MonthError = "AWS could not be asked which machine is running: " + err.Error()
	}
	var run []limits.Running
	for _, m := range machines {
		if m.LaunchTime != nil {
			run = append(run, limits.Running{ID: aws.ToString(m.InstanceId), Launched: *m.LaunchTime})
		}
	}
	if st.Month, err = limits.ReadMonth(ctx, s, host, env.Int("GAME_MAX_HOURS_MONTH"), run, now); err != nil {
		st.MonthError = err.Error()
	}
	st.Sessions = limits.Sessions(machines, st.SessionHours, now)
	if st.Sessions == nil {
		st.Sessions = []limits.Session{}
	}
	if st.BudgetBlocked, err = limits.Blocked(ctx, i, account, host); err != nil {
		st.BudgetError = err.Error()
	}
	if b != nil {
		if armed, err := (limits.Block{Budgets: b, Account: account, Host: host}).Armed(ctx); err == nil {
			st.BudgetArmed = &armed
		}
	}
	return st
}

// Refusal is why a machine must not start now, or "" when it may. Read before
// `ayis open` starts a stopped machine and before `ayis init` launches one: the
// watchdog would end it within 5 minutes anyway, after it had billed a boot.
// Not being able to tell is not a refusal - the watchdog still enforces.
func Refusal(st Status) string {
	if st.BudgetBlocked {
		return "this month's AWS budget is spent, so no machine can start. Raise the budget or run `ayis limits unblock` (Safety in the app) - it lifts until next month"
	}
	if st.MonthError == "" && st.Month.CapHours > 0 && st.Month.Reached {
		return fmt.Sprintf("this month's %.0f play hours are used up. Add hours with `ayis limits extend-month <hours>` (Safety in the app), or wait for the month to end", st.Month.CapHours)
	}
	return ""
}

type clients struct {
	ssm     *ssm.Client
	ec2     *ec2.Client
	iam     *iam.Client
	budgets *budgets.Client
	account string
	cfg     aws.Config
}

func connect(ctx context.Context, env *config.Env) (clients, error) {
	cfg, err := awscfg.New(ctx, env.Region())
	if err != nil {
		return clients{}, err
	}
	us, err := awscfg.New(ctx, "us-east-1")
	if err != nil {
		return clients{}, err
	}
	id, err := sts.NewFromConfig(cfg).GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return clients{}, fmt.Errorf("AWS could not say which account this is: %w", err)
	}
	return clients{ssm: ssm.NewFromConfig(cfg), ec2: ec2.NewFromConfig(cfg), iam: iam.NewFromConfig(cfg),
		budgets: budgets.NewFromConfig(us), account: aws.ToString(id.Account), cfg: cfg}, nil
}

// Check is the refusal for a start, from the real AWS. "" on any failure to ask.
func Check(ctx context.Context, env *config.Env) string {
	c, err := connect(ctx, env)
	if err != nil {
		return ""
	}
	return Refusal(Read(ctx, env, c.ssm, c.ec2, c.iam, nil, c.account, time.Now()))
}

func hoursArg(args []string, def float64) (float64, error) {
	if len(args) == 0 {
		if def > 0 {
			return def, nil
		}
		return 0, fmt.Errorf("how many hours? %s", usage)
	}
	return strconv.ParseFloat(args[0], 64)
}

// Run is `ayis limits`.
func Run(ctx context.Context, env *config.Env, args []string, jsonFlag bool, out *output.Out) int {
	sub := "status"
	var rest []string
	for _, a := range args {
		switch {
		case a == "--json":
			jsonFlag = true
		case sub == "status" && len(rest) == 0 && (a == "status" || a == "extend-month" || a == "extend-session" || a == "unblock" || a == "arm"):
			sub = a
		default:
			rest = append(rest, a)
		}
	}
	if sub == "status" && len(rest) > 0 {
		out.Die(usage)
		return 1
	}
	c, err := connect(ctx, env)
	if err != nil {
		out.Fail(err)
		return 1
	}
	host, now := env.Host(), time.Now()
	switch sub {
	case "extend-month":
		h, err := hoursArg(rest, 0)
		if err != nil {
			out.Fail(err)
			return 1
		}
		total, err := limits.ExtendMonth(ctx, c.ssm, host, h, now)
		if err != nil {
			out.Die("could not add hours: " + err.Error())
			return 1
		}
		out.Say(fmt.Sprintf("added %g hours to this month - %g extra in all, until the month ends", h, total))
	case "extend-session":
		h, err := hoursArg(rest, 1)
		if err != nil {
			out.Fail(err)
			return 1
		}
		ms, err := limits.Machines(ctx, c.ec2, host)
		if err == nil {
			_, err = limits.ExtendSession(ctx, c.ec2, ms, env.Int("GAME_MAX_SESSION_HOURS"), h, now)
		}
		if err != nil {
			out.Die("could not extend the session: " + err.Error())
			return 1
		}
		out.Say(fmt.Sprintf("session extended by %g hours", h))
	case "unblock":
		b := limits.Block{IAM: c.iam, Budgets: c.budgets, Account: c.account, Host: host, Out: out.Log, Sleep: time.Sleep}
		if err := b.Unblock(ctx); err != nil {
			out.Die("could not lift the budget's block: " + err.Error())
			return 1
		}
		out.Say("the budget's block is lifted until next month - raise GAME_BUDGET_INR to be warned again at the new figure")
	case "arm":
		// What `ayis init` does before a build, for a machine built before there was
		// a block: the budget must already exist, which every build makes.
		id, err := sts.NewFromConfig(c.cfg).GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
		if err != nil {
			out.Die("AWS could not say who this is: " + err.Error())
			return 1
		}
		p, err := limits.PrincipalOf(aws.ToString(id.Arn))
		if err != nil {
			out.Fail(err)
			return 1
		}
		var to []string
		email := env.Get("GAME_ALERT_EMAIL")
		if email == "" {
			email = env.Get("EMAIL_ALERTS")
		}
		for _, e := range strings.Split(email, ",") {
			if e = strings.TrimSpace(e); e != "" {
				to = append(to, e)
			}
		}
		if len(to) == 0 {
			out.Die("no alert email is set (EMAIL_ALERTS) - AWS needs someone to tell before it can block")
			return 1
		}
		b := limits.Block{IAM: c.iam, Budgets: c.budgets, Account: c.account, Host: host, Out: out.Log, Sleep: time.Sleep}
		if err := b.Arm(ctx, p, to); err != nil {
			out.Fail(err)
			return 1
		}
	}
	st := Read(ctx, env, c.ssm, c.ec2, c.iam, c.budgets, c.account, now)
	if jsonFlag {
		b, _ := json.MarshalIndent(st, "", "  ")
		fmt.Fprintf(out.Stdout, "%s\n", b)
		return 0
	}
	if sub != "status" {
		return 0
	}
	show(st, out)
	return 0
}

// show is the human view of where the limits stand.
func show(st Status, out *output.Out) {
	out.Say("hard limits")
	switch {
	case st.MonthError != "":
		out.LogAs("fail", "play hours this month: unknown - "+st.MonthError)
	case st.Month.CapHours == 0:
		out.Log(fmt.Sprintf("play hours this month: %.1f, no limit (GAME_MAX_HOURS_MONTH=0)", st.Month.UsedHours))
	default:
		kind := "ok"
		if st.Month.Reached {
			kind = "fail"
		}
		extra := ""
		if st.Month.ExtraHours > 0 {
			extra = fmt.Sprintf(" (%g added this month)", st.Month.ExtraHours)
		}
		out.LogAs(kind, fmt.Sprintf("play hours this month: %.1f of %.0f%s - %.1f left", st.Month.UsedHours, st.Month.CapHours, extra, st.Month.LeftHours))
	}
	if st.SessionHours == 0 {
		out.Log("session limit: off (GAME_MAX_SESSION_HOURS=0)")
	} else if len(st.Sessions) == 0 {
		out.Log(fmt.Sprintf("session limit: %d hours - no machine running", st.SessionHours))
	}
	for _, s := range st.Sessions {
		out.Log(fmt.Sprintf("session: %s switches off at %s (%d min left)", s.ID, s.Ends.Local().Format("15:04"), s.LeftMins))
	}
	switch {
	case st.BudgetError != "":
		out.LogAs("fail", "budget block: unknown - "+st.BudgetError)
	case st.BudgetBlocked:
		out.LogAs("fail", "budget block: ON - the month's budget is spent; `ayis limits unblock` lifts it")
	case st.BudgetArmed != nil && !*st.BudgetArmed:
		out.LogAs("warn", "budget block: not set up - `ayis limits arm` (or the next build) sets it up")
	default:
		out.LogAs("ok", "budget block: off")
	}
}
