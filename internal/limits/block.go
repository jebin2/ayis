package limits

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/budgets"
	budgetstypes "github.com/aws/aws-sdk-go-v2/service/budgets/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
)

// IAM is what arming, undoing and removing the block uses.
type IAM interface {
	IAMRead
	GetPolicy(context.Context, *iam.GetPolicyInput, ...func(*iam.Options)) (*iam.GetPolicyOutput, error)
	CreatePolicy(context.Context, *iam.CreatePolicyInput, ...func(*iam.Options)) (*iam.CreatePolicyOutput, error)
	DeletePolicy(context.Context, *iam.DeletePolicyInput, ...func(*iam.Options)) (*iam.DeletePolicyOutput, error)
	DetachUserPolicy(context.Context, *iam.DetachUserPolicyInput, ...func(*iam.Options)) (*iam.DetachUserPolicyOutput, error)
	DetachRolePolicy(context.Context, *iam.DetachRolePolicyInput, ...func(*iam.Options)) (*iam.DetachRolePolicyOutput, error)
	GetRole(context.Context, *iam.GetRoleInput, ...func(*iam.Options)) (*iam.GetRoleOutput, error)
	CreateRole(context.Context, *iam.CreateRoleInput, ...func(*iam.Options)) (*iam.CreateRoleOutput, error)
	PutRolePolicy(context.Context, *iam.PutRolePolicyInput, ...func(*iam.Options)) (*iam.PutRolePolicyOutput, error)
	DeleteRolePolicy(context.Context, *iam.DeleteRolePolicyInput, ...func(*iam.Options)) (*iam.DeleteRolePolicyOutput, error)
	DeleteRole(context.Context, *iam.DeleteRoleInput, ...func(*iam.Options)) (*iam.DeleteRoleOutput, error)
}

// Budgets is what arming and undoing the block uses of AWS Budgets.
type Budgets interface {
	DescribeBudgetActionsForBudget(context.Context, *budgets.DescribeBudgetActionsForBudgetInput, ...func(*budgets.Options)) (*budgets.DescribeBudgetActionsForBudgetOutput, error)
	CreateBudgetAction(context.Context, *budgets.CreateBudgetActionInput, ...func(*budgets.Options)) (*budgets.CreateBudgetActionOutput, error)
	UpdateBudgetAction(context.Context, *budgets.UpdateBudgetActionInput, ...func(*budgets.Options)) (*budgets.UpdateBudgetActionOutput, error)
	ExecuteBudgetAction(context.Context, *budgets.ExecuteBudgetActionInput, ...func(*budgets.Options)) (*budgets.ExecuteBudgetActionOutput, error)
}

// Principal is who ayis runs as, which is who the block is attached to: an IAM
// user, or the role behind an assumed-role session. The account's root user
// cannot have a policy attached, so with root there is no block.
type Principal struct {
	Kind string // "user" | "role"
	Name string
}

// PrincipalOf reads the caller's ARN.
func PrincipalOf(arn string) (Principal, error) {
	parts := strings.SplitN(arn, ":", 6)
	if len(parts) != 6 {
		return Principal{}, fmt.Errorf("not an ARN: %q", arn)
	}
	res := parts[5]
	switch {
	case res == "root":
		return Principal{}, fmt.Errorf("ayis is signed in as the account's root user, which a policy cannot be attached to - use an IAM user's access key")
	case strings.HasPrefix(res, "user/"):
		p := strings.Split(res, "/")
		return Principal{Kind: "user", Name: p[len(p)-1]}, nil
	case strings.HasPrefix(res, "assumed-role/"):
		p := strings.Split(res, "/")
		if len(p) >= 2 {
			return Principal{Kind: "role", Name: p[1]}, nil
		}
	}
	return Principal{}, fmt.Errorf("cannot tell which user or role %q is", arn)
}

// BlockPolicy denies launching or starting THIS host's machines - and nothing
// else, so the same IAM user can still do anything else it does in the account.
// RunInstances is denied when the instance it would make is tagged with the
// host, which every ayis launch is; StartInstances when the instance is.
func BlockPolicy(host string) map[string]any {
	return map[string]any{"Version": "2012-10-17", "Statement": []any{
		map[string]any{"Sid": "NoNewMachineWhenTheBudgetIsSpent", "Effect": "Deny", "Action": "ec2:RunInstances",
			"Resource":  "arn:aws:ec2:*:*:instance/*",
			"Condition": map[string]any{"StringEquals": map[string]any{"aws:RequestTag/Name": host}}},
		map[string]any{"Sid": "NoRestartWhenTheBudgetIsSpent", "Effect": "Deny", "Action": "ec2:StartInstances",
			"Resource":  "arn:aws:ec2:*:*:instance/*",
			"Condition": map[string]any{"StringEquals": map[string]any{"ec2:ResourceTag/Name": host}}},
	}}
}

// actionRolePolicy lets AWS Budgets attach and detach the block policy, and no
// other policy, to anyone.
func actionRolePolicy(account, host string) map[string]any {
	return map[string]any{"Version": "2012-10-17", "Statement": []any{
		map[string]any{"Sid": "AttachOnlyTheBlock", "Effect": "Allow",
			"Action":    []string{"iam:AttachUserPolicy", "iam:DetachUserPolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy"},
			"Resource":  "*",
			"Condition": map[string]any{"ArnEquals": map[string]any{"iam:PolicyARN": BlockPolicyARN(account, host)}}},
	}}
}

func assumeBudgets(account string) string {
	b, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []any{
		map[string]any{"Effect": "Allow", "Principal": map[string]any{"Service": "budgets.amazonaws.com"}, "Action": "sts:AssumeRole",
			"Condition": map[string]any{"StringEquals": map[string]any{"aws:SourceAccount": account}}}}})
	return string(b)
}

// Block arms and undoes the budget's block.
type Block struct {
	IAM     IAM
	Budgets Budgets
	Account string
	Host    string
	Out     func(string)
	Sleep   func(time.Duration)
}

func (b Block) say(s string) {
	if b.Out != nil {
		b.Out(s)
	}
}

func (b Block) definition(p Principal) *budgetstypes.Definition {
	d := &budgetstypes.IamActionDefinition{PolicyArn: aws.String(BlockPolicyARN(b.Account, b.Host))}
	if p.Kind == "role" {
		d.Roles = []string{p.Name}
	} else {
		d.Users = []string{p.Name}
	}
	return &budgetstypes.Definition{IamActionDefinition: d}
}

// Arm makes the policy and the role, and puts the action on the budget: at 100%
// of the budget actually spent, AWS attaches the policy to who ayis runs as. It
// needs the budget to exist (it is armed just before) and someone to tell.
func (b Block) Arm(ctx context.Context, p Principal, emails []string) error {
	b.say("==> budget block")
	if len(emails) == 0 {
		b.say("    no alert address - AWS needs someone to tell, so there is no block")
		return nil
	}
	pol := BlockPolicyARN(b.Account, b.Host)
	if _, err := b.IAM.GetPolicy(ctx, &iam.GetPolicyInput{PolicyArn: aws.String(pol)}); err != nil {
		if !strings.Contains(err.Error(), "NoSuchEntity") {
			return fmt.Errorf("could not read the block policy: %w", err)
		}
		doc, _ := json.Marshal(BlockPolicy(b.Host))
		if _, err := b.IAM.CreatePolicy(ctx, &iam.CreatePolicyInput{PolicyName: aws.String(BlockPolicyName(b.Host)), PolicyDocument: aws.String(string(doc)),
			Description: aws.String("ayis: no new or restarted " + b.Host + " machine while the month's budget is spent")}); err != nil {
			return fmt.Errorf("could not make the block policy: %w", err)
		}
	}
	role := ActionRoleName(b.Host)
	ro, err := b.IAM.GetRole(ctx, &iam.GetRoleInput{RoleName: aws.String(role)})
	if err != nil {
		if !strings.Contains(err.Error(), "NoSuchEntity") {
			return fmt.Errorf("could not read the budget's role: %w", err)
		}
		cr, err := b.IAM.CreateRole(ctx, &iam.CreateRoleInput{RoleName: aws.String(role), AssumeRolePolicyDocument: aws.String(assumeBudgets(b.Account)),
			Description: aws.String("ayis: lets AWS Budgets attach " + BlockPolicyName(b.Host) + " when the budget is spent")})
		if err != nil {
			return fmt.Errorf("could not make the budget's role: %w", err)
		}
		ro = &iam.GetRoleOutput{Role: cr.Role}
	}
	doc, _ := json.Marshal(actionRolePolicy(b.Account, b.Host))
	if _, err := b.IAM.PutRolePolicy(ctx, &iam.PutRolePolicyInput{RoleName: aws.String(role), PolicyName: aws.String("attach-the-block"), PolicyDocument: aws.String(string(doc))}); err != nil {
		return fmt.Errorf("could not give the budget's role its policy: %w", err)
	}
	roleARN := aws.ToString(ro.Role.Arn)

	var subs []budgetstypes.Subscriber
	for _, e := range emails {
		subs = append(subs, budgetstypes.Subscriber{SubscriptionType: budgetstypes.SubscriptionTypeEmail, Address: aws.String(e)})
	}
	threshold := &budgetstypes.ActionThreshold{ActionThresholdValue: 100, ActionThresholdType: budgetstypes.ThresholdTypePercentage}
	existing, err := b.action(ctx)
	if err != nil {
		return err
	}
	if existing != nil {
		_, err := b.Budgets.UpdateBudgetAction(ctx, &budgets.UpdateBudgetActionInput{AccountId: aws.String(b.Account), BudgetName: aws.String(BudgetName(b.Host)),
			ActionId: existing.ActionId, ActionThreshold: threshold, ApprovalModel: budgetstypes.ApprovalModelAuto, Definition: b.definition(p),
			ExecutionRoleArn: aws.String(roleARN), NotificationType: budgetstypes.NotificationTypeActual, Subscribers: subs})
		if err != nil {
			return fmt.Errorf("could not update the budget's block: %w", err)
		}
		b.say(fmt.Sprintf("    updated: at 100%% of the budget, %s %s cannot start a machine", p.Kind, p.Name))
		return nil
	}
	// A role just made is not assumable everywhere at once: AWS Budgets refuses it
	// for a few seconds, so try again before calling it a failure.
	for try := 0; ; try++ {
		_, err = b.Budgets.CreateBudgetAction(ctx, &budgets.CreateBudgetActionInput{AccountId: aws.String(b.Account), BudgetName: aws.String(BudgetName(b.Host)),
			ActionType: budgetstypes.ActionTypeIam, ActionThreshold: threshold, ApprovalModel: budgetstypes.ApprovalModelAuto,
			Definition: b.definition(p), ExecutionRoleArn: aws.String(roleARN), NotificationType: budgetstypes.NotificationTypeActual, Subscribers: subs})
		if err == nil || try >= 5 || !(strings.Contains(err.Error(), "role") || strings.Contains(err.Error(), "AccessDenied")) {
			break
		}
		if b.Sleep != nil {
			b.Sleep(5 * time.Second)
		}
	}
	if err != nil {
		return fmt.Errorf("could not put the block on the budget: %w", err)
	}
	b.say(fmt.Sprintf("    armed: at 100%% of the budget, %s %s cannot start a machine and the running one is switched off", p.Kind, p.Name))
	return nil
}

// Armed says whether the budget carries the block. AWS Budgets' API is free.
func (b Block) Armed(ctx context.Context) (bool, error) {
	a, err := b.action(ctx)
	return a != nil, err
}

// action is the block's action on the budget, or nil.
func (b Block) action(ctx context.Context) (*budgetstypes.Action, error) {
	o, err := b.Budgets.DescribeBudgetActionsForBudget(ctx, &budgets.DescribeBudgetActionsForBudgetInput{AccountId: aws.String(b.Account), BudgetName: aws.String(BudgetName(b.Host))})
	if err != nil {
		if strings.Contains(err.Error(), "NotFound") {
			return nil, nil
		}
		return nil, fmt.Errorf("could not read the budget's actions: %w", err)
	}
	pol := BlockPolicyARN(b.Account, b.Host)
	for _, a := range o.Actions {
		if a.Definition != nil && a.Definition.IamActionDefinition != nil && aws.ToString(a.Definition.IamActionDefinition.PolicyArn) == pol {
			a := a
			return &a, nil
		}
	}
	return nil, nil
}

// Unblock lifts a block the budget put on. AWS Budgets is told to reverse its
// action - so it does not put it straight back, it does not look again until
// next month - and anything still attached after that is detached directly.
func (b Block) Unblock(ctx context.Context) error {
	a, err := b.action(ctx)
	if err != nil {
		return err
	}
	if a != nil && a.Status == budgetstypes.ActionStatusExecutionSuccess {
		if _, err := b.Budgets.ExecuteBudgetAction(ctx, &budgets.ExecuteBudgetActionInput{AccountId: aws.String(b.Account), BudgetName: aws.String(BudgetName(b.Host)),
			ActionId: a.ActionId, ExecutionType: budgetstypes.ExecutionTypeReverseBudgetAction}); err != nil {
			return fmt.Errorf("AWS Budgets would not undo its block: %w", err)
		}
		b.say("    AWS Budgets is undoing its block; it does not check again until next month")
	}
	return b.detachAll(ctx)
}

func (b Block) detachAll(ctx context.Context) error {
	pol := aws.String(BlockPolicyARN(b.Account, b.Host))
	for try := 0; ; try++ {
		o, err := b.IAM.ListEntitiesForPolicy(ctx, &iam.ListEntitiesForPolicyInput{PolicyArn: pol})
		if err != nil {
			if strings.Contains(err.Error(), "NoSuchEntity") {
				return nil
			}
			return err
		}
		if len(o.PolicyUsers)+len(o.PolicyRoles) == 0 {
			return nil
		}
		// AWS Budgets' own reverse takes a moment; give it that before doing it here.
		if try < 3 && b.Sleep != nil {
			b.Sleep(3 * time.Second)
			continue
		}
		for _, u := range o.PolicyUsers {
			if _, err := b.IAM.DetachUserPolicy(ctx, &iam.DetachUserPolicyInput{UserName: u.UserName, PolicyArn: pol}); err != nil {
				return fmt.Errorf("could not detach the block from %s: %w", aws.ToString(u.UserName), err)
			}
		}
		for _, r := range o.PolicyRoles {
			if _, err := b.IAM.DetachRolePolicy(ctx, &iam.DetachRolePolicyInput{RoleName: r.RoleName, PolicyArn: pol}); err != nil {
				return fmt.Errorf("could not detach the block from %s: %w", aws.ToString(r.RoleName), err)
			}
		}
		return nil
	}
}

// Remove deletes the policy and the role - the budget's action goes with the
// budget. For `ayis destroy --all`: nothing of ayis's is left in IAM.
func (b Block) Remove(ctx context.Context) error {
	var fails []string
	if err := b.detachAll(ctx); err != nil {
		fails = append(fails, err.Error())
	}
	pol := aws.String(BlockPolicyARN(b.Account, b.Host))
	if _, err := b.IAM.DeletePolicy(ctx, &iam.DeletePolicyInput{PolicyArn: pol}); err != nil && !strings.Contains(err.Error(), "NoSuchEntity") {
		fails = append(fails, "the block policy: "+err.Error())
	}
	role := aws.String(ActionRoleName(b.Host))
	if _, err := b.IAM.DeleteRolePolicy(ctx, &iam.DeleteRolePolicyInput{RoleName: role, PolicyName: aws.String("attach-the-block")}); err != nil && !strings.Contains(err.Error(), "NoSuchEntity") {
		fails = append(fails, "the budget role's policy: "+err.Error())
	}
	if _, err := b.IAM.DeleteRole(ctx, &iam.DeleteRoleInput{RoleName: role}); err != nil && !strings.Contains(err.Error(), "NoSuchEntity") {
		fails = append(fails, "the budget role: "+err.Error())
	}
	if len(fails) > 0 {
		return fmt.Errorf("%s", strings.Join(fails, "; "))
	}
	return nil
}
