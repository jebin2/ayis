package main

import (
	"sort"
	"strings"

	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/keychain"
	"github.com/jebin2/ayis/internal/output"
)

// vaultFor is the OS secret store for a settings file; the tests replace it so
// they never touch the real one.
var vaultFor = func(file string) config.Vault { return keychain.Store{File: file} }

// storeWorks says whether the OS store answers; the tests replace it too.
var storeWorks = keychain.Works

// loadEnv reads the settings with their secrets in the OS store (P6, W10):
// .env holds "@keychain" for each one kept there. The first run with a store
// that works moves the secrets still in .env into it. AYIS_NO_KEYCHAIN=1 keeps
// them in .env - the test suites set it, and so can a person who prefers that.
func loadEnv(get config.Lookup, out *output.Out) *config.Env {
	env := config.Load(get, repoDir(get))
	if v, _ := get("AYIS_NO_KEYCHAIN"); v == "1" {
		return env
	}
	vault := vaultFor(env.File)
	if vault == nil {
		return env
	}
	env.UseVault(vault)
	if locked := env.Locked(); len(locked) > 0 && out != nil && !warnedLocked {
		warnedLocked = true
		sort.Strings(locked)
		out.LogAs("warn", "the system keychain did not give back "+strings.Join(locked, ", ")+
			" - unlock it, or set them again (ayis config set, ayis creds)")
	}
	if plainSecrets(env) && storeWorks(env.File) {
		if moved, err := env.MoveSecrets(); err == nil && len(moved) > 0 && out != nil {
			sort.Strings(moved)
			out.LogAs("ok", "moved "+strings.Join(moved, ", ")+" from .env into the system keychain")
		}
	}
	return env
}

// warnedLocked: the settings are read more than once a run; said once.
var warnedLocked bool

// plainSecrets says whether .env still holds a secret written out in full.
func plainSecrets(env *config.Env) bool {
	for k := range config.Secrets {
		if v := env.FileValue(k); v != "" && !env.InVault(k) {
			return true
		}
	}
	return false
}
