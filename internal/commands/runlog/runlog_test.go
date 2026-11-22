package runlog

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	cwltypes "github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs/types"

	wd "github.com/jebin2/ayis/internal/watchdog"
)

// A run's lines are found in every rotated file, oldest first, and no other run's.
func TestLocalFindsTheRunAcrossRotatedFiles(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ayis.log")
	_ = os.WriteFile(p+".2", []byte("t1 run=ab12 open | ==> starting\nt1 run=ffff status | other\n"), 0o600)
	_ = os.WriteFile(p+".1", []byte("t2 run=ab12 open | box running\n"), 0o600)
	_ = os.WriteFile(p, []byte("t3 run=ab123 open | not this one\nt4 run=ab12 open | ready\n"), 0o600)
	got := strings.Join(Local(p, "ab12"), "\n")
	if got != "t1 run=ab12 open | ==> starting\nt2 run=ab12 open | box running\nt4 run=ab12 open | ready" {
		t.Errorf("%s", got)
	}
}

type logs struct{ pattern string }

func (l *logs) FilterLogEvents(_ context.Context, in *cloudwatchlogs.FilterLogEventsInput, _ ...func(*cloudwatchlogs.Options)) (*cloudwatchlogs.FilterLogEventsOutput, error) {
	l.pattern = aws.ToString(in.FilterPattern)
	return &cloudwatchlogs.FilterLogEventsOutput{Events: []cwltypes.FilteredLogEvent{
		{Timestamp: aws.Int64(time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC).UnixMilli()), Message: aws.String("ayis-watchdog: i-1 busy: 50.0 MB in+out - leaving it run=ab12\n")}}}, nil
}

func TestTheWatchdogsLinesAreAskedForByRun(t *testing.T) {
	l := &logs{}
	got, err := Watchdog(context.Background(), l, "ayis", "ab12", time.Now())
	if err != nil || len(got) != 1 || !strings.HasSuffix(got[0], " watchdog | i-1 busy: 50.0 MB in+out - leaving it run=ab12") {
		t.Errorf("%v %v", got, err)
	}
	if l.pattern != `"run=ab12"` {
		t.Errorf("pattern %s", l.pattern)
	}
	// Shown to a person elsewhere, the run is not part of the words.
	if wd.Plain("i-1 busy - leaving it run=ab12") != "i-1 busy - leaving it" {
		t.Error("plain")
	}
}
