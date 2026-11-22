package config

import "errors"

// Secrets are the settings kept out of .env when the OS has a store for them.
// The AWS key is not among them: it lives in ~/.aws, which the AWS CLI owns.
var Secrets = map[string]bool{
	"TAILSCALE_API_KEY": true, "TAILSCALE_AUTH_KEY": true, "SUNSHINE_PASS": true, "GAME_NTFY_TOKEN": true,
}

// InVault is what .env holds for a secret kept in the OS store.
const InVault = "@keychain"

// Vault is the OS store for secrets (internal/keychain). Nil - the tests, a
// server with no keyring - keeps every secret in .env as before.
type Vault interface {
	Get(key string) (string, error)
	Set(key, value string) error
	Delete(key string) error
}

// UseVault makes this Env keep its secrets in v, and reads the ones .env says
// are there. A secret the store cannot give back reads as empty, which every
// caller already treats as "not set" - and Locked says which.
func (e *Env) UseVault(v Vault) {
	e.vault = v
	for k := range Secrets {
		if e.vars[k] != InVault {
			continue
		}
		if s, err := v.Get(k); err == nil {
			e.vars[k] = s
		} else {
			e.vars[k] = ""
			e.locked = append(e.locked, k)
		}
	}
}

// Locked are the secrets .env says are in the OS store that it did not give
// back - a keyring that is locked, or a .env copied from another computer.
func (e *Env) Locked() []string { return e.locked }

// keep writes a secret to the vault and returns what .env should hold instead.
func (e *Env) keep(key, value string) (string, error) {
	if e.vault == nil || !Secrets[key] {
		return value, nil
	}
	if value == "" {
		return "", e.vault.Delete(key)
	}
	if err := e.vault.Set(key, value); err != nil {
		return value, err
	}
	return InVault, nil
}

// MoveSecrets moves every secret still written in .env into the vault, once:
// the first run with a store that works. It returns the ones moved.
func (e *Env) MoveSecrets() ([]string, error) {
	if e.vault == nil {
		return nil, errors.New("no secret store")
	}
	var moved []string
	for k := range Secrets {
		raw := e.rawFileValue(k)
		if raw == "" || raw == InVault {
			continue
		}
		if err := e.Set(k, raw); err != nil {
			return moved, err
		}
		if e.rawFileValue(k) == InVault {
			moved = append(moved, k)
		}
	}
	return moved, nil
}

// InVault says whether .env says this secret is kept in the OS store.
func (e *Env) InVault(key string) bool { return e.rawFileValue(key) == InVault }
