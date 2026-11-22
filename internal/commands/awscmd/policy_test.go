package awscmd

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/jebin2/ayis/internal/config"
	"github.com/jebin2/ayis/internal/output"
)

// `ayis aws policy` prints the policy and asks AWS nothing - it works before any
// key is set, which is when it is needed.
func TestPolicyPrintsTheDocumentWithoutAWS(t *testing.T) {
	t.Setenv("AYIS_AWS_ENDPOINT", "http://127.0.0.1:1") // any AWS call would fail
	var o, e bytes.Buffer
	env := config.Load(func(string) (string, bool) { return "", false }, t.TempDir())
	if rc := Run(context.Background(), env, []string{"policy"}, false, &output.Out{Stdout: &o, Stderr: &e}); rc != 0 {
		t.Fatalf("rc %d: %s", rc, e.String())
	}
	var doc struct {
		Version   string
		Statement []struct {
			Effect   string
			Action   []string
			Resource string
		}
	}
	if err := json.Unmarshal(o.Bytes(), &doc); err != nil || doc.Version != "2012-10-17" || len(doc.Statement) != 1 ||
		doc.Statement[0].Effect != "Allow" || len(doc.Statement[0].Action) < 100 {
		t.Errorf("not the policy: %v\n%s", err, o.String())
	}
}
