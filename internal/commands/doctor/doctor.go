// Package doctor is `ayis doctor` (exit 1 when anything fails; with --json the
// verdict is in the data and it exits 0): one answer to "is everything that protects
// me and lets me play working?", from the readers the other commands already
// have - the AWS key, Tailscale, the cloud watchdog (with its dead-man signal),
// the budget's block, and the secrets the keychain holds. Each is ok, warn or
// fail with what to do; the worst is the answer, and the app's header shows it.
package doctor

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jebin2/ayis/internal/commands/creds"
	wd "github.com/jebin2/ayis/internal/watchdog"
)

// The states, in order of how bad.
const (
	OK   = "ok"
	Warn = "warn"
	Fail = "fail"
)

var rank = map[string]int{OK: 0, Warn: 1, Fail: 2}

// Item is one thing looked at.
type Item struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Text  string `json:"text"`
	Fix   string `json:"fix,omitempty"`
}

// Report is the answer.
type Report struct {
	Worst string `json:"worst"`
	Items []Item `json:"items"`
}

// Facts are what the readers found. A nil pointer is "not asked".
type Facts struct {
	AWS      creds.AWS
	TS       creds.TS
	Watchdog *wd.State
	// BoxExists: an AWS machine is there now; the watchdog matters most then.
	BoxExists bool
	Blocked   *bool // the budget's block is on; nil when it could not be read
	Locked    []string
	Now       time.Time
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Judge turns facts into the report. Pure: the tests drive it with faults.
func Judge(f Facts) Report {
	var items []Item
	add := func(name, state, text, fix string) { items = append(items, Item{name, state, text, fix}) }

	switch {
	case f.AWS.Valid != nil && *f.AWS.Valid:
		add("aws key", OK, "AWS accepts the key ("+str(f.AWS.Account)+")", "")
	case str(f.AWS.Reason) == "unreachable":
		add("aws key", Warn, "AWS could not be reached to check the key", "check the network, then run ayis doctor again")
	case str(f.AWS.Reason) == "no-key":
		add("aws key", Fail, "no AWS key is set", "ayis creds set")
	default:
		add("aws key", Fail, "AWS refused the key", "ayis creds set - a new key; ayis aws policy prints what it needs")
	}

	switch {
	case f.TS.SignedIn == nil:
		add("tailscale", Fail, "Tailscale is not installed here - the game PC is reached through it", "ayis check --fix")
	case !*f.TS.SignedIn:
		add("tailscale", Fail, "this computer is not signed in to Tailscale", "ayis creds tailscale signin")
	case f.TS.State == "rejected":
		add("tailscale", Warn, "signed in, but Tailscale refused the API token - old nodes are not cleaned up", "ayis creds tailscale set")
	default:
		add("tailscale", OK, "signed in as "+str(f.TS.Node), "")
	}

	keyWorks := f.AWS.Valid != nil && *f.AWS.Valid
	if !keyWorks {
		// Without a key AWS answers nothing, and "not installed" would be a guess.
		add("cloud watchdog", Warn, "not checked - it needs a working AWS key", "fix the key above, then run ayis doctor again")
	}
	if w := f.Watchdog; w != nil && keyWorks {
		switch {
		case !w.Installed && f.BoxExists:
			add("cloud watchdog", Fail, "not installed, and a machine exists - nothing outside it can stop it", "ayis watchdog install")
		case !w.Installed:
			add("cloud watchdog", OK, "not installed yet - every build installs it before launching", "")
		case w.Rule != "ENABLED":
			add("cloud watchdog", Fail, "installed but its schedule is "+strings.ToLower(orNone(w.Rule))+" - it does not run", "ayis watchdog install")
		case w.Heartbeat.Late(f.Now):
			add("cloud watchdog", Fail, "no check has finished cleanly for "+wd.Age(w.Heartbeat.At.UnixMilli(), f.Now)+" - it is not protecting you", "ayis watchdog - says why")
		case len(w.Drift) > 0:
			add("cloud watchdog", Warn, "running, but not as this version of ayis would make it: "+strings.Join(w.Drift, ", "), "ayis watchdog install")
		default:
			add("cloud watchdog", OK, "running every 5 minutes", "")
		}
	}

	switch {
	case f.Blocked == nil || !keyWorks:
	case *f.Blocked:
		add("budget", Fail, "this month's budget is spent - no machine can start", "ayis limits unblock, or wait for next month")
	default:
		add("budget", OK, "within this month's budget", "")
	}

	if len(f.Locked) > 0 {
		sort.Strings(f.Locked)
		add("keychain", Warn, "the system keychain did not give back "+strings.Join(f.Locked, ", "), "unlock it, or set them again")
	}

	worst := OK
	for _, it := range items {
		if rank[it.State] > rank[worst] {
			worst = it.State
		}
	}
	return Report{Worst: worst, Items: items}
}

func orNone(s string) string {
	if s == "" {
		return "missing"
	}
	return s
}

// Text is the report for a terminal.
func (r Report) Text() string {
	var b strings.Builder
	mark := map[string]string{OK: "ok  ", Warn: "warn", Fail: "FAIL"}
	for _, it := range r.Items {
		fmt.Fprintf(&b, "  %s  %-15s %s\n", mark[it.State], it.Name, it.Text)
		if it.Fix != "" && it.State != OK {
			fmt.Fprintf(&b, "        %-15s -> %s\n", "", it.Fix)
		}
	}
	fmt.Fprintf(&b, "\n  overall: %s\n", r.Worst)
	return b.String()
}

// JSON is the report as data.
func (r Report) JSON() ([]byte, error) { return json.MarshalIndent(r, "", "  ") }

// Gather reads every fact, in parallel where it can; ctx bounds the lot.
type Gather struct {
	AWS       func(context.Context) creds.AWS
	TS        func(context.Context) creds.TS
	Watchdog  func(context.Context) *wd.State
	BoxExists func(context.Context) bool
	Blocked   func(context.Context) *bool
	Locked    []string
	Now       func() time.Time
}

// Facts asks every reader.
func (g Gather) Facts(ctx context.Context) Facts {
	f := Facts{Locked: g.Locked, Now: g.Now()}
	done := make(chan func(), 5)
	go func() { a := g.AWS(ctx); done <- func() { f.AWS = a } }()
	go func() { t := g.TS(ctx); done <- func() { f.TS = t } }()
	go func() { w := g.Watchdog(ctx); done <- func() { f.Watchdog = w } }()
	go func() { b := g.BoxExists(ctx); done <- func() { f.BoxExists = b } }()
	go func() { b := g.Blocked(ctx); done <- func() { f.Blocked = b } }()
	for i := 0; i < 5; i++ {
		(<-done)()
	}
	return f
}
