package watchdog

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
)

// An update keeps what was running; rollback puts it back - code and settings -
// and marks it, so the next ordinary install (every build runs one) leaves it;
// --force puts this version of ayis's back.
func TestAnUpdateCanBeRolledBackAndStaysRolledBack(t *testing.T) {
	ctx := context.Background()
	c := newCloud()
	i, said := installer(t, c)
	i.Fetch = c.fetch
	if err := i.Install(ctx); err != nil {
		t.Fatal(err)
	}
	old := append([]byte(nil), c.code...)
	oldHandler := aws.ToString(c.fn.Handler)

	// A new release: different code.
	i.Source = append(append([]File(nil), i.Source...), File{Name: "ayis_watchdog/new.py", Data: []byte("x = 1\n")})
	if err := i.Install(ctx); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(c.code, old) || len(c.versions) != 1 {
		t.Fatalf("the update ran and kept the old one: versions %d", len(c.versions))
	}
	if !strings.Contains(strings.Join(*said, "\n"), "kept the running watchdog as version 1") {
		t.Errorf("said: %v", *said)
	}

	if err := i.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(c.code, old) || aws.ToString(c.fn.Handler) != oldHandler {
		t.Error("the old code and handler are back")
	}
	if _, ok := IsRolledBack(aws.ToString(c.fn.Description)); !ok {
		t.Errorf("not marked: %q", aws.ToString(c.fn.Description))
	}

	// A build's install leaves a rolled-back watchdog alone...
	if err := i.Install(ctx); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(c.code, old) {
		t.Error("an ordinary install undid the rollback")
	}
	// ...and --force puts the new one back, unmarked.
	i.Force = true
	if err := i.Install(ctx); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(c.code, old) {
		t.Error("--force did not replace it")
	}
	if _, ok := IsRolledBack(aws.ToString(c.fn.Description)); ok {
		t.Error("still marked rolled back")
	}
}

func TestOnlyTheLastFewDeploysAreKept(t *testing.T) {
	ctx := context.Background()
	c := newCloud()
	i, _ := installer(t, c)
	_ = i.Install(ctx)
	for n := 0; n < 6; n++ {
		i.Source = append(i.Source, File{Name: "ayis_watchdog/v" + string(rune('a'+n)) + ".py", Data: []byte("#")})
		if err := i.Install(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.versions) != KeepVersions || c.versions[len(c.versions)-1].n != "6" {
		t.Errorf("kept %d, newest %v", len(c.versions), c.versions)
	}
}

func TestNothingKeptIsSaid(t *testing.T) {
	c := newCloud()
	i, _ := installer(t, c)
	_ = i.Install(context.Background())
	if err := i.Rollback(context.Background()); !errors.Is(err, ErrNothingToRollBack) {
		t.Errorf("%v", err)
	}
}
