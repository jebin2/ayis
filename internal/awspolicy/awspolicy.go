// Package awspolicy is the least-privilege IAM policy for the key ayis runs as:
// every AWS action ayis calls, and nothing else. `ayis aws policy` prints it, to
// make an IAM user with only that. Operations is checked against the source by
// a test (every SDK call there must be listed, and nothing listed may be unused),
// so the policy cannot fall behind the code.
package awspolicy

import (
	"sort"
	"strings"
)

// Operations is every AWS API operation the CLI calls, as "<sdk package>:<Operation>".
// Kept in step with the code by TestOperationsAreExactlyWhatTheCodeCalls.
var Operations = []string{
	"account:EnableRegion",
	"account:GetRegionOptStatus",
	"account:ListRegions",
	"budgets:CreateBudget",
	"budgets:CreateBudgetAction",
	"budgets:CreateSubscriber",
	"budgets:DeleteBudget",
	"budgets:DeleteSubscriber",
	"budgets:DescribeBudget",
	"budgets:DescribeBudgetActionsForBudget",
	"budgets:DescribeNotificationsForBudget",
	"budgets:DescribeSubscribersForNotification",
	"budgets:ExecuteBudgetAction",
	"budgets:UpdateBudget",
	"budgets:UpdateBudgetAction",
	"cloudwatch:GetMetricStatistics",
	"cloudwatchlogs:CreateLogGroup",
	"cloudwatchlogs:DeleteLogGroup",
	"cloudwatchlogs:FilterLogEvents",
	"cloudwatchlogs:PutRetentionPolicy",
	"cloudwatchlogs:TagResource",
	"costexplorer:GetCostAndUsage",
	"ec2:AssociateIamInstanceProfile",
	"ec2:AttachVolume",
	"ec2:AuthorizeSecurityGroupIngress",
	"ec2:CancelSpotInstanceRequests",
	"ec2:CreateImage",
	"ec2:CreateKeyPair",
	"ec2:CreateSecurityGroup",
	"ec2:CreateTags",
	"ec2:CreateVolume",
	"ec2:DeleteKeyPair",
	"ec2:DeleteSecurityGroup",
	"ec2:DeleteSnapshot",
	"ec2:DeleteVolume",
	"ec2:DeregisterImage",
	"ec2:DescribeAddresses",
	"ec2:DescribeIamInstanceProfileAssociations",
	"ec2:DescribeImages",
	"ec2:DescribeInstanceAttribute",
	"ec2:DescribeInstanceTypeOfferings",
	"ec2:DescribeInstanceTypes",
	"ec2:DescribeInstances",
	"ec2:DescribeKeyPairs",
	"ec2:DescribeRegions",
	"ec2:DescribeSecurityGroups",
	"ec2:DescribeSnapshots",
	"ec2:DescribeSpotInstanceRequests",
	"ec2:DescribeSpotPriceHistory",
	"ec2:DescribeVolumes",
	"ec2:DescribeVolumesModifications",
	"ec2:DetachVolume",
	"ec2:GetConsoleOutput",
	"ec2:GetSpotPlacementScores",
	"ec2:ModifyInstanceAttribute",
	"ec2:ModifyVolume",
	"ec2:RunInstances",
	"ec2:StartInstances",
	"ec2:StopInstances",
	"ec2:TerminateInstances",
	"eventbridge:DeleteRule",
	"eventbridge:DescribeRule",
	"eventbridge:ListTargetsByRule",
	"eventbridge:PutRule",
	"eventbridge:PutTargets",
	"eventbridge:RemoveTargets",
	"freetier:GetAccountPlanState",
	"iam:AddRoleToInstanceProfile",
	"iam:CreateInstanceProfile",
	"iam:CreatePolicy",
	"iam:CreateRole",
	"iam:DeleteInstanceProfile",
	"iam:DeletePolicy",
	"iam:DeleteRole",
	"iam:DeleteRolePolicy",
	"iam:DetachRolePolicy",
	"iam:DetachUserPolicy",
	"iam:GetInstanceProfile",
	"iam:GetPolicy",
	"iam:GetRole",
	"iam:GetRolePolicy",
	"iam:ListEntitiesForPolicy",
	"iam:PutRolePolicy",
	"iam:RemoveRoleFromInstanceProfile",
	"iam:TagInstanceProfile",
	"iam:TagRole",
	"lambda:AddPermission",
	"lambda:CreateFunction",
	"lambda:DeleteFunction",
	"lambda:GetFunctionConfiguration",
	"lambda:GetPolicy",
	"lambda:Invoke",
	"lambda:RemovePermission",
	"lambda:TagResource",
	"lambda:UpdateFunctionCode",
	"lambda:UpdateFunctionConfiguration",
	"pricing:GetProducts",
	"s3:AbortMultipartUpload",
	"s3:CompleteMultipartUpload",
	"s3:CopyObject",
	"s3:CreateBucket",
	"s3:CreateMultipartUpload",
	"s3:DeleteBucket",
	"s3:DeleteObject",
	"s3:DeleteObjects",
	"s3:GetBucketLocation",
	"s3:GetObject",
	"s3:HeadBucket",
	"s3:HeadObject",
	"s3:ListBuckets",
	"s3:ListMultipartUploads",
	"s3:ListObjectsV2",
	"s3:PutBucketEncryption",
	"s3:PutBucketLifecycleConfiguration",
	"s3:PutBucketTagging",
	"s3:PutObject",
	"s3:PutPublicAccessBlock",
	"s3:UploadPartCopy",
	"servicequotas:GetServiceQuota",
	"servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota",
	"servicequotas:RequestServiceQuotaIncrease",
	"ssm:DeleteParameter",
	"ssm:DeleteParameters",
	"ssm:GetParameter",
	"ssm:GetParametersByPath",
	"ssm:PutParameter",
	"sts:GetCallerIdentity"}

// service is the IAM prefix of each SDK package, where they differ.
var service = map[string]string{"cloudwatchlogs": "logs", "eventbridge": "events", "costexplorer": "ce"}

// renamed are the operations whose IAM action has another name (or is covered
// by another one): S3 and AWS Budgets above all.
var renamed = map[string][]string{
	"s3:CompleteMultipartUpload":                 {"s3:PutObject"},
	"s3:CreateMultipartUpload":                   {"s3:PutObject"},
	"s3:UploadPartCopy":                          {"s3:PutObject", "s3:GetObject"},
	"s3:CopyObject":                              {"s3:PutObject", "s3:GetObject"},
	"s3:DeleteObjects":                           {"s3:DeleteObject"},
	"s3:HeadBucket":                              {"s3:ListBucket"},
	"s3:HeadObject":                              {"s3:GetObject"},
	"s3:ListBuckets":                             {"s3:ListAllMyBuckets"},
	"s3:ListMultipartUploads":                    {"s3:ListBucketMultipartUploads"},
	"s3:ListObjectsV2":                           {"s3:ListBucket"},
	"s3:PutBucketEncryption":                     {"s3:PutEncryptionConfiguration"},
	"s3:PutBucketLifecycleConfiguration":         {"s3:PutLifecycleConfiguration"},
	"s3:PutPublicAccessBlock":                    {"s3:PutBucketPublicAccessBlock"},
	"lambda:Invoke":                              {"lambda:InvokeFunction"},
	"budgets:CreateBudget":                       {"budgets:ModifyBudget"},
	"budgets:UpdateBudget":                       {"budgets:ModifyBudget"},
	"budgets:DeleteBudget":                       {"budgets:ModifyBudget"},
	"budgets:CreateSubscriber":                   {"budgets:ModifyBudget"},
	"budgets:DeleteSubscriber":                   {"budgets:ModifyBudget"},
	"budgets:DescribeBudget":                     {"budgets:ViewBudget"},
	"budgets:DescribeNotificationsForBudget":     {"budgets:ViewBudget"},
	"budgets:DescribeSubscribersForNotification": {"budgets:ViewBudget"},
}

// Extra are permissions no single call names but the calls need: handing a role
// to the machine, the watchdog and the budget's action; and the service-linked
// role EC2 makes for spot the first time it is used.
var Extra = map[string]string{
	"iam:PassRole":                "the machine's role (RunInstances), the watchdog's (CreateFunction) and the budget block's (CreateBudgetAction)",
	"iam:CreateServiceLinkedRole": "AWS makes its spot role the first time a spot machine is asked for",
}

// Actions is the IAM actions, sorted and without repeats.
func Actions() []string {
	set := map[string]bool{}
	for _, op := range Operations {
		if r, ok := renamed[op]; ok {
			for _, a := range r {
				set[a] = true
			}
			continue
		}
		pkg, name, _ := strings.Cut(op, ":")
		if s, ok := service[pkg]; ok {
			pkg = s
		}
		set[pkg+":"+name] = true
	}
	for a := range Extra {
		set[a] = true
	}
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// Document is the policy: the actions, on every resource. ayis names its own
// resources at run time (a host, a hashed bucket, a region you pick), so the
// policy is least privilege by action; the budget and the hard limits are what
// bound the cost.
func Document() map[string]any {
	return map[string]any{"Version": "2012-10-17", "Statement": []any{
		map[string]any{"Sid": "WhatAyisCalls", "Effect": "Allow", "Action": Actions(), "Resource": "*"},
	}}
}
