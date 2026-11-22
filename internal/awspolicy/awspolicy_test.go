package awspolicy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var (
	sdkImport = regexp.MustCompile(`(?:(\w+)\s+)?"github.com/aws/aws-sdk-go-v2/service/(\w+)"`)
	inputType = regexp.MustCompile(`\b(\w+)\.(\w+)Input\b`)
)

// called scans the CLI's source - not tests, not fakes - for every AWS SDK
// operation it uses: each call takes an <Operation>Input from its service package.
func called(t *testing.T) []string {
	t.Helper()
	set := map[string]bool{}
	for _, dir := range []string{"../../internal", "../../cmd"} {
		err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") ||
				strings.Contains(p, "testfixture") {
				return err
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			src := string(b)
			alias := map[string]string{}
			for _, m := range sdkImport.FindAllStringSubmatch(src, -1) {
				a := m[1]
				if a == "" {
					a = m[2]
				}
				alias[a] = m[2]
			}
			for _, m := range inputType.FindAllStringSubmatch(src, -1) {
				if svc, ok := alias[m[1]]; ok {
					set[svc+":"+m[2]] = true
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// The policy cannot fall behind the code: a new SDK call fails this until it is
// listed (and an IAM user made from `ayis aws policy` would be refused it), and
// a call removed from the code must leave the list too.
func TestOperationsAreExactlyWhatTheCodeCalls(t *testing.T) {
	code := called(t)
	if len(code) < 100 {
		t.Fatalf("found %d operations - the scan no longer matches the source", len(code))
	}
	listed := map[string]bool{}
	for _, op := range Operations {
		listed[op] = true
	}
	inCode := map[string]bool{}
	for _, op := range code {
		inCode[op] = true
		if !listed[op] {
			t.Errorf("the code calls %s but awspolicy.Operations does not list it", op)
		}
	}
	for _, op := range Operations {
		if !inCode[op] {
			t.Errorf("awspolicy.Operations lists %s but nothing calls it", op)
		}
	}
	if !sort.StringsAreSorted(Operations) {
		t.Error("keep Operations sorted")
	}
}

func TestEveryRenameIsAnOperationWeCall(t *testing.T) {
	listed := map[string]bool{}
	for _, op := range Operations {
		listed[op] = true
	}
	for op := range renamed {
		if !listed[op] {
			t.Errorf("renamed has %s, which is not called", op)
		}
	}
}

func TestTheDocumentNamesIAMActionsNotSDKCalls(t *testing.T) {
	acts := Actions()
	got := strings.Join(acts, " ")
	for _, want := range []string{"s3:ListBucket", "s3:PutBucketPublicAccessBlock", "logs:FilterLogEvents", "events:PutRule",
		"ce:GetCostAndUsage", "lambda:InvokeFunction", "budgets:ViewBudget", "budgets:ModifyBudget", "iam:PassRole", "ec2:RunInstances"} {
		if !strings.Contains(" "+got+" ", " "+want+" ") {
			t.Errorf("lacks %s", want)
		}
	}
	for _, bad := range []string{"s3:ListObjectsV2", "s3:HeadObject", "cloudwatchlogs:", "eventbridge:", "costexplorer:", "lambda:Invoke ", "budgets:DescribeBudget "} {
		if strings.Contains(" "+got+" ", bad) {
			t.Errorf("%q is an SDK name, not an IAM action", bad)
		}
	}
	if _, err := json.Marshal(Document()); err != nil {
		t.Fatal(err)
	}
}
