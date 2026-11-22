package config

import (
	"bufio"
	"os"
	"strings"
)

// Account settings shape what runs in the AWS account - the box that is built,
// the budget, the hard limits, the alerts and the watchdog's timings. There is
// one account and one watchdog however many computers drive it, so these are
// kept in the account (internal/accountcfg) and every computer reads them from
// there; .env holds a copy. Before this, each computer deployed the watchdog
// from its own .env and the last to save won (ADR-0002).
//
// Local settings belong to this computer: where everything lives (the region,
// read before AWS can be asked anything), how this screen streams, and secrets
// that are never sent anywhere.
var accountKeys = map[string]bool{
	"GAME_DISK_GB":             true,
	"GAME_DISK_RESERVE_GB":     true,
	"GAME_ARCHIVE_EXPIRY_DAYS": true,
	"GAME_INSTANCE_TYPE":       true,
	"GAME_SPOT":                true,
	"GAME_STEAM_LOGIN":         true,
	"GAME_BUDGET_INR":          true,
	"GAME_MAX_HOURS_MONTH":     true,
	"GAME_MAX_SESSION_HOURS":   true,
	"GAME_IDLE_MIN":            true,
	"GAME_WATCHDOG_IDLE_MIN":   true,
	"GAME_WATCHDOG_STUCK_MIN":  true,
	"GAME_NTFY_URL":            true,
	"EMAIL_ALERTS":             true,
}

var localKeys = map[string]bool{
	"GAME_REGION":       true, // where the account settings are kept: read first
	"TAILSCALE_API_KEY": true, // a secret: stays on this computer
	"GAME_RES":          true,
	"GAME_CLIPBOARD":    true,
	"GAME_FPS":          true,
	"GAME_BITRATE_KBPS": true,
}

// IsAccount says whether a setting is kept in the AWS account.
func IsAccount(key string) bool { return accountKeys[key] }

// AccountKeys are the account settings, in registry order.
func AccountKeys() []string {
	var out []string
	for _, s := range Registry {
		if accountKeys[s.Key] {
			out = append(out, s.Key)
		}
	}
	return out
}

// FileHas says whether the settings file has a line for the key, even an empty
// one, whatever the environment says.
func (e *Env) FileHas(key string) bool {
	f, err := os.Open(e.File)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), key+"=") {
			return true
		}
	}
	return false
}

// IsLocal says whether a setting stays on this computer.
func IsLocal(key string) bool { return localKeys[key] }
