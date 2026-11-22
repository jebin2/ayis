package doctor

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jebin2/ayis/internal/commands/creds"
	wd "github.com/jebin2/ayis/internal/watchdog"
)

var now = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

func p[T any](v T) *T { return &v }

// Everything working.
func healthy() Facts {
	return Facts{
		AWS: creds.AWS{Valid: p(true), Account: p("123456789012")},
		TS:  creds.TS{SignedIn: p(true), Node: p("laptop"), State: "ok"},
		Watchdog: &wd.State{Installed: true, Rule: "ENABLED",
			Heartbeat: wd.Heartbeat{Known: true, Found: true, At: now.Add(-3 * time.Minute)}},
		BoxExists: true, Blocked: p(false), Now: now,
	}
}

func item(r Report, name string) Item {
	for _, it := range r.Items {
		if it.Name == name {
			return it
		}
	}
	return Item{}
}

func TestHealthyIsOK(t *testing.T) {
	r := Judge(healthy())
	if r.Worst != OK {
		t.Errorf("%+v", r)
	}
}

// Each fault on its own turns the answer red, names what broke, and says what to do.
func TestEachFaultIsRedAndSaysWhatToDo(t *testing.T) {
	for _, c := range []struct {
		name, item, want string
		break_           func(*Facts)
	}{
		{"the key refused", "aws key", "AWS refused the key", func(f *Facts) { f.AWS = creds.AWS{Valid: p(false), Reason: p("rejected")} }},
		{"no key", "aws key", "no AWS key is set", func(f *Facts) { f.AWS = creds.AWS{Reason: p("no-key")} }},
		{"not on the tailnet", "tailscale", "not signed in to Tailscale", func(f *Facts) { f.TS.SignedIn = p(false) }},
		{"no Tailscale", "tailscale", "not installed here", func(f *Facts) { f.TS.SignedIn = nil }},
		{"watchdog late", "cloud watchdog", "no check has finished cleanly for 40 min", func(f *Facts) { f.Watchdog.Heartbeat.At = now.Add(-40 * time.Minute) }},
		{"watchdog disabled", "cloud watchdog", "its schedule is disabled", func(f *Facts) { f.Watchdog.Rule = "DISABLED" }},
		{"watchdog missing with a machine", "cloud watchdog", "not installed, and a machine exists", func(f *Facts) { f.Watchdog.Installed = false }},
		{"budget spent", "budget", "budget is spent", func(f *Facts) { f.Blocked = p(true) }},
	} {
		f := healthy()
		c.break_(&f)
		r := Judge(f)
		it := item(r, c.item)
		if r.Worst != Fail || it.State != Fail || !strings.Contains(it.Text, c.want) || it.Fix == "" {
			t.Errorf("%s: worst %s, %+v", c.name, r.Worst, it)
		}
	}
}

func TestSoftProblemsAreWarnings(t *testing.T) {
	for _, c := range []struct {
		name   string
		break_ func(*Facts)
	}{
		{"AWS unreachable", func(f *Facts) { f.AWS = creds.AWS{Reason: p("unreachable")} }},
		{"Tailscale token refused", func(f *Facts) { f.TS.State = "rejected" }},
		{"watchdog drifted", func(f *Facts) { f.Watchdog.Drift = []string{"code"} }},
		{"keychain locked", func(f *Facts) { f.Locked = []string{"TAILSCALE_API_KEY"} }},
	} {
		f := healthy()
		c.break_(&f)
		if r := Judge(f); r.Worst != Warn {
			t.Errorf("%s: %+v", c.name, r)
		}
	}
	// No machine, no watchdog yet: that is how a fresh account looks, not a fault.
	f := healthy()
	f.BoxExists, f.Watchdog.Installed = false, false
	if r := Judge(f); r.Worst != OK {
		t.Errorf("fresh account: %+v", r)
	}
}

func TestGatherAsksEveryReader(t *testing.T) {
	g := Gather{
		AWS:       func(context.Context) creds.AWS { return healthy().AWS },
		TS:        func(context.Context) creds.TS { return healthy().TS },
		Watchdog:  func(context.Context) *wd.State { return healthy().Watchdog },
		BoxExists: func(context.Context) bool { return true },
		Blocked:   func(context.Context) *bool { return p(true) },
		Now:       func() time.Time { return now },
	}
	r := Judge(g.Facts(context.Background()))
	if item(r, "budget").State != Fail || item(r, "aws key").State != OK || len(r.Items) != 4 {
		t.Errorf("%+v", r)
	}
	if !strings.Contains(r.Text(), "FAIL  budget") || !strings.Contains(r.Text(), "overall: fail") {
		t.Errorf("%s", r.Text())
	}
}

// With no working key, what lives in AWS is not checked - and not guessed at.
func TestWithoutAKeyTheWatchdogIsNotGuessed(t *testing.T) {
	f := healthy()
	f.AWS = creds.AWS{Reason: p("no-key")}
	f.Watchdog.Installed = false
	it := item(Judge(f), "cloud watchdog")
	if it.State != Warn || !strings.Contains(it.Text, "not checked") {
		t.Errorf("%+v", it)
	}
}
