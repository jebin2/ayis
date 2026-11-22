// Package runlog is `ayis log --run <id>`: one action's lines, from everywhere
// they were written - this computer's log (internal/journal), which also holds
// what the box said while ayis watched it, and the cloud watchdog's lines about
// the machine that run launched or started.
package runlog

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"

	"github.com/jebin2/ayis/internal/awscfg"
	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/journal"
	"github.com/jebin2/ayis/internal/output"
	wd "github.com/jebin2/ayis/internal/watchdog"
)

var runID = regexp.MustCompile(`^[0-9a-z]{4,32}$`)

// Local is every line of the run in this computer's log, oldest file first.
func Local(path, id string) []string {
	var out []string
	files := []string{}
	for i := journal.Keep - 1; i >= 1; i-- {
		files = append(files, fmt.Sprintf("%s.%d", path, i))
	}
	files = append(files, path)
	for _, f := range files {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			if strings.Contains(sc.Text(), " run="+id+" ") {
				out = append(out, sc.Text())
			}
		}
		fh.Close()
	}
	return out
}

// Logs is what reading the watchdog's lines uses.
type Logs = wd.LogsAPI

// Watchdog is the cloud watchdog's lines carrying the run, from the last days.
func Watchdog(ctx context.Context, logs Logs, host, id string, since time.Time) ([]string, error) {
	r := &wd.Reader{Logs: logs, Host: host}
	evs, err := r.Since(ctx, "run="+id, since)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range evs {
		out = append(out, time.UnixMilli(e.MS).Format("2006-01-02T15:04:05-07:00")+" watchdog | "+strings.TrimPrefix(e.Msg, "ayis-watchdog: "))
	}
	return out, nil
}

// Run is `ayis log --run <id>`.
func Run(ctx context.Context, env *config.Env, get func(string) (string, bool), id string, out *output.Out) int {
	if !runID.MatchString(id) {
		out.Die("usage: ayis log --run <id> - the id the app shows for an action, or a line of ayis's log has")
		return 1
	}
	path := journal.Path(get)
	local := Local(path, id)
	fmt.Fprintf(out.Stdout, "==> this computer (%s)\n", path)
	if len(local) == 0 {
		fmt.Fprintln(out.Stdout, "    no line of this run")
	}
	for _, l := range local {
		fmt.Fprintln(out.Stdout, l)
	}
	fmt.Fprintln(out.Stdout, "==> the cloud watchdog, about the machine this run launched or started (last 14 days)")
	cfg, err := awscfg.New(ctx, env.Region())
	if err == nil {
		var lines []string
		if lines, err = Watchdog(ctx, cloudwatchlogs.NewFromConfig(cfg), env.Host(), id, time.Now().AddDate(0, 0, -14)); err == nil {
			if len(lines) == 0 {
				fmt.Fprintln(out.Stdout, "    no line of this run")
			}
			for _, l := range lines {
				fmt.Fprintln(out.Stdout, l)
			}
		}
	}
	if err != nil {
		fmt.Fprintf(out.Stdout, "    could not be read: %v\n", err)
	}
	return 0
}
