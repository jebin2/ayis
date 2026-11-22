package accountcfg

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/jebin2/ayis/internal/config"
)

// fakeSSM is one AWS account's parameters.
type fakeSSM struct {
	p    map[string]string
	down bool // AWS unreachable
}

func newSSM() *fakeSSM { return &fakeSSM{p: map[string]string{}} }

func (f *fakeSSM) GetParametersByPath(_ context.Context, in *ssm.GetParametersByPathInput, _ ...func(*ssm.Options)) (*ssm.GetParametersByPathOutput, error) {
	if f.down {
		return nil, errors.New("no network")
	}
	var names []string
	for k := range f.p {
		if strings.HasPrefix(k, aws.ToString(in.Path)) {
			names = append(names, k)
		}
	}
	sort.Strings(names)
	// Two to a page, so paging is exercised.
	start := 0
	if in.NextToken != nil {
		for i, n := range names {
			if n == *in.NextToken {
				start = i
			}
		}
	}
	o := &ssm.GetParametersByPathOutput{}
	for i := start; i < len(names) && i < start+2; i++ {
		o.Parameters = append(o.Parameters, ssmtypes.Parameter{Name: aws.String(names[i]), Value: aws.String(f.p[names[i]])})
	}
	if start+2 < len(names) {
		o.NextToken = aws.String(names[start+2])
	}
	return o, nil
}

func (f *fakeSSM) PutParameter(_ context.Context, in *ssm.PutParameterInput, _ ...func(*ssm.Options)) (*ssm.PutParameterOutput, error) {
	if f.down {
		return nil, errors.New("no network")
	}
	if aws.ToString(in.Value) == "" {
		return nil, errors.New("ValidationException: empty value")
	}
	f.p[aws.ToString(in.Name)] = aws.ToString(in.Value)
	return &ssm.PutParameterOutput{}, nil
}

// computer is one laptop's .env.
func computer(t *testing.T, body string) *config.Env {
	t.Helper()
	f := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(f, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return config.Load(func(k string) (string, bool) {
		if k == "AYIS_ENV_FILE" {
			return f, true
		}
		return "", false
	}, "")
}

func sync(t *testing.T, c SSM, env *config.Env) []Change {
	t.Helper()
	ch, err := Sync(context.Background(), c, env)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	return ch
}

const p = "/ayis/ayis/config/"

func TestFirstSyncMovesThisComputersSettingsUp(t *testing.T) {
	acct := newSSM()
	env := computer(t, "GAME_MAX_SESSION_HOURS=1\nGAME_NTFY_URL=\nGAME_FPS=120\nGAME_REGION=ap-south-1\n")
	ch := sync(t, acct, env)
	if acct.p[p+"GAME_MAX_SESSION_HOURS"] != "1" {
		t.Errorf("not moved up: %v", acct.p)
	}
	if acct.p[p+"GAME_NTFY_URL"] != Empty {
		t.Errorf("an empty choice travels as %q: %v", Empty, acct.p)
	}
	if _, ok := acct.p[p+"GAME_FPS"]; ok {
		t.Error("a local setting went to the account")
	}
	if _, ok := acct.p[p+"GAME_REGION"]; ok {
		t.Error("the region went to the account")
	}
	if len(ch) != 2 || !ch[0].Up {
		t.Errorf("changes: %+v", ch)
	}
	if got := sync(t, acct, env); len(got) != 0 {
		t.Errorf("a second sync moves nothing: %+v", got)
	}
}

// The bug of 2026-11-22: a laptop with 6 hours and no alerts, a server with 1
// hour and a topic, one watchdog. Whoever saved last won.
func TestTwoComputersAgree(t *testing.T) {
	acct := newSSM()
	server := computer(t, "GAME_MAX_SESSION_HOURS=1\nGAME_NTFY_URL=https://ntfy.sh/t\n")
	sync(t, acct, server)

	laptop := computer(t, "GAME_MAX_SESSION_HOURS=6\n")
	ch := sync(t, acct, laptop)
	if laptop.Get("GAME_MAX_SESSION_HOURS") != "1" || laptop.Get("GAME_NTFY_URL") != "https://ntfy.sh/t" {
		t.Errorf("the laptop keeps its stale copy: hours=%s ntfy=%s", laptop.Get("GAME_MAX_SESSION_HOURS"), laptop.Get("GAME_NTFY_URL"))
	}
	if acct.p[p+"GAME_MAX_SESSION_HOURS"] != "1" {
		t.Error("the laptop's stale value overwrote the account")
	}
	if len(ch) != 2 || ch[0].Up {
		t.Errorf("changes: %+v", ch)
	}

	// A change on the laptop reaches the server.
	if err := Put(context.Background(), acct, "ayis", "GAME_MAX_SESSION_HOURS", "4"); err != nil {
		t.Fatal(err)
	}
	_ = laptop.Set("GAME_MAX_SESSION_HOURS", "4")
	sync(t, acct, server)
	if server.Get("GAME_MAX_SESSION_HOURS") != "4" {
		t.Errorf("server did not see the laptop's change: %s", server.Get("GAME_MAX_SESSION_HOURS"))
	}
}

func TestAChangeMadeOfflineIsSharedNotLost(t *testing.T) {
	acct := newSSM()
	env := computer(t, "GAME_BUDGET_INR=5000\n")
	sync(t, acct, env)

	acct.down = true
	_ = env.Set("GAME_BUDGET_INR", "3000")
	if err := MarkPending(env, "GAME_BUDGET_INR"); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(context.Background(), acct, env); err == nil {
		t.Error("an unreachable account is an error")
	}
	if env.Get("GAME_BUDGET_INR") != "3000" {
		t.Error("an unreachable account changed .env")
	}

	acct.down = false
	sync(t, acct, env)
	if acct.p[p+"GAME_BUDGET_INR"] != "3000" {
		t.Errorf("the offline change was overwritten by the older account value: %v", acct.p)
	}
	if env.FileHas(PendingKey) {
		t.Error("pending kept after it was shared")
	}
}

func TestPutRefusesLocalSettings(t *testing.T) {
	if err := Put(context.Background(), newSSM(), "ayis", "GAME_REGION", "eu-west-1"); err == nil {
		t.Error("the region must stay on this computer")
	}
}

func TestEveryRegistrySettingHasAPlace(t *testing.T) {
	acct := map[string]bool{}
	for _, k := range config.AccountKeys() {
		acct[k] = true
	}
	for _, s := range config.Registry {
		if !acct[s.Key] && !config.IsLocal(s.Key) {
			t.Errorf("%s is neither an account nor a local setting: decide where it lives", s.Key)
		}
		if acct[s.Key] && config.IsLocal(s.Key) {
			t.Errorf("%s is both", s.Key)
		}
	}
}
