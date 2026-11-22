package watchdog

import (
	"context"
	"os"
	"testing"

	"github.com/jebin2/ayis/internal/config"
	wd "github.com/jebin2/ayis/internal/watchdog"
)

// TestLiveDeploymentIsCurrent reads the REAL account, so it only runs when asked:
//
//	AYIS_LIVE=1 AYIS_REPO=/path/to/checkout go test ./internal/commands/watchdog -run Live -v
//
// It proves the fingerprint, policy and package read back as they were deployed:
// a function `ayis watchdog install` made from this checkout must read as
// current. Read-only and free.
func TestLiveDeploymentIsCurrent(t *testing.T) {
	if os.Getenv("AYIS_LIVE") != "1" {
		t.Skip("set AYIS_LIVE=1 to read the real account")
	}
	env := config.Load(config.OSLookup, os.Getenv("AYIS_REPO"))
	r, err := NewReader(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	if r.Source, err = wd.Package(os.DirFS(os.Getenv("AYIS_REPO")+"/lambda"), wd.PackageDir); err != nil {
		t.Fatal(err)
	}
	st := r.Current(context.Background())
	t.Logf("installed=%v rule=%q drift=%v", st.Installed, st.Rule, st.Drift)
	if len(st.Drift) != 0 {
		t.Errorf("a function deployed from this checkout reads as drifted: %v", st.Drift)
	}
}
