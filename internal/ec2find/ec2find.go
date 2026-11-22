// Package ec2find is the one way ayis finds a host's machines in EC2: by the
// Name tag ayis gives them, in a chosen set of states, every page of the answer.
// Six packages used to write this query themselves, each with its own list of
// states (docs/plans/production-readiness.md, P2).
//
// Finding is by Name; deciding what to DELETE is by the ayis:host tag
// (config.TagKey), never by a Name alone - that rule lives with the deleters.
package ec2find

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// The state sets ayis asks for.
var (
	// Up is a machine that is running or about to.
	Up = []string{"pending", "running"}
	// Kept is a machine that still exists and may run again: not being deleted.
	Kept = []string{"pending", "running", "stopping", "stopped"}
)

// EC2 is what finding uses.
type EC2 interface {
	DescribeInstances(context.Context, *ec2.DescribeInstancesInput, ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error)
}

// Filters is the query: the Name tag, and the states.
func Filters(name string, states []string) []ec2types.Filter {
	return []ec2types.Filter{
		{Name: aws.String("tag:Name"), Values: []string{name}},
		{Name: aws.String("instance-state-name"), Values: states},
	}
}

// Instances is every machine named name in one of states, across all pages.
func Instances(ctx context.Context, c EC2, name string, states []string) ([]ec2types.Instance, error) {
	in := &ec2.DescribeInstancesInput{Filters: Filters(name, states)}
	var out []ec2types.Instance
	for {
		o, err := c.DescribeInstances(ctx, in)
		if err != nil {
			return nil, err
		}
		for _, r := range o.Reservations {
			out = append(out, r.Instances...)
		}
		if o.NextToken == nil || *o.NextToken == "" {
			return out, nil
		}
		in.NextToken = o.NextToken
	}
}
