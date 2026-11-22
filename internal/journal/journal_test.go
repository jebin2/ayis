package journal

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A secret never reaches the log: not a known value, not anything shaped like one.
func TestRedact(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"key AKIAGOODGOODGOOD1234 used", "key [redacted] used"},
		{"secret_key: abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234", "secret_key: [redacted]"},
		{"joining with tskey-auth-xxxxxxxxxxxx", "joining with [redacted]"},
		{"ntfy token tk_AgQdq7mVBoFD37zQVN29Rh", "ntfy token [redacted]"},
		{"-H Authorization: Bearer tk_x1 sent", "-H Authorization: Bearer [redacted] sent"},
		{"posted to https://ntfy.sh/topic-example ok", "posted to https://ntfy.sh/[redacted] ok"},
		{"sunshine password=hunter2!x login", "sunshine password=[redacted] login"},
		{"nothing secret here: i-0abc running", "nothing secret here: i-0abc running"},
	} {
		if got := Redact(c.in, nil); got != c.want {
			t.Errorf("%q:\n got %q\nwant %q", c.in, got, c.want)
		}
	}
	// A secret with no shape (a Sunshine password chosen by a person) is hidden by value.
	if got := Redact("logged in as admin with Correct-Horse", []string{"Correct-Horse"}); got != "logged in as admin with [redacted]" {
		t.Errorf("%q", got)
	}
}

func TestLinesCarryTheRunAndCommandAndAreRedacted(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state", "ayis.log")
	j, err := Open(p, "ab12cd34", "init", []string{"s3cr3tpass"})
	if err != nil {
		t.Fatal(err)
	}
	j.Now = func() time.Time { return time.Date(2026, 11, 22, 18, 0, 0, 0, time.UTC) }
	var screen bytes.Buffer
	w := j.Tee(&screen)
	fmt.Fprint(w, "==> building\nSunshine pass s3cr3tpass set\npart")
	fmt.Fprint(w, "ial line\n")
	j.Close()
	b, _ := os.ReadFile(p)
	want := "2026-11-22T18:00:00+00:00 run=ab12cd34 init | ==> building\n" +
		"2026-11-22T18:00:00+00:00 run=ab12cd34 init | Sunshine pass [redacted] set\n" +
		"2026-11-22T18:00:00+00:00 run=ab12cd34 init | partial line\n"
	if string(b) != want {
		t.Errorf("log:\n%s\nwant:\n%s", b, want)
	}
	if !strings.Contains(screen.String(), "s3cr3tpass") {
		t.Error("the screen is not redacted - it is the person's own")
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode().Perm())
	}
}

func TestRotationKeepsFiveFiles(t *testing.T) {
	old := MaxBytes
	MaxBytes = 10
	t.Cleanup(func() { MaxBytes = old })
	p := filepath.Join(t.TempDir(), "ayis.log")
	for i := 0; i < 8; i++ {
		j, err := Open(p, fmt.Sprint(i), "x", nil)
		if err != nil {
			t.Fatal(err)
		}
		j.Line("a line longer than ten bytes")
		j.Close()
	}
	files, _ := filepath.Glob(p + "*")
	if len(files) != Keep {
		t.Errorf("%d files: %v", len(files), files)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "run=7 ") {
		t.Errorf("the newest run is in ayis.log: %s", b)
	}
}

func TestPath(t *testing.T) {
	get := func(m map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
	}
	if Path(get(map[string]string{"HOME": "/h"})) != "/h/.local/state/ayis/ayis.log" ||
		Path(get(map[string]string{"HOME": "/h", "XDG_STATE_HOME": "/s"})) != "/s/ayis/ayis.log" ||
		Path(get(map[string]string{"AYIS_LOG_FILE": "/x.log", "HOME": "/h"})) != "/x.log" ||
		Path(get(nil)) != "" {
		t.Error("path")
	}
}
