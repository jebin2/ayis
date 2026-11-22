package doctor

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/iam"

	"github.com/jebin2/ayis/internal/awscfg"
	"github.com/jebin2/ayis/internal/commands/creds"
	wdcmd "github.com/jebin2/ayis/internal/commands/watchdog"
	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/ec2find"
	"github.com/jebin2/ayis/internal/laptop"
	"github.com/jebin2/ayis/internal/limits"
	"github.com/jebin2/ayis/internal/local"
	"github.com/jebin2/ayis/internal/output"
	wd "github.com/jebin2/ayis/internal/watchdog"
)

// Run is `ayis doctor [--json]`. Read only, and free. It exits 1 when anything
// fails, so a script can use it.
func Run(ctx context.Context, env *config.Env, jsonFlag bool, out *output.Out) int {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cfg, cfgErr := awscfg.New(ctx, env.Region())
	host := env.Host()
	g := Gather{
		AWS: func(ctx context.Context) creds.AWS { return creds.AWSFacts(ctx, env) },
		TS:  func(ctx context.Context) creds.TS { return creds.TSFacts(ctx, env, laptop.New(local.Exec{})) },
		Watchdog: func(ctx context.Context) *wd.State {
			r, err := wdcmd.NewReader(ctx, env)
			if err != nil {
				return nil
			}
			st := r.Current(ctx)
			return &st
		},
		BoxExists: func(ctx context.Context) bool {
			if cfgErr != nil {
				return false
			}
			inst, err := ec2find.Instances(ctx, ec2.NewFromConfig(cfg), host, ec2find.Kept)
			return err == nil && len(inst) > 0
		},
		Blocked: func(ctx context.Context) *bool {
			a := creds.AWSFacts(ctx, env)
			if cfgErr != nil || a.Account == nil {
				return nil
			}
			b, err := limits.Blocked(ctx, iam.NewFromConfig(cfg), aws.ToString(a.Account), host)
			if err != nil {
				return nil
			}
			return &b
		},
		Locked: env.Locked(),
		Now:    time.Now,
	}
	r := Judge(g.Facts(ctx))
	if jsonFlag {
		b, err := r.JSON()
		if err != nil {
			out.Fail(err)
			return 1
		}
		fmt.Fprintln(out.Stdout, string(b))
	} else {
		out.Say("doctor")
		fmt.Fprint(out.Stdout, r.Text())
	}
	// In JSON the answer is the data, and a read that "failed" would hide it; a
	// script reading the plain words gets the exit status.
	if r.Worst == Fail && !jsonFlag {
		return 1
	}
	return 0
}
