package limitscmd

import (
	"strings"
	"testing"

	"github.com/jebin2/ayis/internal/limits"
)

func TestRefusal(t *testing.T) {
	if r := Refusal(Status{}); r != "" {
		t.Errorf("nothing set: %q", r)
	}
	if r := Refusal(Status{BudgetBlocked: true}); !strings.Contains(r, "budget is spent") || !strings.Contains(r, "unblock") {
		t.Errorf("blocked must say why and how out: %q", r)
	}
	if r := Refusal(Status{Month: limits.Month{CapHours: 60, Reached: true}}); !strings.Contains(r, "60 play hours") || !strings.Contains(r, "extend-month") {
		t.Errorf("cap reached must say why and how out: %q", r)
	}
	// Could not tell: the watchdog still enforces, so a start is not refused on a guess.
	if r := Refusal(Status{MonthError: "throttled", Month: limits.Month{CapHours: 60, Reached: true}}); r != "" {
		t.Errorf("unknown is not a refusal: %q", r)
	}
}
