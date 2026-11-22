"""The idle check: a running box nobody has used for IDLE_MINUTES is ended,
gracefully, and a box stuck going down for STUCK_MINUTES is forced."""
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from . import settings
from .aws import call, end_verb, instances, permission, tag
from .common import Inst, about, iso, mb, minutes, parse_iso, say, tag_value
from .notify import notify

Decision = dict[str, str]


def run(ec2: Any, cw: Any, now: datetime, dry: bool = False) -> dict[str, list[Decision]]:
    # "Could not ask" must never read as "nothing there": a blind watchdog that
    # reports all clear is worse than none. Raise, so the invocation counts as
    # an error and `ayis watchdog` shows it.
    try:
        found = instances(ec2, ["pending", "running", "stopping", "shutting-down"])
    except Exception as exc:
        say("CANNOT QUERY AWS - this watchdog is blind: %s" % exc)
        raise
    if not found:
        say("no running instance tagged %s - nothing to do" % settings.TS_HOST)
        return {"decisions": []}

    decisions, failed = [], []
    for inst in found:
        about(inst)
        iid = inst.get("InstanceId", "?")
        # One instance failing must not stop the others being handled.
        try:
            d = decide(ec2, cw, inst, now, dry)
            # A dry run proves the permission on EVERY running box, not only on
            # one it would end. Otherwise `ayis watchdog check` during a session -
            # a busy box, the one time anyone runs it - proves nothing about
            # whether this role can actually terminate the instance.
            if dry and d["action"] == "none" and inst["State"]["Name"] == "running":
                say("%s dry run: %s" % (iid, permission(ec2, end_verb(inst), iid)))
            decisions.append(d)
        except Exception as exc:
            say("%s FAILED: %s" % (iid, exc))
            decisions.append({"instance": iid, "action": "error", "reason": str(exc)})
            failed.append(iid)
    about(None)
    if failed:
        raise RuntimeError("could not handle %s" % ", ".join(failed))
    return {"decisions": decisions}


def decide(ec2: Any, cw: Any, inst: Inst, now: datetime, dry: bool) -> Decision:
    iid = inst["InstanceId"]
    state = inst["State"]["Name"]
    if state in ("stopping", "shutting-down"):
        return going_down(ec2, inst, now, dry)
    if state == "pending":
        say("%s pending - nothing to judge yet" % iid)
        return {"instance": iid, "action": "none", "reason": "pending"}

    age = minutes(now - inst["LaunchTime"])
    grace, window, threshold = settings.BOOT_GRACE_MINUTES, settings.IDLE_MINUTES, settings.THRESHOLD
    # A box that has just come up is still building, and a fresh instance has
    # no metrics yet, which would otherwise read as idle.
    if age < grace:
        say("%s up %dm - inside the %dm boot grace" % (iid, age, grace))
        return {"instance": iid, "action": "none", "reason": "boot grace"}

    points = traffic(cw, iid, now)
    peak = max(points.values()) if points else 0
    # in + out, because streaming is outbound and a game download is inbound,
    # and watching one direction ends the box in the middle of the other.
    if peak >= threshold:
        say("%s busy: %s in+out in a 5-minute period (>= %s) - leaving it" % (iid, mb(peak), mb(threshold)))
        return {"instance": iid, "action": "none", "reason": "busy"}

    # Quiet, but it has to have been judged for the whole window, not just the
    # minutes since the grace ended.
    watched = age - grace
    if watched < window:
        say("%s quiet (peak %s per 5 min), but watched for only %dm of the %dm needed"
            % (iid, mb(peak), watched, window))
        return {"instance": iid, "action": "none", "reason": "quiet, not long enough"}

    verb = end_verb(inst)
    if points:
        why = "quiet for %dm: peak %s per 5 min over %d periods, under %s" % (window, mb(peak), len(points), mb(threshold))
    else:
        # Running, past the grace, publishing nothing: the wedged case. Counted
        # as idle rather than as an absence of evidence.
        why = "running but publishing NO metrics for %dm (wedged?)" % window

    if dry:
        say("%s %s - WOULD %s (dry run; %s)" % (iid, why, verb, permission(ec2, verb, iid)))
        return {"instance": iid, "action": "would-" + verb, "reason": why}

    # Graceful: the OS shuts down, and the box pushes its games as it goes.
    call(ec2, verb, iid)
    say("%s %s - %s issued; the box mirrors its games to S3 as it shuts down" % (iid, why, verb))
    notify("Game PC switched off - nobody was playing" if verb == "stop"
           else "Game PC removed - nobody was playing",
           "It sat idle for %d minutes, so it is being shut down to stop the charge. "
           "Your games are being saved." % window, "low", "zzz")
    return {"instance": iid, "action": verb, "reason": why}


def traffic(cw: Any, iid: str, now: datetime) -> dict[datetime, float]:
    """Bytes in + out per 5-minute period over the idle window."""
    period = settings.PERIOD
    window_start = now - timedelta(minutes=settings.IDLE_MINUTES)
    totals: dict[datetime, float] = {}
    for metric in ("NetworkIn", "NetworkOut"):
        resp = cw.get_metric_statistics(
            Namespace="AWS/EC2", MetricName=metric,
            Dimensions=[{"Name": "InstanceId", "Value": iid}],
            StartTime=window_start - timedelta(seconds=period), EndTime=now,
            Period=period, Statistics=["Sum"])
        for p in resp.get("Datapoints", []):
            ts = p["Timestamp"]
            # A period that ENDED before the window began says nothing about it.
            if ts + timedelta(seconds=period) <= window_start:
                continue
            totals[ts] = totals.get(ts, 0) + p.get("Sum", 0)
    return totals


def going_down(ec2: Any, inst: Inst, now: datetime, dry: bool) -> Decision:
    """An instance already stopping or shutting down: leave it an hour, then force it."""
    iid, state = inst["InstanceId"], inst["State"]["Name"]
    stuck = settings.STUCK_MINUTES
    since = transition_time(inst.get("StateTransitionReason", "")) or tag_time(inst)
    if since is None:
        # An in-guest shutdown leaves no timestamp. Record when this was first
        # seen, so the next run can measure from it.
        if not dry:
            tag(ec2, iid, settings.SINCE_TAG, iso(now))
        say("%s %s - first seen going down; forced if still stuck in %dm" % (iid, state, stuck))
        return {"instance": iid, "action": "none", "reason": "going down, first seen"}

    took = minutes(now - since)
    mark = iso(since)
    if took < stuck:
        say("%s %s for %dm - letting it finish (the games are mirrored on the way down; forced at %dm)"
            % (iid, state, took, stuck))
        if not dry and took >= settings.SLOW_MINUTES and tag_value(inst, settings.SLOW_TAG) != mark and \
                notify("Game PC is slow to switch off",
                       "It is probably still saving your games. It will be forced off at %d minutes."
                       % stuck, "low", "hourglass"):
            tag(ec2, iid, settings.SLOW_TAG, mark)
        return {"instance": iid, "action": "none", "reason": "going down"}

    verb = "terminate" if state == "shutting-down" else "stop"
    why = "stuck %s for %dm" % (state, took)
    if dry:
        say("%s %s - WOULD force %s (dry run)" % (iid, why, verb))
        return {"instance": iid, "action": "would-force-" + verb, "reason": why}
    # Forced again on every run while it stays stuck - that is harmless - but told
    # once, then hourly: the tag holds when this shutdown began and when it was
    # first forced.
    forced = (tag_value(inst, settings.FORCED_TAG) or "").split("/")
    call(ec2, verb, iid, force=True)
    say("%s %s - FORCED %s, skipping the OS shutdown" % (iid, why, verb))
    if forced[0] != mark:
        if notify("Game PC was forced off",
                  "It got stuck switching off, so AWS was told to cut it. Games from the last session "
                  "may not be saved.", "high", "warning"):
            tag(ec2, iid, settings.FORCED_TAG, "%s/%s" % (mark, iso(now)))
    elif len(forced) > 1 and now.minute < 5 and forced[1] <= iso(now - timedelta(hours=1)):
        notify("Game PC will not switch off - it may still be charging",
               "Open the ayis app and delete it, or check your AWS account.", "urgent", "rotating_light")
    return {"instance": iid, "action": "force-" + verb, "reason": why}


def transition_time(reason: str | None) -> datetime | None:
    # "User initiated (2026-09-15 10:02:03 GMT)" - set by a stop or terminate
    # through the API.
    m = re.search(r"\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) GMT\)", reason or "")
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def tag_time(inst: Inst) -> datetime | None:
    for t in inst.get("Tags", []):
        if t.get("Key") != settings.SINCE_TAG:
            continue
        try:
            when = parse_iso(t["Value"])
        except (KeyError, ValueError):
            return None
        # From an EARLIER shutdown of an on-demand box that has since been
        # started again: measuring from it would force a fresh stop at once.
        launched = inst.get("LaunchTime")
        if launched is not None and when < launched:
            return None
        return when
    return None
