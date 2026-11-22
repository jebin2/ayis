"""The function's entry point: ayis_watchdog.handler.handler."""
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from . import settings
from .archive import expire_archive
from .aws import mark_put
from .common import about, iso, say
from .events import state_changed
from .idle import run
from .limits import limits
from .notify import notify
from .stopped import expire_stopped


def handler(event: Any, context: Any) -> dict[str, Any]:
    import boto3  # in the Lambda runtime; the tests pass fakes instead
    clients: dict[str, Any] = {}

    def s3_for(region: str) -> Any:
        # A bucket answers only in its own region's endpoint.
        if region not in clients:
            clients[region] = boto3.client("s3", region_name=region)
        return clients[region]
    now = datetime.now(timezone.utc)
    # EC2's own state-change events, from the second EventBridge rule. Nothing
    # else runs for these: they answer "is the box really gone", not "is it idle".
    if isinstance(event, dict) and event.get("detail-type") in (settings.STATE_EVENT, settings.SPOT_EVENT):
        return state_changed(boto3.client("ec2"), event, boto3.client("cloudwatch"), now,
                             boto3.client("ssm"), boto3.client("s3"))
    dry = isinstance(event, dict) and bool(event.get("dry_run"))
    return run_all(boto3.client("ec2"), boto3.client("cloudwatch"), boto3.client("s3"),
                   boto3.client("ssm"), boto3.client("cloudtrail"), now, dry, s3_for,
                   boto3.client("iam") if settings.BLOCK_POLICY_ARN else None,
                   boto3.client("budgets", region_name="us-east-1") if settings.limits_on() else None)


def run_all(ec2: Any, cw: Any, s3: Any, ssm: Any, trail: Any, now: datetime, dry: bool = False,
            s3_for: Callable[[str], Any] | None = None, iam: Any = None, budgets: Any = None) -> dict[str, Any]:
    """The hard limits, the idle check, the stopped box, then the archive. Each
    runs even when one before it fails, and the invocation still counts as an
    error afterwards."""
    failure: Exception | None = None
    try:
        lim = limits(ec2, ssm, iam, now, dry, budgets)
    except Exception as exc:
        say("limits: check FAILED: %s" % exc)
        failure, lim = exc, None
    result: dict[str, Any]
    about(None)   # a check that raised part way leaves no machine's run behind
    try:
        result = dict(run(ec2, cw, now, dry))
    except Exception as exc:
        failure, result = failure or exc, {"decisions": []}
    if lim is not None:
        result["limits"] = lim
    about(None)
    try:
        result["stopped"] = expire_stopped(ec2, now, dry)
    except Exception as exc:
        say("stopped box: check FAILED - nothing deleted: %s" % exc)
        failure = failure or exc
    about(None)
    try:
        result["archive"] = expire_archive(ec2, s3, ssm, cw, trail, now, dry, s3_for)
    except Exception as exc:
        say("archive: check FAILED - nothing deleted: %s" % exc)
        failure = failure or exc
    about(None)
    if failure:
        # At most hourly: a watchdog that is failing fails every 5 minutes.
        if not dry and now.minute < 5:
            notify("The cost-protection check is not working",
                   "The check that switches off idle game PCs failed. Open the ayis app to see why.",
                   "urgent", "rotating_light")
        raise failure
    if not dry:
        heartbeat(ssm, now)
    return result


def heartbeat(ssm: Any, now: datetime) -> None:
    """The dead-man signal: when the last run that finished without an error
    was. The app and `ayis watcher` warn when it is older than 15 minutes - a
    watchdog that stopped running, or fails every time, looks like one that is
    quiet otherwise. A write that fails is said and ignored: missing it is the
    warning."""
    try:
        mark_put(ssm, "watchdog/last-ok", iso(now))
    except Exception as exc:
        say("could not record this good run (the app will say the watchdog is late): %s" % exc)
