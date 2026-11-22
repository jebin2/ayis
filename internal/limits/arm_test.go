package limits

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/budgets"
	budgetstypes "github.com/aws/aws-sdk-go-v2/service/budgets/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	iamtypes "github.com/aws/aws-sdk-go-v2/service/iam/types"
)

// account is IAM and AWS Budgets with state, so a run stopped part way can be
// run again against what it left. stopAt is the write call that is cut off
// (1-based; 0 never); lost says that write still happened in AWS - the request
// went out and only the answer was lost - the case that duplicates things when
// a run is not careful.
type account struct {
	IAM
	policies, roles, rolePolicies map[string]bool
	actions                       []budgetstypes.Action
	creates                       map[string]int
	writes, stopAt                int
	lost                          bool
}

func newAccount() *account {
	return &account{policies: map[string]bool{}, roles: map[string]bool{}, rolePolicies: map[string]bool{}, creates: map[string]int{}}
}

var errStopped = fmt.Errorf("stopped: %w", context.Canceled)

// write runs do as one write call: it may be the one that is cut off.
func (a *account) write(name string, do func()) error {
	a.writes++
	if a.writes == a.stopAt {
		if a.lost {
			do()
			a.creates[name]++
		}
		return errStopped
	}
	do()
	a.creates[name]++
	return nil
}

func notFound() error { return errors.New("NoSuchEntity: not there") }

func (a *account) GetPolicy(_ context.Context, in *iam.GetPolicyInput, _ ...func(*iam.Options)) (*iam.GetPolicyOutput, error) {
	if !a.policies[*in.PolicyArn] {
		return nil, notFound()
	}
	return &iam.GetPolicyOutput{}, nil
}

func (a *account) CreatePolicy(_ context.Context, in *iam.CreatePolicyInput, _ ...func(*iam.Options)) (*iam.CreatePolicyOutput, error) {
	arn := BlockPolicyARN("1", "ayis")
	if a.policies[arn] {
		return nil, errors.New("EntityAlreadyExists")
	}
	return &iam.CreatePolicyOutput{}, a.write("policy", func() { a.policies[arn] = true })
}

func (a *account) GetRole(_ context.Context, in *iam.GetRoleInput, _ ...func(*iam.Options)) (*iam.GetRoleOutput, error) {
	if !a.roles[*in.RoleName] {
		return nil, notFound()
	}
	return &iam.GetRoleOutput{Role: &iamtypes.Role{Arn: aws.String("arn:role/" + *in.RoleName)}}, nil
}

func (a *account) CreateRole(_ context.Context, in *iam.CreateRoleInput, _ ...func(*iam.Options)) (*iam.CreateRoleOutput, error) {
	if a.roles[*in.RoleName] {
		return nil, errors.New("EntityAlreadyExists")
	}
	err := a.write("role", func() { a.roles[*in.RoleName] = true })
	return &iam.CreateRoleOutput{Role: &iamtypes.Role{Arn: aws.String("arn:role/" + *in.RoleName)}}, err
}

func (a *account) PutRolePolicy(_ context.Context, in *iam.PutRolePolicyInput, _ ...func(*iam.Options)) (*iam.PutRolePolicyOutput, error) {
	return &iam.PutRolePolicyOutput{}, a.write("role-policy", func() { a.rolePolicies[*in.RoleName] = true })
}

func (a *account) DescribeBudgetActionsForBudget(context.Context, *budgets.DescribeBudgetActionsForBudgetInput, ...func(*budgets.Options)) (*budgets.DescribeBudgetActionsForBudgetOutput, error) {
	return &budgets.DescribeBudgetActionsForBudgetOutput{Actions: a.actions}, nil
}

func (a *account) CreateBudgetAction(_ context.Context, in *budgets.CreateBudgetActionInput, _ ...func(*budgets.Options)) (*budgets.CreateBudgetActionOutput, error) {
	return &budgets.CreateBudgetActionOutput{}, a.write("action", func() {
		a.actions = append(a.actions, budgetstypes.Action{ActionId: aws.String(fmt.Sprintf("a%d", len(a.actions)+1)), Definition: in.Definition})
	})
}

func (a *account) UpdateBudgetAction(context.Context, *budgets.UpdateBudgetActionInput, ...func(*budgets.Options)) (*budgets.UpdateBudgetActionOutput, error) {
	return &budgets.UpdateBudgetActionOutput{}, a.write("update", func() {})
}

func (a *account) ExecuteBudgetAction(context.Context, *budgets.ExecuteBudgetActionInput, ...func(*budgets.Options)) (*budgets.ExecuteBudgetActionOutput, error) {
	return &budgets.ExecuteBudgetActionOutput{}, nil
}

func (a *account) armed(t *testing.T, why string) {
	t.Helper()
	if !a.policies[BlockPolicyARN("1", "ayis")] || !a.roles[ActionRoleName("ayis")] || !a.rolePolicies[ActionRoleName("ayis")] || len(a.actions) != 1 {
		t.Errorf("%s: not armed exactly once - policy %v, role %v, its policy %v, actions %d",
			why, a.policies, a.roles, a.rolePolicies, len(a.actions))
	}
	if a.creates["policy"] > 1 || a.creates["role"] > 1 || a.creates["action"] > 1 {
		t.Errorf("%s: something was made twice: %v", why, a.creates)
	}
}

// Stopped after any one of its writes - with that write landing in AWS or not -
// `ayis limits arm` run again finishes the job and makes nothing twice.
func TestArmStoppedAtAnyStepFinishesWhenRunAgain(t *testing.T) {
	ctx := context.Background()
	p := Principal{Kind: "user", Name: "CLI"}
	for _, lost := range []bool{false, true} {
		for stop := 1; stop <= 4; stop++ {
			why := fmt.Sprintf("stopped at write %d (landed: %v)", stop, lost)
			a := newAccount()
			a.stopAt, a.lost = stop, lost
			b := Block{IAM: a, Budgets: a, Account: "1", Host: "ayis"}
			if err := b.Arm(ctx, p, []string{"me@example.com"}); !errors.Is(err, context.Canceled) {
				t.Fatalf("%s: the stop is reported as one: %v", why, err)
			}
			a.stopAt = 0
			if err := b.Arm(ctx, p, []string{"me@example.com"}); err != nil {
				t.Fatalf("%s: run again: %v", why, err)
			}
			a.armed(t, why)
		}
	}
	// And a run that was never stopped, run twice, is still armed once.
	a := newAccount()
	b := Block{IAM: a, Budgets: a, Account: "1", Host: "ayis"}
	for i := 0; i < 2; i++ {
		if err := b.Arm(ctx, p, []string{"me@example.com"}); err != nil {
			t.Fatal(err)
		}
	}
	a.armed(t, "armed twice")
	if a.creates["update"] != 1 {
		t.Errorf("the second run updates the action it finds: %v", a.creates)
	}
}
