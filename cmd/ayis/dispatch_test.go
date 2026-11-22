package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/jebin2/ayis/internal/contract"
)

// The contract is what the app reads to know the commands; the handlers are
// what runs. A command in one and not the other is a button that fails, or a
// command the app cannot see.
func TestEveryCommandHasAHandler(t *testing.T) {
	named := map[string]bool{"help": true}
	for _, c := range contract.Registry {
		named[c.Path[0]] = true
		if handlers[c.Path[0]] == nil {
			t.Errorf("the contract lists %q but nothing runs it", c.Path[0])
		}
		for _, a := range c.Aliases {
			if got := canonical(a[0]); got != c.Path[0] {
				t.Errorf("alias %q resolves to %q, want %q", a[0], got, c.Path[0])
			}
		}
	}
	for name := range handlers {
		if !named[name] {
			t.Errorf("%q runs but is not in the contract: the app cannot know it", name)
		}
	}
	for name := range syncsAccount {
		if canonical(name) != name && !syncsAccount[canonical(name)] {
			t.Errorf("alias %q syncs but %q does not", name, canonical(name))
		}
	}
}

func runIt(t *testing.T, env map[string]string, args ...string) (int, string, string) {
	t.Helper()
	var o, e bytes.Buffer
	lookup := func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	rc := run(context.Background(), args, lookup, &o, &e)
	return rc, o.String(), e.String()
}

func TestHelpListsTheContract(t *testing.T) {
	for _, args := range [][]string{nil, {"help"}, {"--help"}, {"-h"}} {
		rc, out, _ := runIt(t, nil, args...)
		if rc != 0 || !strings.Contains(out, "ayis - All Yours, Instantly Streamed") {
			t.Fatalf("%v: rc=%d %q", args, rc, out)
		}
		for _, c := range contract.Registry {
			if !strings.Contains(out, "ayis "+c.Path[0]) {
				t.Errorf("%v: help lacks %s", args, c.Path[0])
			}
		}
	}
}

func TestFlagsAndUnknowns(t *testing.T) {
	if rc, out, _ := runIt(t, nil, "--version"); rc != 0 || !strings.HasPrefix(out, "ayis ") || !strings.Contains(out, "events ") {
		t.Errorf("--version: %d %q", rc, out)
	}
	if rc, out, _ := runIt(t, nil, "--contract"); rc != 0 || !strings.Contains(out, `"limits"`) {
		t.Errorf("--contract: %d", rc)
	}
	for _, bad := range [][]string{{"--nope"}, {"frobnicate"}, {"--region"}, {"--host"}} {
		if rc, out, errs := runIt(t, nil, bad...); rc != 1 {
			t.Errorf("%v should fail: %d %q %q", bad, rc, out, errs)
		}
	}
}

// The account sync must not run for a command that does not read account
// settings - help and deps work before AWS is set up.
func TestOnlyAccountCommandsSync(t *testing.T) {
	for _, name := range []string{"help", "deps", "notify", "ssh", "ping", "host", "regions", "quota", "machines", "sweep", "creds", "check", "cost", "aws"} {
		if syncsAccount[canonical(name)] {
			t.Errorf("%s syncs the account settings, which it does not read", name)
		}
	}
}

// Which forms of `ayis library` ask the box rather than the archive.
func TestWhichLibraryFormsAskTheBox(t *testing.T) {
	for _, c := range []struct {
		args []string
		box  bool
	}{
		{[]string{}, true}, // status
		{[]string{"push"}, true}, {[]string{"pull"}, true}, {[]string{"check"}, true},
		{[]string{"list"}, false}, {[]string{"forget", "1"}, false}, {[]string{"keep-for", "7"}, false},
		{[]string{"account", "push"}, true}, {[]string{"account", "--json", "pull"}, true},
		{[]string{"login", "restore"}, true}, {[]string{"account"}, false}, {[]string{"account", "show"}, false},
	} {
		if got := onBoxLibrary(firstArg(c.args, "status"), append([]string{firstArg(c.args, "status")}, tail(c.args)...)); got != c.box {
			t.Errorf("library %v: asks the box %v, want %v", c.args, got, c.box)
		}
	}
}

func tail(a []string) []string {
	if len(a) == 0 {
		return nil
	}
	return a[1:]
}
