"""The EC2 and SSM calls more than one check makes: finding this host's
instances, ending one, and the SSM parameters the checks keep their marks in -
standard parameters, which cost nothing, under /ayis/<host>/."""
from datetime import datetime
from typing import Any

from . import settings
from .common import Inst, error_code, parse_iso


def instances(ec2: Any, states: list[str]) -> list[Inst]:
    """This host's instances in those states."""
    resp = ec2.describe_instances(Filters=[
        {"Name": "tag:Name", "Values": [settings.TS_HOST]},
        {"Name": "instance-state-name", "Values": states}])
    return [i for r in resp.get("Reservations", []) for i in r.get("Instances", [])]


def boxes(ec2: Any) -> list[str]:
    """Every instance of this host that still exists, stopped ones included."""
    return [i["InstanceId"] for i in instances(ec2, ["pending", "running", "shutting-down", "stopping", "stopped"])]


def end_verb(inst: Inst) -> str:
    """How a box is ended: a spot box is terminated, an on-demand one stopped."""
    return "terminate" if inst.get("InstanceLifecycle") == "spot" else "stop"


def call(ec2: Any, verb: str, iid: str, force: bool = False) -> None:
    if not force:
        if verb == "terminate":
            ec2.terminate_instances(InstanceIds=[iid])
        else:
            ec2.stop_instances(InstanceIds=[iid])
        return
    # SkipOsShutdown is recent. A runtime whose boto3 predates it rejects the
    # parameter before anything is sent - fall back to what that boto3 has:
    # Force for a stop, and a plain repeat for a terminate.
    try:
        if verb == "terminate":
            ec2.terminate_instances(InstanceIds=[iid], SkipOsShutdown=True)
        else:
            ec2.stop_instances(InstanceIds=[iid], Force=True, SkipOsShutdown=True)
    except Exception as exc:
        if "SkipOsShutdown" not in str(exc):
            raise
        if verb == "terminate":
            ec2.terminate_instances(InstanceIds=[iid])
        else:
            ec2.stop_instances(InstanceIds=[iid], Force=True)


def permission(ec2: Any, verb: str, iid: str) -> str:
    """Proves the role may act on this instance, without acting."""
    try:
        call_dry = ec2.terminate_instances if verb == "terminate" else ec2.stop_instances
        call_dry(InstanceIds=[iid], DryRun=True)
    except Exception as exc:
        code = error_code(exc)
        if code == "DryRunOperation":
            return "permission to %s: ok" % verb
        if code == "UnauthorizedOperation":
            return "permission to %s: DENIED - the role policy is wrong" % verb
        return "permission to %s: unknown (%s)" % (verb, exc)
    return "permission to %s: unknown (no dry-run response)" % verb


def tag(ec2: Any, iid: str, key: str, value: str) -> None:
    ec2.create_tags(Resources=[iid], Tags=[{"Key": key, "Value": value}])


def mark_name(name: str) -> str:
    return "/ayis/%s/%s" % (settings.TS_HOST, name)


def mark_get(ssm: Any, name: str) -> str | None:
    try:
        value: str = ssm.get_parameter(Name=mark_name(name))["Parameter"]["Value"]
        return value
    except Exception as exc:
        if error_code(exc) == "ParameterNotFound":
            return None
        raise


def mark_put(ssm: Any, name: str, value: str) -> None:
    ssm.put_parameter(Name=mark_name(name), Value=value, Type="String", Overwrite=True)


def mark_time(ssm: Any, name: str) -> datetime | None:
    """A stored time, or None when there is none. Unreadable is not "never": refuse."""
    value = mark_get(ssm, name)
    if value is None:
        return None
    try:
        return parse_iso(value)
    except (TypeError, ValueError):
        raise RuntimeError("unreadable %s mark %r" % (name, value)) from None
