package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/output"
)

// No test reaches the real system keychain.
func TestMain(m *testing.M) {
	vaultFor = func(string) config.Vault { return nil }
	storeWorks = func(string) bool { return false }
	os.Exit(m.Run())
}

type memVault map[string]string

func (v memVault) Get(k string) (string, error) {
	s, ok := v[k]
	if !ok {
		return "", errors.New("not found")
	}
	return s, nil
}
func (v memVault) Set(k, s string) error { v[k] = s; return nil }
func (v memVault) Delete(k string) error { delete(v, k); return nil }

func withVault(t *testing.T, v config.Vault, works bool) {
	t.Helper()
	pf, pw := vaultFor, storeWorks
	vaultFor = func(string) config.Vault { return v }
	storeWorks = func(string) bool { return works }
	warnedLocked = false
	t.Cleanup(func() { vaultFor, storeWorks = pf, pw })
}

func envFile(t *testing.T, body string) (config.Lookup, string) {
	f := filepath.Join(t.TempDir(), ".env")
	_ = os.WriteFile(f, []byte(body), 0o600)
	return func(k string) (string, bool) {
		if k == "AYIS_ENV_FILE" {
			return f, true
		}
		return "", false
	}, f
}

// The first run with a store moves the secrets out of .env; every later read
// gives them back as before; a setting that is not a secret stays in .env.
func TestSecretsMoveIntoTheKeychainAndReadBack(t *testing.T) {
	v := memVault{}
	withVault(t, v, true)
	get, f := envFile(t, "TAILSCALE_API_KEY=tskey-api-abc123\nGAME_NTFY_TOKEN=tk_abcdefghijkl\nGAME_REGION=ap-south-1\n")
	var o, e bytes.Buffer
	env := loadEnv(get, &output.Out{Stdout: &o, Stderr: &e})
	b, _ := os.ReadFile(f)
	file := string(b)
	if !strings.Contains(file, "TAILSCALE_API_KEY=@keychain") || !strings.Contains(file, "GAME_NTFY_TOKEN=@keychain") ||
		strings.Contains(file, "tskey-api-abc123") || !strings.Contains(file, "GAME_REGION=ap-south-1") {
		t.Errorf(".env after the move:\n%s", file)
	}
	if v["TAILSCALE_API_KEY"] != "tskey-api-abc123" || env.Get("TAILSCALE_API_KEY") != "tskey-api-abc123" {
		t.Errorf("vault %v, get %q", v, env.Get("TAILSCALE_API_KEY"))
	}
	if !strings.Contains(o.String()+e.String(), "moved GAME_NTFY_TOKEN, TAILSCALE_API_KEY from .env into the system keychain") {
		t.Errorf("said: %s%s", o.String(), e.String())
	}
	again := loadEnv(get, nil)
	if again.Get("GAME_NTFY_TOKEN") != "tk_abcdefghijkl" || again.FileValue("GAME_NTFY_TOKEN") != "tk_abcdefghijkl" {
		t.Error("read back from the keychain, both ways")
	}
	// Setting it again goes to the keychain; clearing it removes it there too.
	_ = again.Set("GAME_NTFY_TOKEN", "tk_zyxwvutsrqpo")
	if v["GAME_NTFY_TOKEN"] != "tk_zyxwvutsrqpo" {
		t.Error("a new value goes to the keychain")
	}
	_ = again.Set("GAME_NTFY_TOKEN", "")
	if _, ok := v["GAME_NTFY_TOKEN"]; ok {
		t.Error("cleared is removed from the keychain")
	}
}

// No working store (a server, a locked-out desktop): nothing moves, nothing breaks.
func TestWithNoStoreSecretsStayInDotEnv(t *testing.T) {
	withVault(t, memVault{}, false)
	get, f := envFile(t, "TAILSCALE_API_KEY=tskey-api-abc123\n")
	env := loadEnv(get, nil)
	b, _ := os.ReadFile(f)
	if !strings.Contains(string(b), "TAILSCALE_API_KEY=tskey-api-abc123") || env.Get("TAILSCALE_API_KEY") != "tskey-api-abc123" {
		t.Errorf("%s", b)
	}
}

// A .env that says the keychain has it, on a computer whose keychain does not:
// read as not set, and said - never "@keychain" handed to Tailscale as a key.
func TestASecretTheKeychainCannotGiveIsSaidNotUsed(t *testing.T) {
	withVault(t, memVault{}, true)
	get, _ := envFile(t, "TAILSCALE_API_KEY=@keychain\n")
	var o, e bytes.Buffer
	env := loadEnv(get, &output.Out{Stdout: &o, Stderr: &e})
	if env.Get("TAILSCALE_API_KEY") != "" {
		t.Errorf("got %q", env.Get("TAILSCALE_API_KEY"))
	}
	if !strings.Contains(o.String()+e.String(), "the system keychain did not give back TAILSCALE_API_KEY") {
		t.Errorf("said: %s%s", o.String(), e.String())
	}
}

func TestAYISNoKeychainKeepsEverythingInDotEnv(t *testing.T) {
	v := memVault{}
	withVault(t, v, true)
	get, _ := envFile(t, "TAILSCALE_API_KEY=tskey-api-abc123\n")
	off := func(k string) (string, bool) {
		if k == "AYIS_NO_KEYCHAIN" {
			return "1", true
		}
		return get(k)
	}
	_ = loadEnv(off, nil)
	if len(v) != 0 {
		t.Errorf("touched the keychain: %v", v)
	}
}
