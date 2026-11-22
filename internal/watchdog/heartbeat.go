package watchdog

import (
	"context"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// The dead-man signal. After every run that finished without an error the
// function writes the time to a free SSM parameter; a watchdog that stopped
// running, or fails every time, leaves it to grow old. Its log alone cannot
// tell the two apart from a quiet one: a failing run logs too.

// LateAfter is when a last good run is too old: three runs missed.
const LateAfter = 3 * EveryMin * time.Minute

// HeartbeatName is the parameter the function writes.
func HeartbeatName(host string) string { return "/ayis/" + host + "/watchdog/last-ok" }

// SSMReadAPI is what reading the heartbeat uses.
type SSMReadAPI interface {
	GetParameter(context.Context, *ssm.GetParameterInput, ...func(*ssm.Options)) (*ssm.GetParameterOutput, error)
}

// Heartbeat is what the signal says.
type Heartbeat struct {
	Known bool      // the parameter could be read (or is certainly absent)
	Found bool      // a good run has been recorded
	At    time.Time // when, if Found
}

// Late says the watchdog has not finished a good run for LateAfter. Unknown or
// never recorded is not late: a watchdog installed a minute ago has not run yet.
func (h Heartbeat) Late(now time.Time) bool { return h.Found && now.Sub(h.At) > LateAfter }

// ReadHeartbeat reads the signal. Read only, and free.
func ReadHeartbeat(ctx context.Context, c SSMReadAPI, host string) Heartbeat {
	o, err := c.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(HeartbeatName(host))})
	if err != nil {
		return Heartbeat{Known: code(err) == "ParameterNotFound"}
	}
	t, err := time.Parse("2006-01-02T15:04:05Z", aws.ToString(o.Parameter.Value))
	if err != nil {
		return Heartbeat{}
	}
	return Heartbeat{Known: true, Found: true, At: t}
}
