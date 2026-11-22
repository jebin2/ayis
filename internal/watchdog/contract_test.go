package watchdog

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The role lets the function tag an instance only with the keys listed in its
// policy (aws:TagKeys). A tag the Python writes that is not listed is refused by
// AWS at the one moment it matters - a shutdown being recorded - so every tag
// the function writes is checked against the policy here, from the source.
func TestTheRoleMayWriteEveryTagTheFunctionWrites(t *testing.T) {
	dir := filepath.Join("..", "..", "lambda", PackageDir)
	settings, err := os.ReadFile(filepath.Join(dir, "settings.py"))
	if err != nil {
		t.Fatal(err)
	}
	value := map[string]string{}
	for _, m := range regexp.MustCompile(`(?m)^([A-Z_]+_TAG) = "([^"]+)"`).FindAllStringSubmatch(string(settings), -1) {
		value[m[1]] = m[2]
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.py"))
	if err != nil {
		t.Fatal(err)
	}
	written := map[string]bool{}
	call := regexp.MustCompile(`\btag\(ec2, [^,]+, settings\.([A-Z_]+)`)
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range call.FindAllStringSubmatch(string(b), -1) {
			written[m[1]] = true
		}
	}
	if len(written) < 6 {
		t.Fatalf("found %d tags written - the pattern no longer matches the source", len(written))
	}
	allowed := map[string]bool{}
	policy := Settings{Host: "ayis", Account: "1"}.Policy("r")
	for _, st := range policy["Statement"].([]any) {
		m := st.(map[string]any)
		if m["Action"] != "ec2:CreateTags" {
			continue
		}
		keys := m["Condition"].(map[string]any)["ForAllValues:StringEquals"].(map[string]any)["aws:TagKeys"].([]string)
		for _, k := range keys {
			allowed[k] = true
		}
	}
	for name := range written {
		v, ok := value[name]
		if !ok {
			t.Errorf("settings.%s is written but has no value in settings.py", name)
			continue
		}
		if !allowed[v] {
			t.Errorf("the function writes the tag %q (settings.%s) but the role may not: add it to the policy", v, name)
		}
	}
	// And nothing is allowed that the function no longer writes.
	for k := range allowed {
		found := false
		for name := range written {
			found = found || value[name] == k
		}
		if !found {
			t.Errorf("the role may write %q but the function never does", k)
		}
	}
}
