"""An ON-DEMAND BOX LEFT STOPPED is deleted after EXPIRY_DAYS - the days games
are kept for. Stopped, it bills for its disk with no end, and kept the archive
alive as "in use" for as long. Its games went to S3 when it stopped; deleted, the
archive's own countdown begins, so they are kept that long again. A day before,
it warns. When the stop is not timestamped by AWS, it counts from when it first
saw the box stopped - never from a guess."""
from datetime import datetime, timedelta
from typing import Any

from . import settings
from .aws import call, instances, tag
from .common import Inst, iso, parse_iso, say, span, tag_value, words
from .idle import transition_time
from .notify import notify


def stopped_since(ec2: Any, inst: Inst, now: datetime, dry: bool) -> datetime:
    """When it stopped: AWS's timestamp on a stop through the API, else the time
    this first saw it stopped, recorded on the box. A record older than its last
    start is from an earlier stop, and does not count."""
    t = transition_time(inst.get("StateTransitionReason"))
    if t is not None:
        return t
    v = tag_value(inst, settings.STOPPED_SINCE_TAG)
    try:
        t = parse_iso(v) if v else None
    except ValueError:
        t = None
    launched = inst.get("LaunchTime")
    if t is not None and (launched is None or t >= launched):
        return t
    if not dry:
        tag(ec2, inst["InstanceId"], settings.STOPPED_SINCE_TAG, iso(now))
    return now


def expire_stopped(ec2: Any, now: datetime, dry: bool = False) -> list[dict[str, str]] | None:
    """An on-demand box stopped for EXPIRY_DAYS is deleted. Hourly, as the archive
    check is; 0 days keeps it, as it keeps the archive."""
    days = settings.EXPIRY_DAYS
    if days <= 0:
        return None
    if not dry and now.minute >= 5:
        return None
    window, out = timedelta(days=days), []
    for inst in instances(ec2, ["stopped"]):
        iid = inst["InstanceId"]
        # A spot box is never left stopped - it is terminated - and a request's
        # own instance is not this check's to end.
        if inst.get("State", {}).get("Name") != "stopped" or inst.get("InstanceLifecycle") == "spot":
            continue
        since = stopped_since(ec2, inst, now, dry)
        stopped_for = now - since
        if stopped_for < window:
            left = window - stopped_for
            say("%s stopped %s ago - deleted in %s unless it is started" % (iid, span(stopped_for), span(left)))
            if not dry and left <= timedelta(hours=24) and tag_value(inst, settings.STOPPED_WARNED_TAG) != iso(since):
                notify("Game PC will be deleted tomorrow",
                       "It has been off for %s and still has a small storage charge. Start it before then "
                       "to keep it. Your games are saved either way." % words(stopped_for),
                       "high", "hourglass")
                tag(ec2, iid, settings.STOPPED_WARNED_TAG, iso(since))
            out.append({"instance": iid, "action": "kept", "left": span(left)})
            continue
        why = "stopped for %s, past the %d days games are kept" % (span(stopped_for), days)
        if dry:
            say("%s %s - WOULD DELETE it (dry run)" % (iid, why))
            out.append({"instance": iid, "action": "would-terminate"})
            continue
        call(ec2, "terminate", iid)
        say("%s %s - deleted; its disk no longer bills, and its games stay in S3 for %d days" % (iid, why, days))
        notify("Old game PC deleted",
               "It had been off for %s, so its storage charge has stopped. Your games are saved - "
               "the next game PC restores them." % words(stopped_for), "default", "wastebasket")
        out.append({"instance": iid, "action": "terminate"})
    return out
