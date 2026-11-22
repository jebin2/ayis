package arch

import (
	"bufio"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const module = "github.com/jebin2/ayis/"

// file is one Go source file: its package directory and what it imports.
type file struct {
	path    string // repo-relative
	pkg     string // repo-relative directory
	test    bool
	imports []string
	lines   int
	source  string
}

func root(t *testing.T) string {
	t.Helper()
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		up := filepath.Dir(dir)
		if up == dir {
			t.Fatal("no go.mod above the test")
		}
		dir = up
	}
}

func sources(t *testing.T) []file {
	t.Helper()
	r := root(t)
	var out []file
	for _, top := range []string{"cmd", "internal"} {
		err := filepath.WalkDir(filepath.Join(r, top), func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") {
				return err
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			f, err := parser.ParseFile(token.NewFileSet(), p, b, parser.ImportsOnly)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(r, p)
			rel = filepath.ToSlash(rel)
			x := file{path: rel, pkg: filepath.ToSlash(filepath.Dir(rel)), test: strings.HasSuffix(p, "_test.go"), source: string(b)}
			for _, im := range f.Imports {
				v, _ := strconv.Unquote(im.Path.Value)
				x.imports = append(x.imports, v)
			}
			sc := bufio.NewScanner(strings.NewReader(string(b)))
			sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
			for sc.Scan() {
				x.lines++
			}
			out = append(out, x)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func local(imp string) (string, bool) {
	if !strings.HasPrefix(imp, module) {
		return "", false
	}
	return strings.TrimPrefix(imp, module), true
}

func isCommand(pkg string) bool { return strings.HasPrefix(pkg, "internal/commands/") }

// The building blocks never reach up into a command: a command is a flow over
// them, and a block that knew a command could not be reused by another.
func TestBuildingBlocksNeverImportACommand(t *testing.T) {
	for _, f := range sources(t) {
		if isCommand(f.pkg) || strings.HasPrefix(f.pkg, "cmd/") {
			continue
		}
		for _, im := range f.imports {
			if p, ok := local(im); ok && isCommand(p) {
				t.Errorf("%s imports the command %s: move what it needs into a building block", f.path, p)
			}
		}
	}
}

// Commands that use other commands, as of P2. Each is a coupling that a building
// block should one day carry; a NEW one needs a reason, written here.
var commandEdges = map[string]bool{
	"awscmd->boxcmd": true, "awscmd->watchdog": true,
	"boxcmd->limitscmd": true, "boxcmd->watchdog": true,
	"check->creds": true, "check->deps": true, "check->watchdog": true,
	"cost->status": true, "games->remote": true,
	// doctor is every other command's reader, asked at once.
	"doctor->creds": true, "doctor->watchdog": true,
	"hostcmd->check": true, "hostcmd->creds": true,
	"initcmd->check": true, "initcmd->limitscmd": true, "initcmd->notify": true, "initcmd->watchdog": true,
	"librarycmd->configcmd": true, "librarycmd->watchdog": true,
	"quota->sweep": true, "sweep->machines": true,
	"watcher->status": true, "watcher->watchdog": true,
}

func TestNoNewCouplingBetweenCommands(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range sources(t) {
		if !isCommand(f.pkg) || f.test {
			continue
		}
		from := strings.TrimPrefix(f.pkg, "internal/commands/")
		for _, im := range f.imports {
			if p, ok := local(im); ok && isCommand(p) {
				edge := from + "->" + strings.TrimPrefix(p, "internal/commands/")
				seen[edge] = true
				if !commandEdges[edge] {
					t.Errorf("%s: new coupling %s - put the shared part in a building block, or add the edge with its reason", f.path, edge)
				}
			}
		}
	}
	for e := range commandEdges {
		if !seen[e] {
			t.Errorf("the edge %s is gone - take it off the list, so it cannot come back unnoticed", e)
		}
	}
}

// AWS clients are configured in one place: the region, the retry policy, the
// test endpoint and "never ask the instance metadata service" live there.
func TestOnlyAwscfgConfiguresAWS(t *testing.T) {
	for _, f := range sources(t) {
		if f.pkg == "internal/awscfg" {
			continue
		}
		for _, im := range f.imports {
			if im == "github.com/aws/aws-sdk-go-v2/config" {
				t.Errorf("%s configures AWS itself: use awscfg.New", f.path)
			}
		}
	}
}

// The fakes are for tests: shipped code that imported them could answer from a fake.
func TestFakesOnlyInTests(t *testing.T) {
	for _, f := range sources(t) {
		if f.test || f.pkg == "internal/testfixture" {
			continue
		}
		for _, im := range f.imports {
			if p, ok := local(im); ok && p == "internal/testfixture" {
				t.Errorf("%s imports the test fakes", f.path)
			}
		}
	}
}

// Settings come from config.Env, not the process environment, so every one has
// a registry row, a default and a rule. These are facts about the process, not
// settings, and each says why.
var envReads = map[string]string{
	"internal/config/env.go":         "the one reader of the environment for settings",
	"internal/ask/ask.go":            "AYIS_YES: the app answering yes, not a setting",
	"internal/awscfg/awscfg.go":      "AYIS_AWS_ENDPOINT: tests point AWS at a fake",
	"internal/pricing/fetch.go":      "AYIS_FX_URL: tests point the exchange rate at a fake",
	"internal/commands/creds/run.go": "AWS_PROFILE: the AWS CLI's own choice of profile",
	"internal/ownhost/ownhost.go":    "DISPLAY: whether this laptop has a screen",
}

func TestSettingsComeFromConfig(t *testing.T) {
	for _, f := range sources(t) {
		if f.test {
			continue
		}
		if strings.Contains(f.source, "os.Getenv(") || strings.Contains(f.source, "os.LookupEnv(") {
			if _, ok := envReads[f.path]; !ok {
				t.Errorf("%s reads the environment directly: add a setting to config.Registry, or list it here with why", f.path)
			}
		}
	}
}

// A file a person can hold in their head. Today's largest is 683 lines.
const maxLines = 800

func TestNoGiantFiles(t *testing.T) {
	var big []string
	for _, f := range sources(t) {
		if !f.test && f.lines > maxLines {
			big = append(big, f.path+" ("+strconv.Itoa(f.lines)+")")
		}
	}
	sort.Strings(big)
	if len(big) > 0 {
		t.Errorf("over %d lines - split by what each part does: %s", maxLines, strings.Join(big, ", "))
	}
}
