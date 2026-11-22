package watchdog

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// Python's zipfile writing the same entries, the same way: the zip Lambda
// unpacks must be one any ordinary tool reads.
const pyZip = `
import sys, zipfile, hashlib, base64, pathlib
src, out = sys.argv[1:3]
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for f in sorted(pathlib.Path(src).glob("*.py")):
        info = zipfile.ZipInfo("ayis_watchdog/" + f.name, (1980, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        z.writestr(info, f.read_bytes())
print(base64.b64encode(hashlib.sha256(open(out, "rb").read()).digest()).decode())
`

func source(t *testing.T) []File {
	t.Helper()
	files, err := Package(os.DirFS("../../lambda"), PackageDir)
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestZipIsByteIdenticalToPythons(t *testing.T) {
	files := source(t)
	out := filepath.Join(t.TempDir(), "fn.zip")
	b, err := exec.Command("python3", "-I", "-c", pyZip, "../../lambda/"+PackageDir, out).Output()
	if err != nil {
		t.Skip("no python3")
	}
	want, _ := os.ReadFile(out)
	got, sha := Zip(files)
	if !bytes.Equal(got, want) {
		t.Fatalf("zip differs: got %d bytes, python %d", len(got), len(want))
	}
	if sha != strings.TrimSpace(string(b)) {
		t.Errorf("sha %s want %s", sha, b)
	}
	// And it is a real zip of every file, each one the source.
	r, err := zip.NewReader(bytes.NewReader(got), int64(len(got)))
	if err != nil || len(r.File) != len(files) {
		t.Fatalf("not a zip of %d files: %v", len(files), err)
	}
	for i, zf := range r.File {
		f, _ := zf.Open()
		body, _ := io.ReadAll(f)
		if zf.Name != files[i].Name || !bytes.Equal(body, files[i].Data) {
			t.Errorf("entry %d is %s, not the source %s", i, zf.Name, files[i].Name)
		}
	}
}

// The package is the .py files only - the handler among them - and the same
// source is the same zip every time.
func TestPackageShipsTheSourceOnly(t *testing.T) {
	fsys := fstest.MapFS{
		"l/ayis_watchdog/handler.py":              {Data: []byte("h")},
		"l/ayis_watchdog/__init__.py":             {Data: []byte("")},
		"l/ayis_watchdog/__pycache__/handler.pyc": {Data: []byte("x")},
		"l/ayis_watchdog/notes.txt":               {Data: []byte("x")},
		"l/tests/test_idle.py":                    {Data: []byte("x")},
	}
	files, err := Package(fsys, "l/ayis_watchdog")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range files {
		names = append(names, f.Name)
	}
	if got := strings.Join(names, ","); got != "ayis_watchdog/__init__.py,ayis_watchdog/handler.py" {
		t.Errorf("shipped %s", got)
	}
	a, _ := Zip(files)
	b, _ := Zip(files)
	if !bytes.Equal(a, b) {
		t.Error("the same source made two different zips")
	}
	if _, err := Package(fsys, "l/nothing"); err == nil {
		t.Error("an empty folder must be an error, not an empty function")
	}
	if !strings.HasPrefix(Handler, PackageDir+".") {
		t.Errorf("handler %s is not in the package", Handler)
	}
}

func TestEnvAndFingerprint(t *testing.T) {
	s := Settings{Host: "ayis", Account: "123456789012", Bucket: "ayis-library-abc", IdleMinutes: 30, StuckMinutes: 60, ExpiryDays: 14,
		S3GBMonth: "0.025", INRPerUSD: "112.041", NtfyURL: "https://ntfy.sh/topic"}
	want := "Variables={AYIS_TS_HOST=ayis,AYIS_IDLE_MINUTES=30,AYIS_BOOT_GRACE_MINUTES=20,AYIS_STUCK_MINUTES=60,AYIS_BUCKET=ayis-library-abc,AYIS_ACCOUNT=123456789012,AYIS_ARCHIVE_EXPIRY_DAYS=14,AYIS_S3_USD_GB_MONTH=0.025,AYIS_INR_PER_USD=112.041,AYIS_NTFY_URL=https://ntfy.sh/topic}"
	if got := s.Env(); got != want {
		t.Errorf("env %s", got)
	}
	s.S3GBMonth, s.INRPerUSD, s.NtfyURL = "", "", ""
	if got := s.Env(); !strings.HasSuffix(got, "AYIS_ARCHIVE_EXPIRY_DAYS=14}") {
		t.Errorf("unset values are absent: %s", got)
	}
	a := s.Fingerprint("arn:aws:iam::123456789012:role/ayis-cloud-watchdog")
	if len(a) != 12 {
		t.Errorf("fingerprint %q", a)
	}
	s.IdleMinutes = 31
	if s.Fingerprint("arn:aws:iam::123456789012:role/ayis-cloud-watchdog") == a {
		t.Error("a changed setting must change the fingerprint")
	}
	// The same text the shell hashed: runtime|handler|role|timeout|memory|env, newline.
	out, err := exec.Command("bash", "-c", `printf '%s|%s|%s|300|128|%s\n' python3.13 ayis_watchdog.handler.handler "$1" "$2" | sha256sum | cut -c1-12`,
		"_", "arn:aws:iam::1:role/r", s.Env()).Output()
	if _, nosum := exec.LookPath("sha256sum"); nosum == nil && err == nil && strings.TrimSpace(string(out)) != s.Fingerprint("arn:aws:iam::1:role/r") {
		t.Errorf("fingerprint differs from the shell's: %s", out)
	}
}

func TestPolicyOnlyGrowsWithExpiry(t *testing.T) {
	s := Settings{Host: "ayis", Account: "1", ExpiryDays: 0}
	n := func(p map[string]any) int { return len(p["Statement"].([]any)) }
	off := n(s.Policy("ap-south-2"))
	s.ExpiryDays = 14
	if on := n(s.Policy("ap-south-2")); on <= off {
		t.Errorf("expiry on should add statements: %d vs %d", on, off)
	}
	// With expiry 0 the role cannot delete a single game.
	b, _ := jsonOf(s.withExpiry(0).Policy("ap-south-2"))
	if strings.Contains(b, "s3:DeleteObject") || strings.Contains(b, "s3:DeleteBucket") {
		t.Error("expiry 0 must not grant any delete")
	}
	if !strings.Contains(jsonMust(s.Policy("ap-south-2")), "ayis-stopped-warned") {
		t.Error("the stopped-box tags must be allowed")
	}
}

func TestPolicyComparedAsData(t *testing.T) {
	s := Settings{Host: "ayis", Account: "1", ExpiryDays: 14}
	p := s.Policy("ap-south-2")
	reformatted := []byte("{\n  \"Statement\": " + jsonMust(p["Statement"]) + ",\n \"Version\": \"2012-10-17\"}")
	if !PolicyMatches(reformatted, p) {
		t.Error("a reformatted but equal policy must match")
	}
	if PolicyMatches([]byte(`{"Version":"2012-10-17","Statement":[]}`), p) || PolicyMatches([]byte("nope"), p) {
		t.Error("a different or broken policy must not match")
	}
}

func (s Settings) withExpiry(days int) Settings { s.ExpiryDays = days; return s }

func jsonOf(v any) (string, error) { b, err := json.Marshal(v); return string(b), err }

func jsonMust(v any) string { s, _ := jsonOf(v); return s }

func TestLimitsOffKeepTheDeployedText(t *testing.T) {
	s := Settings{Host: "ayis", Account: "1", IdleMinutes: 30, StuckMinutes: 60}
	before := s.Env()
	if strings.Contains(before, "MAX_") || strings.Contains(before, "BLOCK") {
		t.Errorf("limits off must not appear: %s", before)
	}
	s.MaxHoursMonth, s.MaxSessionHours, s.BlockPolicyARN = 60, 6, "arn:aws:iam::1:policy/ayis-budget-block"
	on := s.Env()
	if !strings.HasPrefix(on, strings.TrimSuffix(before, "}")) ||
		!strings.HasSuffix(on, ",AYIS_MAX_HOURS_MONTH=60,AYIS_MAX_SESSION_HOURS=6,AYIS_BLOCK_POLICY_ARN=arn:aws:iam::1:policy/ayis-budget-block}") {
		t.Errorf("limits go last: %s", on)
	}
	s.ODUSDHour = "0.526"
	if !strings.HasSuffix(s.Env(), ",AYIS_OD_USD_HOUR=0.526}") || s.EnvMap()["AYIS_OD_USD_HOUR"] != "0.526" {
		t.Errorf("the hour's price goes last: %s", s.Env())
	}
	m := s.EnvMap()
	if m["AYIS_MAX_HOURS_MONTH"] != "60" || m["AYIS_MAX_SESSION_HOURS"] != "6" || m["AYIS_BLOCK_POLICY_ARN"] == "" {
		t.Errorf("map: %v", m)
	}
}

func TestNoLimitsNoCostReads(t *testing.T) {
	p := jsonMust(Settings{Host: "ayis", Account: "1"}.Policy("ap-south-1"))
	if strings.Contains(p, "budgets:") || strings.Contains(p, "SpotPrice") {
		t.Errorf("cost reads without limits: %s", p)
	}
}

func TestPolicyForLimits(t *testing.T) {
	s := Settings{Host: "ayis", Account: "1", ExpiryDays: 0, MaxHoursMonth: 60, BlockPolicyARN: "arn:aws:iam::1:policy/ayis-budget-block"}
	p := jsonMust(s.Policy("ap-south-1"))
	for _, want := range []string{`"Sid":"UsageMarks"`, `"ssm:PutParameter"`, `"iam:ListEntitiesForPolicy"`, `"Resource":"arn:aws:iam::1:policy/ayis-budget-block"`, `"ayis-session-warned"`,
		`"ec2:DescribeSpotPriceHistory"`, `"budgets:ViewBudget"`, `"Resource":"arn:aws:budgets::1:budget/ayis-monthly"`} {
		if !strings.Contains(p, want) {
			t.Errorf("policy lacks %s: %s", want, p)
		}
	}
	// Still no delete of anything with expiry off; and the IAM read is that one policy.
	if strings.Contains(p, "s3:Delete") || strings.Contains(p, "ssm:DeleteParameter") || strings.Contains(p, `"iam:Attach`) {
		t.Errorf("limits must not grant deletes or attaches: %s", p)
	}
	// Expiry on already grants the marks: not granted twice.
	s.ExpiryDays = 14
	if strings.Contains(jsonMust(s.Policy("ap-south-1")), "UsageMarks") {
		t.Error("UsageMarks duplicates ArchiveExpiryMarks")
	}
}
