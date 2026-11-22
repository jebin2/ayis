// Command ayis is the ayis CLI. This is the Go port: it is built beside
// the Bash ayis, one command at a time, and the Bash one is the oracle until the
// port is complete (docs/archive/go-plan.md).
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"syscall"

	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/contract"
	"github.com/jebin2/ayis/internal/output"
)

// version is set at release time with -ldflags "-X main.version=...".
var version string

func buildVersion() string {
	if version != "" {
		return version
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		var rev, dirty string
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value[:min(7, len(s.Value))]
			case "vcs.modified":
				if s.Value == "true" {
					dirty = "-dirty"
				}
			}
		}
		if rev != "" {
			return rev + dirty
		}
	}
	return "unknown"
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	rc := run(ctx, os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr)
	stop() // os.Exit skips deferred calls
	os.Exit(rc)
}

// repoDir is where ayis's files live: AYIS_REPO, else beside the binary.
func repoDir(get config.Lookup) string {
	if v, ok := get("AYIS_REPO"); ok && v != "" {
		return v
	}
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	return ""
}

func run(ctx context.Context, args []string, lookup config.Lookup, stdout, stderr io.Writer) (rc int) {
	ayisJSON, _ := lookup("AYIS_JSON")
	out := &output.Out{Stdout: stdout, Stderr: stderr, JSON: ayisJSON == "1"}
	// Every step ends - on success, on failure and on interrupt.
	defer func() {
		if ctx.Err() != nil {
			rc = 130
		}
		out.End(rc)
	}()
	overrides := map[string]string{}
	var jsonFlag, watchFlag bool
	get := func(k string) (string, bool) {
		if v, ok := overrides[k]; ok {
			return v, true
		}
		return lookup(k)
	}

	// Global flags come before the command, as in the Bash ayis.
	for len(args) > 0 && len(args[0]) > 0 && args[0][0] == '-' {
		switch args[0] {
		case "--json":
			jsonFlag, args = true, args[1:]
		case "--watch":
			watchFlag, args = true, args[1:]
		case "--region", "--host":
			if len(args) < 2 {
				out.Die(fmt.Sprintf("%s needs a value (see: ayis help)", args[0]))
				return 1
			}
			key := map[string]string{"--region": "GAME_REGION", "--host": "GAME_TS_HOST"}[args[0]]
			overrides[key] = args[1]
			args = args[2:]
		case "--version":
			fmt.Fprintf(stdout, "ayis %s\nevents %d\n", buildVersion(), contract.EventsVersion)
			return 0
		case "--contract":
			b, err := contract.JSON()
			if err != nil {
				out.Fail(err)
				return 1
			}
			fmt.Fprintf(stdout, "%s\n", b)
			return 0
		case "-h", "--help":
			args = []string{"help"}
		default:
			out.Die(fmt.Sprintf("unknown flag '%s' (see: ayis help)", args[0]))
			return 1
		}
	}
	cmd := "help"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	// Flags are also accepted after the subcommand, which is how people
	// actually type them.
	for _, a := range args {
		switch a {
		case "--json":
			jsonFlag = true
		case "--watch":
			watchFlag = true
		}
	}
	if syncsAccount[canonical(cmd)] {
		syncAccount(ctx, loadEnv(get, out), out)
	}
	cl := &call{ctx: ctx, get: get, args: args, json: jsonFlag, watch: watchFlag, out: out, stdout: stdout}
	h, ok := handlers[canonical(cmd)]
	if !ok {
		out.Die(fmt.Sprintf("unknown command '%s' (see: ayis help)", cmd))
		return 1
	}
	return h(cl)
}

func firstArg(args []string, def string) string {
	if len(args) > 0 {
		return args[0]
	}
	return def
}

// onBoxLibrary: the forms of `ayis library` that ask the box.
func onBoxLibrary(sub string, args []string) bool {
	switch sub {
	case "status", "push", "sync", "pull", "restore", "check":
		return true
	case "account", "login":
		// The word after any flags decides: account push/pull/restore ask the box.
		rest := accountRest(args[1:])
		return len(rest) > 0 && (rest[0] == "push" || rest[0] == "pull" || rest[0] == "restore")
	}
	return false
}

// accountRest drops the flags that come before the account word: flags are
// recognised globally but are not removed from the arguments.
func accountRest(args []string) []string {
	for len(args) > 0 && len(args[0]) > 0 && args[0][0] == '-' {
		args = args[1:]
	}
	return args
}
