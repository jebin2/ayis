package watcher

import (
	"context"
	"testing"
	"time"
)

// What `ayis watcher` may cost in waiting (docs/performance.md); see status's
// speed test for how rounds are counted.
func TestWatcherAsksAWSInFewRounds(t *testing.T) {
	const d = 100 * time.Millisecond
	s := scenario("running", "spot")
	s.Latency = d
	w := build(s, reachable("active"), "i-1")
	start := time.Now()
	w.Gather(context.Background())
	took := time.Since(start)
	n := 0
	for _, c := range s.Calls {
		n += c
	}
	rounds := float64(took) / float64(d)
	t.Logf("watcher: %d AWS calls in %.1f rounds (%s)", n, rounds, took.Round(time.Millisecond))
	if rounds > watcherRounds+0.5 {
		t.Errorf("watcher waits %.1f rounds of AWS calls; the budget is %d", rounds, watcherRounds)
	}
}

// Measured 8 on 2026-11-22 (each part waited for the last); 4 once the machine,
// the cloud watchdog and the budget were asked at once.
const watcherRounds = 4
