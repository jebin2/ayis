package ec2find

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

type pages struct {
	asked []*ec2.DescribeInstancesInput
	fail  bool
}

func (p *pages) DescribeInstances(_ context.Context, in *ec2.DescribeInstancesInput, _ ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	cp := *in
	p.asked = append(p.asked, &cp)
	if p.fail {
		return nil, errors.New("AuthFailure")
	}
	if in.NextToken == nil {
		return &ec2.DescribeInstancesOutput{NextToken: aws.String("2"),
			Reservations: []ec2types.Reservation{{Instances: []ec2types.Instance{{InstanceId: aws.String("i-1")}}}}}, nil
	}
	return &ec2.DescribeInstancesOutput{
		Reservations: []ec2types.Reservation{{Instances: []ec2types.Instance{{InstanceId: aws.String("i-2")}, {InstanceId: aws.String("i-3")}}}}}, nil
}

func TestEveryPageByNameAndState(t *testing.T) {
	p := &pages{}
	got, err := Instances(context.Background(), p, "ayis", Kept)
	if err != nil || len(got) != 3 || aws.ToString(got[2].InstanceId) != "i-3" {
		t.Fatalf("got %v %v", got, err)
	}
	if len(p.asked) != 2 || aws.ToString(p.asked[1].NextToken) != "2" {
		t.Errorf("second page not asked: %+v", p.asked)
	}
	f := p.asked[0].Filters
	if aws.ToString(f[0].Name) != "tag:Name" || f[0].Values[0] != "ayis" ||
		aws.ToString(f[1].Name) != "instance-state-name" || len(f[1].Values) != 4 {
		t.Errorf("filters: %+v", f)
	}
}

func TestAnErrorIsNotAnEmptyAnswer(t *testing.T) {
	if got, err := Instances(context.Background(), &pages{fail: true}, "ayis", Up); err == nil || got != nil {
		t.Errorf("an unreachable EC2 read as no machine: %v %v", got, err)
	}
}
