// Package keychain keeps ayis's secrets in the operating system's own store -
// Secret Service (GNOME Keyring, KWallet) on Linux, Keychain on macOS,
// Credential Manager on Windows - instead of in plain text in .env. It is the
// config.Vault ayis uses when one answers; with none (a headless server, CI),
// secrets stay in .env as before.
package keychain

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// Service is the name ayis's entries are kept under.
const Service = "ayis"

// Store is the OS store, for one settings file: entries are named after the
// file, so two checkouts (or a test's) never share a secret.
type Store struct{ File string }

func (s Store) user(key string) string { return key + "@" + s.File }

// Get is a secret, or an error when it is not there or the store does not answer.
func (s Store) Get(key string) (string, error) { return keyring.Get(Service, s.user(key)) }

// Set keeps a secret.
func (s Store) Set(key, value string) error { return keyring.Set(Service, s.user(key), value) }

// Delete removes a secret; one that is not there is already deleted.
func (s Store) Delete(key string) error {
	if err := keyring.Delete(Service, s.user(key)); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return err
	}
	return nil
}

// Works says whether the store answers here: it writes, reads back and removes a
// probe. A desktop without a running keyring, or a server, says no.
func Works(file string) bool {
	s := Store{File: file}
	if s.Set("AYIS_PROBE", "ok") != nil {
		return false
	}
	v, err := s.Get("AYIS_PROBE")
	_ = s.Delete("AYIS_PROBE")
	return err == nil && v == "ok"
}
