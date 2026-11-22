# 0008. Two watchdogs, and no CloudWatch alarm

- **Status:** Accepted
- **Date:** 2026-09-15

## Context

Three guards watched for an idle box: the on-host watchdog, the cloud watchdog (a Lambda) and a CloudWatch alarm. The alarm could not take an EC2 action on `NetworkIn + NetworkOut`, so it watched outbound traffic only, read a game download as idle, and had to be armed only during a session - where it duplicated the Lambda.

## Decision

Remove the alarm. Keep the on-host watchdog (fast; dies with the box) and the cloud watchdog (survives a wedged box), plus the AWS budget.

## Consequences

One fewer moving part and no false "idle" during downloads. Do not re-add an alarm unless the Lambda approach itself proves unreliable. See [Flow 4](../architecture.md#flow-4---you-forget-the-box).
