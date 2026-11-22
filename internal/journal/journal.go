// Package journal is ayis's own log on this computer: every line a command
// says, in the order it said it, with the run it belongs to - so "what happened
// on Tuesday" has an answer after the window is closed.
//
//   - Where: $AYIS_LOG_FILE, else $XDG_STATE_HOME/ayis/ayis.log, else
//     ~/.local/state/ayis/ayis.log.
//   - How much: rotated at MaxBytes, Keep files in all (ayis.log, .1 ... .4).
//   - What: "<time> run=<id> <command> | <line>". The run id is the app's
//     (AYIS_RUN_ID) when it started the command, so one press of Play is one id
//     across every command it ran.
//   - Never a secret: every line is redacted on the way in (Redact).
package journal

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// The size of one file, and how many are kept.
var (
	MaxBytes int64 = 5 << 20
	Keep           = 5
)

// Path is where the log is, or "" when there is no home to keep it in.
func Path(get func(string) (string, bool)) string {
	if v, ok := get("AYIS_LOG_FILE"); ok && v != "" {
		return v
	}
	if v, ok := get("XDG_STATE_HOME"); ok && v != "" {
		return filepath.Join(v, "ayis", "ayis.log")
	}
	for _, k := range []string{"HOME", "USERPROFILE"} {
		if v, ok := get(k); ok && v != "" {
			return filepath.Join(v, ".local", "state", "ayis", "ayis.log")
		}
	}
	return ""
}

// NewRunID is a short id for one action.
func NewRunID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Journal is the open log for one command.
type Journal struct {
	mu      sync.Mutex
	f       *os.File
	Run     string
	Command string
	secrets []string
	Now     func() time.Time
}

// Open opens the log, rotating it first when it is full. A log that cannot be
// opened is not an error for the command: it runs without one.
func Open(path, run, command string, secrets []string) (*Journal, error) {
	if path == "" {
		return nil, fmt.Errorf("no place for a log")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if st, err := os.Stat(path); err == nil && st.Size() >= MaxBytes {
		rotate(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	// Longest first, so a secret that contains another is hidden whole.
	s := append([]string(nil), secrets...)
	sort.Slice(s, func(i, j int) bool { return len(s[i]) > len(s[j]) })
	return &Journal{f: f, Run: run, Command: command, secrets: s, Now: time.Now}, nil
}

func rotate(path string) {
	_ = os.Remove(fmt.Sprintf("%s.%d", path, Keep-1))
	for i := Keep - 2; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", path, i), fmt.Sprintf("%s.%d", path, i+1))
	}
	_ = os.Rename(path, path+".1")
}

// Line writes one line.
func (j *Journal) Line(text string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	fmt.Fprintf(j.f, "%s run=%s %s | %s\n", j.Now().Format("2006-01-02T15:04:05-07:00"), j.Run, j.Command, Redact(text, j.secrets))
}

// Close closes the log.
func (j *Journal) Close() {
	if j != nil {
		_ = j.f.Close()
	}
}

// Tee is a writer that passes everything to w and writes each complete line to
// the journal too.
func (j *Journal) Tee(w io.Writer) io.Writer {
	if j == nil {
		return w
	}
	return &tee{w: w, j: j}
}

type tee struct {
	w   io.Writer
	j   *Journal
	buf bytes.Buffer
	mu  sync.Mutex
}

func (t *tee) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.buf.Write(p)
	for {
		i := bytes.IndexByte(t.buf.Bytes(), '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(t.buf.Next(i+1)), "\r\n")
		if strings.TrimSpace(line) != "" {
			t.j.Line(line)
		}
	}
	t.mu.Unlock()
	return t.w.Write(p)
}

// The shapes of a secret, whatever setting it came from.
var shapes = []*regexp.Regexp{
	regexp.MustCompile(`\b(AKIA|ASIA)[A-Z0-9]{16}\b`),
	regexp.MustCompile(`(?i)(aws_secret_access_key|secret[_ ]?key)(["':= ]+)[A-Za-z0-9/+=]{40}`),
	regexp.MustCompile(`tskey-[A-Za-z0-9-]{6,}`),
	regexp.MustCompile(`\btk_[A-Za-z0-9]{10,}`),
	regexp.MustCompile(`(?i)(Authorization:?\s*Bearer\s+)\S+`),
	regexp.MustCompile(`(ntfy\.sh/)[A-Za-z0-9_-]+`),
	regexp.MustCompile(`(?i)\b(password|passwd|pass)(["':= ]+)[^\s"',]+`),
}

// Redact hides every known secret value, and anything shaped like a secret.
func Redact(s string, secrets []string) string {
	for _, v := range secrets {
		if len(v) >= 4 {
			s = strings.ReplaceAll(s, v, "[redacted]")
		}
	}
	for i, re := range shapes {
		switch i {
		case 1, 6:
			s = re.ReplaceAllString(s, "${1}${2}[redacted]")
		case 4, 5:
			s = re.ReplaceAllString(s, "${1}[redacted]")
		default:
			s = re.ReplaceAllString(s, "[redacted]")
		}
	}
	return s
}
