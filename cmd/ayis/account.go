package main

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/jebin2/ayis/internal/accountcfg"
	"github.com/jebin2/ayis/internal/awscfg"
	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/output"
)

// syncsAccount are the commands that read account settings (config.IsAccount):
// they bring this computer's copy up to date first, so two computers driving
// one account cannot deploy the watchdog, build a box or show the Safety page
// from different values (ADR-0002).
var syncsAccount = map[string]bool{
	"init": true, "open": true, "up": true, "stop": true, "down": true, "destroy": true,
	"status": true, "config": true, "watchdog": true, "watcher": true, "guards": true,
	"limits": true, "library": true, "lib": true, "disk": true,
}

// accountSSM is the SSM client for the settings' region.
func accountSSM(ctx context.Context, env *config.Env) (*ssm.Client, error) {
	cfg, err := awscfg.New(ctx, env.Region())
	if err != nil {
		return nil, err
	}
	return ssm.NewFromConfig(cfg), nil
}

// syncAccount brings .env up to date with the account, and moves this computer's
// settings up the first time. Quiet unless something moved: an account that
// cannot be reached leaves the copy as it is, and the commands that need AWS say
// so themselves. AYIS_NO_ACCOUNT_SYNC=1 turns it off (the test suites set it).
func syncAccount(ctx context.Context, env *config.Env, out *output.Out) {
	if accountcfg.Off(env) {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	c, err := accountSSM(ctx, env)
	if err != nil {
		return
	}
	changes, _ := accountcfg.Sync(ctx, c, env)
	for _, ch := range changes {
		say(out, describe(ch))
	}
}

func describe(ch accountcfg.Change) string {
	show := func(v string) string {
		if v == "" {
			return "empty"
		}
		if s, _ := config.Find(ch.Key); s.Kind == "ntfy" || s.Kind == "secret" {
			return "set"
		}
		return v
	}
	if ch.Up {
		return fmt.Sprintf("settings: %s = %s shared with your AWS account, so every computer uses it", ch.Key, show(ch.To))
	}
	return fmt.Sprintf("settings: %s is now %s, as changed on another computer (was %s here)", ch.Key, show(ch.To), show(ch.From))
}

// say is a notice that must never land in a command's data on stdout: an
// event for the app, a line on stderr for a person.
func say(out *output.Out, text string) {
	if out.JSON {
		out.LogAs("info", text)
		return
	}
	fmt.Fprintln(out.Stderr, text)
}

// shareSetting is how `ayis config set` tells the account about an account
// setting. An error means it is saved on this computer only, and pending.
func shareSetting(ctx context.Context, env *config.Env) func(key, value string) error {
	return accountcfg.Sharer(ctx, env)
}
