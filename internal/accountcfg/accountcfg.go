// Package accountcfg keeps the account settings (config.IsAccount) in the AWS
// account, so that every computer driving it agrees: SSM standard parameters
// under /ayis/<host>/config/<KEY>, in the settings' region. Standard parameters
// and their API calls are free.
//
// The account is the truth; .env holds a copy. Sync brings the copy up to date
// and, the first time, moves this computer's values up. A value changed while
// AWS could not be reached is remembered as pending and shared at the next
// Sync, so it is not overwritten by the older one in the account.
package accountcfg

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/jebin2/ayis/internal/awscfg"
	"github.com/jebin2/ayis/internal/config"
)

// PendingKey is the .env line listing account settings changed on this
// computer that the account has not been told yet.
const PendingKey = "AYIS_PENDING_SHARE"

// Empty stands for a setting deliberately left empty: SSM refuses an empty
// value, and "off" (an empty ntfy topic) must travel like any other choice.
const Empty = "<empty>"

// SSM is what keeping the settings uses.
type SSM interface {
	GetParametersByPath(context.Context, *ssm.GetParametersByPathInput, ...func(*ssm.Options)) (*ssm.GetParametersByPathOutput, error)
	PutParameter(context.Context, *ssm.PutParameterInput, ...func(*ssm.Options)) (*ssm.PutParameterOutput, error)
}

// Path is where the host's account settings are kept.
func Path(host string) string { return "/ayis/" + host + "/config/" }

// Change is one setting that moved, either way.
type Change struct {
	Key  string
	From string // what this computer had
	To   string // what it has now
	Up   bool   // true: this computer's value went to the account; false: the account's came here
}

func encode(v string) string {
	if v == "" {
		return Empty
	}
	return v
}

func decode(v string) string {
	if v == Empty {
		return ""
	}
	return v
}

// Read is the account's settings: key to value.
func Read(ctx context.Context, c SSM, host string) (map[string]string, error) {
	out := map[string]string{}
	var token *string
	for {
		o, err := c.GetParametersByPath(ctx, &ssm.GetParametersByPathInput{Path: aws.String(Path(host)), NextToken: token})
		if err != nil {
			return nil, err
		}
		for _, p := range o.Parameters {
			k := strings.TrimPrefix(aws.ToString(p.Name), Path(host))
			if config.IsAccount(k) {
				out[k] = decode(aws.ToString(p.Value))
			}
		}
		if o.NextToken == nil {
			return out, nil
		}
		token = o.NextToken
	}
}

// Put writes one account setting to the account.
func Put(ctx context.Context, c SSM, host, key, value string) error {
	if !config.IsAccount(key) {
		return errors.New(key + " is kept on this computer, not in the account")
	}
	_, err := c.PutParameter(ctx, &ssm.PutParameterInput{Name: aws.String(Path(host) + key), Value: aws.String(encode(value)),
		Type: ssmtypes.ParameterTypeString, Tier: ssmtypes.ParameterTierStandard, Overwrite: aws.Bool(true),
		Description: aws.String("ayis setting, shared by every computer that drives this account")})
	return err
}

// Pending is the account settings this computer changed without telling the account.
func Pending(env *config.Env) []string {
	var out []string
	for _, k := range strings.Split(env.FileValue(PendingKey), ",") {
		if k = strings.TrimSpace(k); config.IsAccount(k) {
			out = append(out, k)
		}
	}
	return out
}

// MarkPending remembers that key was changed here and must be shared.
func MarkPending(env *config.Env, key string) error {
	keys := map[string]bool{key: true}
	for _, k := range Pending(env) {
		keys[k] = true
	}
	list := make([]string, 0, len(keys))
	for k := range keys {
		list = append(list, k)
	}
	sort.Strings(list)
	return env.Set(PendingKey, strings.Join(list, ","))
}

// Sync makes this computer and the account agree, and says what moved:
//
//   - a value changed here while offline (pending) goes up;
//   - a value the account has comes down, when it differs;
//   - a value only this computer has goes up - the first run, moving .env's
//     settings into the account.
//
// Nothing is written to .env when the account cannot be read: the copy stays.
func Sync(ctx context.Context, c SSM, env *config.Env) ([]Change, error) {
	host := env.Host()
	remote, err := Read(ctx, c, host)
	if err != nil {
		return nil, err
	}
	pending := map[string]bool{}
	for _, k := range Pending(env) {
		pending[k] = true
	}
	var changes []Change
	var failed error
	for _, k := range config.AccountKeys() {
		here, hasHere := env.FileValue(k), env.FileHas(k)
		there, hasThere := remote[k]
		switch {
		case pending[k] || (hasHere && !hasThere):
			if err := Put(ctx, c, host, k, here); err != nil {
				failed = err
				continue
			}
			delete(pending, k)
			if !hasThere || there != here {
				changes = append(changes, Change{Key: k, From: there, To: here, Up: true})
			}
		case hasThere && (!hasHere || there != here):
			if err := env.Set(k, there); err != nil {
				return changes, err
			}
			changes = append(changes, Change{Key: k, From: here, To: there})
		}
	}
	// Whatever could not be shared stays pending for next time.
	left := make([]string, 0, len(pending))
	for k := range pending {
		left = append(left, k)
	}
	sort.Strings(left)
	if len(left) == 0 {
		if env.FileHas(PendingKey) {
			_ = env.Unset(PendingKey)
		}
	} else {
		_ = env.Set(PendingKey, strings.Join(left, ","))
	}
	return changes, failed
}

// Off says whether sharing is turned off: AYIS_NO_ACCOUNT_SYNC=1, which the test
// suites set so a test's .env can never reach a real account.
func Off(env *config.Env) bool { return env.Get("AYIS_NO_ACCOUNT_SYNC") == "1" }

// Sharer is the way `ayis config set` and the commands that save a setting tell
// the account: an error means the value is saved on this computer only.
func Sharer(ctx context.Context, env *config.Env) func(key, value string) error {
	return func(key, value string) error {
		if Off(env) {
			return errors.New("sharing is turned off (AYIS_NO_ACCOUNT_SYNC=1)")
		}
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		cfg, err := awscfg.New(ctx, env.Region())
		if err != nil {
			return err
		}
		return Put(ctx, ssm.NewFromConfig(cfg), env.Host(), key, value)
	}
}
