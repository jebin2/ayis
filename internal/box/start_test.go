package box

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
)

type startEC2 struct {
	EC2
	tags map[string]string
}

func (s *startEC2) StartInstances(context.Context, *ec2.StartInstancesInput, ...func(*ec2.Options)) (*ec2.StartInstancesOutput, error) {
	return &ec2.StartInstancesOutput{}, nil
}

func (s *startEC2) CreateTags(_ context.Context, in *ec2.CreateTagsInput, _ ...func(*ec2.Options)) (*ec2.CreateTagsOutput, error) {
	for _, tg := range in.Tags {
		s.tags[aws.ToString(tg.Key)] = aws.ToString(tg.Value)
	}
	return &ec2.CreateTagsOutput{}, nil
}

func TestAStartTagsTheMachineWithItsRun(t *testing.T) {
	c := &startEC2{tags: map[string]string{}}
	if err := (Box{EC2: c, ID: "i-1", Run: "ab12cd34"}).Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.tags["ayis:run"] != "ab12cd34" {
		t.Errorf("%v", c.tags)
	}
	c.tags = map[string]string{}
	_ = (Box{EC2: c, ID: "i-1"}).Start(context.Background())
	if len(c.tags) != 0 {
		t.Error("no run, no tag")
	}
}
