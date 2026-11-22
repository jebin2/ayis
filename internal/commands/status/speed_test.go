package status

import (
	"testing"
	"time"
)

// What `ayis status` may cost in waiting (docs/performance.md): every AWS call is
// given the same delay, so the time taken counts the rounds of calls made one
// after another. A read that is accidentally made serial - or one call too many
// on a page the app reads at every start - fails here before anyone waits for it.
const (
	statusRounds = 4  // measured 3 on 2026-11-22
	statusCalls  = 25 // measured 20
)

func TestStatusAsksAWSInFewRounds(t *testing.T) {
	const d = 100 * time.Millisecond
	s := account()
	running(s, "spot")
	s.Latency = d
	e := newEnv(t)
	start := time.Now()
	e.gather(t, s)
	took := time.Since(start)
	n := 0
	for _, c := range s.Calls {
		n += c
	}
	rounds := float64(took) / float64(d)
	t.Logf("status: %d AWS calls in %.1f rounds (%s at %s each)", n, rounds, took.Round(time.Millisecond), d)
	if rounds > statusRounds+0.5 {
		t.Errorf("status waits %.1f rounds of AWS calls; the budget is %d", rounds, statusRounds)
	}
	if n > statusCalls {
		t.Errorf("status makes %d AWS calls; the budget is %d", n, statusCalls)
	}
}
