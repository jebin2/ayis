package watchdog

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

// Rolling back a deploy. Before an install changes the function, it publishes
// what is running as a Lambda VERSION - an immutable copy of the code and its
// settings, kept by AWS at no charge - so `ayis watchdog rollback` can put it
// back, from any computer. KeepVersions are kept; older ones are deleted.
//
// A function rolled back says so in its description, and an ordinary install -
// which every build runs - leaves it alone: it is there because a person chose
// it. `ayis watchdog install --force` puts this version of ayis's back.

// KeepVersions is how many earlier deploys can be rolled back to.
const KeepVersions = 3

// RolledBack marks a function's description after a rollback.
const RolledBack = " rolled-back="

// IsRolledBack says whether the deployed function was rolled back, and when.
func IsRolledBack(description string) (string, bool) {
	_, when, ok := strings.Cut(description, RolledBack)
	return when, ok
}

// snapshot publishes what is running, before an install changes it, and prunes
// the oldest. Never fatal: without it there is nothing to roll back to, which
// is said, and the install goes on.
func (i *Installer) snapshot(ctx context.Context, name string) {
	v, err := i.Lambda.PublishVersion(ctx, &lambda.PublishVersionInput{FunctionName: aws.String(name),
		Description: aws.String("before an ayis update, " + time.Now().UTC().Format("2006-01-02 15:04 UTC"))})
	if err != nil {
		i.log("could not keep the running watchdog to roll back to (not fatal): " + firstLine(err))
		return
	}
	i.log("kept the running watchdog as version " + aws.ToString(v.Version) + " - ayis watchdog rollback puts it back")
	vs, err := i.versions(ctx, name)
	if err != nil {
		return
	}
	for len(vs) > KeepVersions {
		old := strconv.Itoa(vs[0])
		vs = vs[1:]
		_, _ = i.Lambda.DeleteFunction(ctx, &lambda.DeleteFunctionInput{FunctionName: aws.String(name), Qualifier: aws.String(old)})
	}
}

// versions are the published version numbers, oldest first.
func (i *Installer) versions(ctx context.Context, name string) ([]int, error) {
	var out []int
	var marker *string
	for {
		o, err := i.Lambda.ListVersionsByFunction(ctx, &lambda.ListVersionsByFunctionInput{FunctionName: aws.String(name), Marker: marker})
		if err != nil {
			return nil, err
		}
		for _, v := range o.Versions {
			if n, err := strconv.Atoi(aws.ToString(v.Version)); err == nil {
				out = append(out, n)
			}
		}
		if aws.ToString(o.NextMarker) == "" {
			sort.Ints(out)
			return out, nil
		}
		marker = o.NextMarker
	}
}

// ErrNothingToRollBack: no earlier deploy was kept.
var ErrNothingToRollBack = errors.New("no earlier watchdog was kept to roll back to - one is kept from the next update on")

// Rollback puts the newest kept deploy back: its code and its settings.
func (i *Installer) Rollback(ctx context.Context) error {
	name := Name(i.Host)
	vs, err := i.versions(ctx, name)
	if err != nil {
		return fmt.Errorf("could not list the kept watchdogs: %w", err)
	}
	if len(vs) == 0 {
		return ErrNothingToRollBack
	}
	v := strconv.Itoa(vs[len(vs)-1])
	o, err := i.Lambda.GetFunction(ctx, &lambda.GetFunctionInput{FunctionName: aws.String(name), Qualifier: aws.String(v)})
	if err != nil || o.Code == nil || o.Configuration == nil {
		return fmt.Errorf("could not read version %s: %v", v, err)
	}
	fetch := i.Fetch
	if fetch == nil {
		fetch = httpGet
	}
	zip, err := fetch(ctx, aws.ToString(o.Code.Location))
	if err != nil {
		return fmt.Errorf("could not download version %s: %w", v, err)
	}
	c := o.Configuration
	i.log("rolling back to version " + v + " (" + aws.ToString(c.Description) + ")")
	if _, err := i.Lambda.UpdateFunctionCode(ctx, &lambda.UpdateFunctionCodeInput{FunctionName: aws.String(name), ZipFile: zip}); err != nil {
		return fmt.Errorf("could not put version %s's code back: %w", v, err)
	}
	i.waitFunction(ctx)
	var env *lambdatypes.Environment
	if c.Environment != nil {
		env = &lambdatypes.Environment{Variables: c.Environment.Variables}
	}
	desc, _, _ := strings.Cut(aws.ToString(c.Description), RolledBack)
	desc += RolledBack + time.Now().UTC().Format("2006-01-02T15:04:05Z")
	if _, err := i.Lambda.UpdateFunctionConfiguration(ctx, &lambda.UpdateFunctionConfigurationInput{FunctionName: aws.String(name),
		Runtime: c.Runtime, Handler: c.Handler, Role: c.Role, Timeout: c.Timeout, MemorySize: c.MemorySize,
		Environment: env, Description: aws.String(desc)}); err != nil {
		return fmt.Errorf("could not put version %s's settings back: %w", v, err)
	}
	i.waitFunction(ctx)
	i.log("rolled back - builds leave it as it is now; ayis watchdog install --force puts this version of ayis's back")
	return nil
}

func httpGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

func firstLine(err error) string { return strings.SplitN(err.Error(), "\n", 2)[0] }
