package watchdog

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	awspricing "github.com/aws/aws-sdk-go-v2/service/pricing"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	ayis "github.com/jebin2/ayis"
	"github.com/jebin2/ayis/internal/awscfg"
	"github.com/jebin2/ayis/internal/bucket"
	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/limits"
	"github.com/jebin2/ayis/internal/output"
	"github.com/jebin2/ayis/internal/pricing"
	wd "github.com/jebin2/ayis/internal/watchdog"
)

// Reader builds the read-only watchdog reader for the settings in force: the
// settings decide what "as this repo would make it" means.
func NewReader(ctx context.Context, env *config.Env) (*wd.Reader, error) {
	region := env.Region()
	cfg, err := awscfg.New(ctx, region)
	if err != nil {
		return nil, err
	}
	us, err := awscfg.New(ctx, "us-east-1")
	if err != nil {
		return nil, err
	}
	src, err := wd.Package(ayis.Files, "lambda/"+wd.PackageDir)
	if err != nil {
		return nil, err
	}
	rates := ratesFrom(ctx, env, us)
	host := env.Host()
	return &wd.Reader{
		Lambda: lambda.NewFromConfig(cfg), Events: eventbridge.NewFromConfig(cfg), IAM: iam.NewFromConfig(cfg),
		Logs: cloudwatchlogs.NewFromConfig(cfg), SSM: ssm.NewFromConfig(cfg), Now: time.Now, Host: host, Region: region, Source: src,
		Settings: func(account string) wd.Settings { return SettingsFor(env, rates, account) },
	}, nil
}

func ratesFrom(ctx context.Context, env *config.Env, us aws.Config) pricing.Rates {
	products := pricing.SDKProducts{Client: awspricing.NewFromConfig(us)}
	r := pricing.Load(ctx, pricing.Options{Getenv: env.Get, Source: pricing.AWSSource{API: products}}, env.Region())
	// For the cost in a hard limit's notification. The Price List API is free.
	r.MachineHour = pricing.OnDemandHourly(ctx, products, env.Setting("GAME_INSTANCE_TYPE"), env.Region())
	return r
}

func ratesOf(ctx context.Context, env *config.Env) pricing.Rates {
	us, err := awscfg.New(ctx, "us-east-1")
	if err != nil {
		return pricing.Rates{}
	}
	return ratesFrom(ctx, env, us)
}

// SettingsFor is what the watchdog is deployed with, from .env and the prices
// as ayis has them today. The prices are written the way the shell wrote them
// (6 significant digits for AWS's, 10 for the rupee), because the text is
// hashed into the description of every function already deployed.
func SettingsFor(env *config.Env, rates pricing.Rates, account string) wd.Settings {
	host, region := env.Host(), env.Region()
	b := env.Get("GAME_S3_BUCKET")
	if b == "" {
		b = bucket.Name(account, host, region)
	}
	s := wd.Settings{Host: host, Account: account, Bucket: b,
		// The cloud watchdog is the backstop: it must never end a machine that its own
		// idle stop - which saves the games first - is still entitled to wait for.
		IdleMinutes: max(env.Int("GAME_WATCHDOG_IDLE_MIN"), env.Int("GAME_IDLE_MIN")+15), StuckMinutes: env.Int("GAME_WATCHDOG_STUCK_MIN"),
		ExpiryDays: env.Int("GAME_ARCHIVE_EXPIRY_DAYS"), NtfyURL: config.NtfyURL(env.Get("GAME_NTFY_URL")),
		NtfyToken:     env.Get("GAME_NTFY_TOKEN"),
		MaxHoursMonth: env.Int("GAME_MAX_HOURS_MONTH"), MaxSessionHours: env.Int("GAME_MAX_SESSION_HOURS"),
		BlockPolicyARN: limits.BlockPolicyARN(account, host)}
	if rates.S3GBMonth != nil {
		s.S3GBMonth = fmt.Sprintf("%.6g", *rates.S3GBMonth)
	}
	if rates.INRPerUSD != nil {
		s.INRPerUSD = fmt.Sprintf("%.10g", *rates.INRPerUSD)
	}
	if rates.MachineHour != nil {
		s.ODUSDHour = fmt.Sprintf("%.6g", *rates.MachineHour)
	}
	return s
}

// Run is `ayis watchdog`.
func Run(ctx context.Context, env *config.Env, args []string, watch bool, out *output.Out) int {
	sub := "status"
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	force := false
	for _, a := range args {
		switch a {
		case "--watch":
			watch = true
		case "--force":
			force = true
		}
	}
	switch sub {
	case "status", "logs", "check", "install", "remove", "rollback":
	default:
		out.Die("usage: ayis watchdog [status|check|logs [--watch]|install [--force]|rollback|remove]")
		return 1
	}
	r, err := NewReader(ctx, env)
	if err != nil {
		out.Fail(err)
		return 1
	}
	if sub == "check" || sub == "install" || sub == "remove" || sub == "rollback" {
		return mutateForce(ctx, env, r, sub, force, out)
	}
	if sub == "logs" {
		return Logs(ctx, r, watch, out.Stdout)
	}
	out.Report("Cloud watchdog", Status(ctx, r, env.Int("GAME_ARCHIVE_EXPIRY_DAYS")))
	return 0
}

// Logs prints what the schedule decided in the last three hours, and with
// watch keeps following it.
func Logs(ctx context.Context, r *wd.Reader, watch bool, w interface{ Write([]byte) (int, error) }) int {
	since := r.Now().Add(-3 * time.Hour)
	seen := map[string]bool{}
	for {
		evs, err := r.Since(ctx, "ayis-watchdog:", since)
		if err != nil {
			fmt.Fprintf(os.Stderr, "could not read %s: %v\n", wd.LogGroup(r.Host), err)
			return 1
		}
		for _, e := range evs {
			key := fmt.Sprintf("%d %s", e.MS, e.Msg)
			if seen[key] {
				continue
			}
			seen[key] = true
			fmt.Fprintf(w, "%s %s\n", time.UnixMilli(e.MS).UTC().Format("2006-01-02T15:04:05"), strings.TrimRight(e.Msg, "\n"))
			if t := time.UnixMilli(e.MS); t.After(since) {
				since = t
			}
		}
		if !watch {
			return 0
		}
		select {
		case <-ctx.Done():
			return 130
		case <-time.After(2 * time.Second):
		}
	}
}
