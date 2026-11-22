package config

import "testing"

func TestAnNtfyTokenIsCheckedAsOneAndATailscaleTokenAsOne(t *testing.T) {
	for _, c := range []struct{ key, v, want string }{
		{"GAME_NTFY_TOKEN", "", ""},
		{"GAME_NTFY_TOKEN", "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2", ""},
		{"GAME_NTFY_TOKEN", "tskey-api-abc123", "does not look like an ntfy access token (tk_...)"},
		{"GAME_NTFY_TOKEN", "tk_ bad", "does not look like an ntfy access token (tk_...)"},
		{"TAILSCALE_API_KEY", "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2", "does not look like a Tailscale token"},
		{"TAILSCALE_API_KEY", "tskey-api-abc123", ""},
	} {
		if got := Validate(c.key, c.v); got != c.want {
			t.Errorf("%s=%q: %q, want %q", c.key, c.v, got, c.want)
		}
	}
	if !IsAccount("GAME_NTFY_TOKEN") {
		t.Error("the token travels with the URL: both are account settings")
	}
}
