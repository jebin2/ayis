package main

import (
	"context"
	"fmt"
	"io"
	"strconv"

	"github.com/jebin2/ayis/internal/commands/awscmd"
	"github.com/jebin2/ayis/internal/commands/boxcmd"
	"github.com/jebin2/ayis/internal/commands/check"
	"github.com/jebin2/ayis/internal/commands/configcmd"
	"github.com/jebin2/ayis/internal/commands/cost"
	"github.com/jebin2/ayis/internal/commands/creds"
	"github.com/jebin2/ayis/internal/commands/deps"
	"github.com/jebin2/ayis/internal/commands/games"
	"github.com/jebin2/ayis/internal/commands/hostcmd"
	"github.com/jebin2/ayis/internal/commands/initcmd"
	"github.com/jebin2/ayis/internal/commands/librarycmd"
	"github.com/jebin2/ayis/internal/commands/limitscmd"
	"github.com/jebin2/ayis/internal/commands/machines"
	"github.com/jebin2/ayis/internal/commands/notify"
	"github.com/jebin2/ayis/internal/commands/quota"
	"github.com/jebin2/ayis/internal/commands/regions"
	"github.com/jebin2/ayis/internal/commands/remote"
	"github.com/jebin2/ayis/internal/commands/snapshot"
	"github.com/jebin2/ayis/internal/commands/status"
	"github.com/jebin2/ayis/internal/commands/sweep"
	"github.com/jebin2/ayis/internal/commands/watchdog"
	"github.com/jebin2/ayis/internal/commands/watcher"
	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/contract"
	"github.com/jebin2/ayis/internal/output"
)

// The commands, one function each, found by name in `handlers`. The names and
// aliases are the contract's (internal/contract): TestEveryCommandHasAHandler
// fails the build when the two disagree.

func cmdHelp(cl *call) int {
	fmt.Fprintln(cl.stdout, "ayis - All Yours, Instantly Streamed")
	fmt.Fprintln(cl.stdout)
	for _, c := range contract.Registry {
		fmt.Fprintf(cl.stdout, "  ayis %-10s %s\n", c.Path[0], c.Summary)
	}
	return 0
}

func cmdNotify(cl *call) int {
	return notify.Send(cl.ctx, nil, cl.env(), cl.out)
}

func cmdGames(cl *call) int {
	return games.Run(cl.ctx, cl.env(), cl.args, cl.out)
}

func cmdAws(cl *call) int {
	return awscmd.Run(cl.ctx, cl.env(), cl.args, cl.json, cl.out)
}

func cmdSnapshot(cl *call) int {
	sub := "create"
	if len(cl.args) > 0 {
		sub = cl.args[0]
	}
	switch sub {
	case "--list", "list":
		return snapshot.Run(cl.ctx, cl.env(), cl.args, cl.json, cl.out)
	case "create", "", "--no-wait":
		d, _, err := boxcmd.New(cl.ctx, cl.get, cl.env(), cl.out)
		if err != nil {
			cl.out.Die(err.Error())
			return 1
		}
		wait := true
		for _, a := range cl.args {
			if a == "--no-wait" {
				wait = false
			}
		}
		return d.SnapshotCreateWith(cl.ctx, wait)
	case "--delete", "delete":
		d, c, err := boxcmd.New(cl.ctx, cl.get, cl.env(), cl.out)
		if err != nil {
			cl.out.Die(err.Error())
			return 1
		}
		id := ""
		if len(cl.args) > 1 {
			id = cl.args[1]
		}
		return d.SnapshotDelete(cl.ctx, id, c)
	}
	cl.out.Die("usage: ayis snapshot [create|--list|--delete <id>]")
	return 1
}

func cmdInit(cl *call) int {
	env := cl.env()
	i, err := initcmd.New(cl.ctx, cl.get, env, cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	return i.Run(cl.ctx)
}

func cmdOpen(cl *call) int {
	env := cl.env()
	if len(cl.args) > 0 && cl.args[0] == "--on" {
		name := ""
		if len(cl.args) > 1 {
			name = cl.args[1]
		}
		return hostcmd.Run(cl.ctx, hostcmd.New(cl.get, env, cl.out), []string{"open", name}, false, cl.out)
	}
	d, c, err := boxcmd.New(cl.ctx, cl.get, env, cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	// --extra-gb N --extra-apps 1,2: make a games disk and bring those games
	// onto it (what Play asks after the disk was removed).
	for i := 0; i+1 < len(cl.args); i++ {
		switch cl.args[i] {
		case "--extra-gb":
			d.ExtraGB, _ = strconv.Atoi(cl.args[i+1])
		case "--extra-apps":
			d.ExtraApps = cl.args[i+1]
		case "--games":
			d.Games = cl.args[i+1]
		}
	}
	if d.ExtraGB > 0 {
		d.DiskAWS = c
	}
	return d.Open(cl.ctx)
}

func cmdStop(cl *call) int {
	env := cl.env()
	d, c, err := boxcmd.New(cl.ctx, cl.get, env, cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	d.WithDestroy(env, c)
	return d.Stop(cl.ctx, cl.args)
}

func cmdDestroy(cl *call) int {
	env := cl.env()
	d, c, err := boxcmd.New(cl.ctx, cl.get, env, cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	x, err := boxcmd.NewDestroyDeps(cl.ctx, env, c, cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	return d.DestroyBox(cl.ctx, x, cl.args)
}

func cmdClean(cl *call) int {
	d, _, err := boxcmd.New(cl.ctx, cl.get, cl.env(), cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	return d.Clean(cl.ctx)
}

func cmdDisk(cl *call) int {
	d, c, err := boxcmd.New(cl.ctx, cl.get, cl.env(), cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	if len(cl.args) > 0 && cl.args[0] == "remove" || cl.json {
		if x, xerr := boxcmd.NewDestroyDeps(cl.ctx, cl.env(), c, cl.out); xerr == nil {
			d.Pushed = x.PushedFunc()
		}
	}
	if len(cl.args) > 0 && cl.args[0] == "remove" {
		// --unsaved-ok: the app's Stop machine has shown what is on the disk and
		// not saved, and the person chose to lose it with the disk.
		for _, a := range cl.args[1:] {
			if a == "--unsaved-ok" {
				d.UnsavedOK = true
			}
		}
		return d.RemoveDisk(cl.ctx, c)
	}
	if len(cl.args) > 0 && cl.args[0] == "add" {
		gb := 0
		if len(cl.args) > 1 {
			gb, _ = strconv.Atoi(cl.args[1])
		}
		return d.AddDisk(cl.ctx, c, gb)
	}
	return d.Disk(cl.ctx, c, cl.json)
}

func cmdClip(cl *call) int {
	d, _, err := boxcmd.New(cl.ctx, cl.get, cl.env(), cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	switch {
	case len(cl.args) > 0 && cl.args[0] == "send":
		return d.ClipSend(cl.ctx)
	case len(cl.args) > 0 && cl.args[0] == "get":
		return d.ClipGet(cl.ctx)
	}
	cl.out.Die("usage: ayis clip send | get")
	return 1
}

func cmdPair(cl *call) int {
	d, _, err := boxcmd.New(cl.ctx, cl.get, cl.env(), cl.out)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	return d.PairMoonlight(cl.ctx)
}

func cmdHost(cl *call) int {
	return hostcmd.Run(cl.ctx, hostcmd.New(cl.get, cl.env(), cl.out), cl.args, cl.json, cl.out)
}

func cmdLibrary(cl *call) int {
	if sub := firstArg(cl.args, "status"); onBoxLibrary(sub, cl.args) {
		d, _, err := boxcmd.New(cl.ctx, cl.get, cl.env(), cl.out)
		if err != nil {
			cl.out.Die(err.Error())
			return 1
		}
		rest := []string{}
		if len(cl.args) > 1 {
			rest = cl.args[1:]
		}
		if sub == "account" || sub == "login" {
			rest = accountRest(cl.args[1:])
			sub = "account"
		}
		return d.Library(cl.ctx, sub, rest)
	}
	return librarycmd.Run(cl.ctx, cl.env(), cl.get, cl.args, cl.json, cl.out)
}

func cmdRegions(cl *call) int {
	return regions.Run(cl.ctx, cl.env(), cl.args, cl.json, cl.out)
}

func cmdLimits(cl *call) int {
	return limitscmd.Run(cl.ctx, cl.env(), cl.args, cl.json, cl.out)
}

func cmdQuota(cl *call) int {
	return quota.Run(cl.ctx, cl.env(), cl.get, cl.args, cl.json, cl.out)
}

func cmdSweep(cl *call) int {
	return sweep.Run(cl.ctx, cl.env(), cl.get, cl.args, cl.json, cl.out)
}

func cmdMachines(cl *call) int {
	// `ayis machines [region] --sweep` is the sweep, whatever region was named.
	for i, a := range cl.args {
		if a == "--sweep" || a == "sweep" {
			rest := append(append([]string{}, cl.args[:i]...), cl.args[i+1:]...)
			if len(rest) > 0 && machines.IsRegion(rest[0]) {
				rest = rest[1:]
			}
			return sweep.Run(cl.ctx, cl.env(), cl.get, rest, cl.json, cl.out)
		}
	}
	return machines.Run(cl.ctx, cl.env(), cl.get, cl.args, cl.json, cl.out)
}

func cmdCheck(cl *call) int {
	return check.Run(cl.ctx, cl.env(), cl.args, cl.out)
}

func cmdDeps(cl *call) int {
	return deps.Main(cl.ctx, cl.args, cl.json, cl.out)
}

func cmdCreds(cl *call) int {
	return creds.Run(cl.ctx, cl.env(), cl.args, cl.json, cl.out)
}

func cmdConfig(cl *call) int {
	cfgEnv := cl.env()
	rc := configcmd.Run(cfgEnv, cl.args, cl.json, cl.out, shareSetting(cl.ctx, cfgEnv))
	// A hard limit is enforced by the cloud watchdog, which carries it: a new
	// figure takes effect now, not at the next build. Only an installed
	// watchdog is redeployed - with none, the next build installs it with this.
	if rc == 0 && len(cl.args) >= 2 && cl.args[0] == "set" && (cl.args[1] == "GAME_MAX_HOURS_MONTH" || cl.args[1] == "GAME_MAX_SESSION_HOURS") {
		if r, err := watchdog.NewReader(cl.ctx, cl.env()); err == nil && r.Current(cl.ctx).Installed {
			return watchdog.Reinstall(cl.ctx, cl.env(), cl.out)
		}
	}
	return rc
}

func cmdPing(cl *call) int {
	return remote.RunPing(cl.ctx, cl.env(), cl.args, cl.json, cl.watch, cl.out)
}

func cmdLog(cl *call) int {
	return remote.RunLog(cl.ctx, cl.env(), cl.args, cl.out)
}

func cmdSsh(cl *call) int {
	return remote.RunSSH(cl.ctx, cl.env(), cl.args, cl.out)
}

func cmdWatcher(cl *call) int {
	opts, err := watcher.ParseArgs(cl.args)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	return watcher.Run(cl.ctx, cl.env(), opts, cl.out)
}

func cmdWatchdog(cl *call) int {
	watch := false
	for _, a := range cl.args {
		watch = watch || a == "--watch"
	}
	return watchdog.Run(cl.ctx, cl.env(), cl.args, watch, cl.out)
}

func cmdStatus(cl *call) int {
	opts, err := status.ParseArgs(cl.args)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	return status.Run(cl.ctx, cl.env(), cl.get, opts, cl.out)
}

func cmdCost(cl *call) int {
	opts, err := cost.ParseArgs(cl.args)
	if err != nil {
		cl.out.Die(err.Error())
		return 1
	}
	return cost.Run(cl.ctx, cl.env(), cl.get, opts, cl.out)
}

// handlers is every command by its name; aliases come from the contract.
var handlers = map[string]func(*call) int{
	"help":     cmdHelp,
	"notify":   cmdNotify,
	"games":    cmdGames,
	"aws":      cmdAws,
	"snapshot": cmdSnapshot,
	"init":     cmdInit,
	"open":     cmdOpen,
	"stop":     cmdStop,
	"destroy":  cmdDestroy,
	"clean":    cmdClean,
	"disk":     cmdDisk,
	"clip":     cmdClip,
	"pair":     cmdPair,
	"host":     cmdHost,
	"library":  cmdLibrary,
	"regions":  cmdRegions,
	"limits":   cmdLimits,
	"quota":    cmdQuota,
	"sweep":    cmdSweep,
	"machines": cmdMachines,
	"check":    cmdCheck,
	"deps":     cmdDeps,
	"creds":    cmdCreds,
	"config":   cmdConfig,
	"ping":     cmdPing,
	"log":      cmdLog,
	"ssh":      cmdSsh,
	"watcher":  cmdWatcher,
	"watchdog": cmdWatchdog,
	"status":   cmdStatus,
	"cost":     cmdCost,
}

// call is one run of a command: what it was given.
type call struct {
	ctx         context.Context
	get         config.Lookup
	args        []string
	json, watch bool
	out         *output.Out
	stdout      io.Writer
}

// env is the settings, read fresh: a command that writes one reads it back.
func (cl *call) env() *config.Env { return config.Load(cl.get, repoDir(cl.get)) }

// canonical is a command's own name for any of its names: "up" is "open".
func canonical(name string) string {
	for _, cmd := range contract.Registry {
		if cmd.Path[0] == name {
			return name
		}
		for _, a := range cmd.Aliases {
			if len(a) > 0 && a[0] == name {
				return cmd.Path[0]
			}
		}
	}
	return name
}
