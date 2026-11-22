"""HARD LIMITS. The idle guards end a machine nobody uses; these end one somebody
IS using, because cost has to have a ceiling that does not depend on anybody
remembering to stop: the month's hours, one session's length, and a spent AWS
budget. Each is off unless ayis set it (settings.MAX_HOURS_MONTH,
MAX_SESSION_HOURS, BLOCK_POLICY_ARN)."""
import json
from datetime import datetime, timedelta
from typing import Any

from . import settings
from .aws import call, end_verb, instances, mark_get, mark_put, tag
from .common import Inst, error_code, hours, iso, minutes, parse_iso, say, tag_value
from .notify import notify

# This month's machine time: {"done": seconds of runs that ended, "open":
# {"<instance>@<launch>": seconds so far}, "warned": bool}.
Usage = dict[str, Any]


def month_key(now: datetime) -> str:
    return now.strftime("%Y-%m")


def month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def read_usage(ssm: Any, now: datetime) -> Usage:
    """This month's machine time (Usage). Missing is a month with no use yet;
    unreadable is an error, never zero."""
    raw = mark_get(ssm, "usage/" + month_key(now))
    if raw is None:
        return {"done": 0, "open": {}, "warned": False}
    try:
        u = json.loads(raw)
        return {"done": float(u.get("done", 0)), "open": {k: float(v) for k, v in (u.get("open") or {}).items()},
                "warned": bool(u.get("warned", False))}
    except (TypeError, ValueError, AttributeError):
        raise RuntimeError("unreadable usage mark %r" % raw) from None


def extra_hours(ssm: Any, now: datetime) -> float:
    """Hours added to this month's cap by `ayis limits extend-month`."""
    raw = mark_get(ssm, "usage/" + month_key(now) + "-extra")
    try:
        return float(raw) if raw is not None else 0.0
    except ValueError:
        raise RuntimeError("unreadable extra-hours mark %r" % raw) from None


def count_usage(u: Usage, running: list[Inst], now: datetime) -> float:
    """Brings the record up to now. Every run recomputes each running machine's
    time from its LaunchTime, so a missed or repeated run cannot add or lose
    time; a run that has ended moves to "done" with the time last seen - at most
    one check (5 minutes) short. Returns the seconds used this month."""
    start = month_start(now)
    live = {}
    for inst in running:
        launched = inst["LaunchTime"]
        live["%s@%s" % (inst["InstanceId"], iso(launched))] = max(0.0, (now - max(launched, start)).total_seconds())
    for k, secs in list(u["open"].items()):
        if k not in live:
            u["done"] += secs
            del u["open"][k]
    u["open"].update(live)
    used: float = u["done"] + sum(u["open"].values())
    return used


def budget_spent(iam: Any) -> bool:
    """Whether the AWS budget's deny policy is attached to anything: AWS Budgets
    attaches it when the month's budget is used up."""
    if iam is None or not settings.BLOCK_POLICY_ARN:
        return False
    try:
        r = iam.list_entities_for_policy(PolicyArn=settings.BLOCK_POLICY_ARN)
    except Exception as exc:
        if error_code(exc) == "NoSuchEntity":
            return False
        raise
    return bool(r.get("PolicyUsers") or r.get("PolicyRoles") or r.get("PolicyGroups"))


def session_deadline(inst: Inst) -> datetime | None:
    """When this run of the machine must end: MAX_SESSION_HOURS after it started,
    or later when it was extended."""
    if not settings.MAX_SESSION_HOURS:
        return None
    deadline: datetime = inst["LaunchTime"] + timedelta(hours=settings.MAX_SESSION_HOURS)
    until = tag_value(inst, settings.SESSION_UNTIL_TAG)
    if until:
        try:
            deadline = max(deadline, parse_iso(until))
        except ValueError:
            say("%s: unreadable %s %r - ignored" % (inst["InstanceId"], settings.SESSION_UNTIL_TAG, until))
    return deadline


def hourly_usd(ec2: Any, inst: Inst) -> float | None:
    """What an hour of this machine costs now, in USD, or None when unknown."""
    if inst.get("InstanceLifecycle") != "spot":
        return settings.OD_USD_HOUR
    try:
        r = ec2.describe_spot_price_history(
            InstanceTypes=[inst["InstanceType"]], ProductDescriptions=["Linux/UNIX"],
            AvailabilityZone=inst["Placement"]["AvailabilityZone"], MaxResults=1)
        h = r.get("SpotPriceHistory") or []
        return float(h[0]["SpotPrice"]) if h else None
    except Exception as exc:
        say("limits: spot price unknown: %s" % exc)
        return None


def month_spend_usd(budgets: Any) -> tuple[float | None, float | None]:
    """This month's AWS bill and budget, in USD, as AWS Budgets has them - (spent,
    limit), either None when unknown. AWS updates the spend a few times a day."""
    if budgets is None or not settings.ACCOUNT:
        return None, None
    try:
        b = budgets.describe_budget(AccountId=settings.ACCOUNT, BudgetName=settings.TS_HOST + "-monthly")["Budget"]
        spent = float(b["CalculatedSpend"]["ActualSpend"]["Amount"])
        cap = float(b["BudgetLimit"]["Amount"]) if b.get("BudgetLimit") else None
        return spent, cap
    except Exception as exc:
        say("limits: the month's spend is unknown: %s" % exc)
        return None, None


def rupees(inr: float) -> str:
    return f"₹{inr:,.0f}"


def cost_words(ec2: Any, budgets: Any, inst: Inst | None, now: datetime) -> str:
    """What this session and this month have cost, for a person: "" when nothing
    is known. Never raises - a notification goes out with or without it."""
    fx = settings.INR_PER_USD
    if not fx:
        return ""
    out = []
    try:
        if inst is not None:
            rate = hourly_usd(ec2, inst)
            if rate is not None:
                h = max(0.0, (now - inst["LaunchTime"]).total_seconds() / 3600)
                out.append("This session: about %s so far (%.1f h at %s an hour)."
                           % (rupees(rate * h * fx), h, rupees(rate * fx)))
        spent, cap = month_spend_usd(budgets)
        if spent is not None:
            of = " of your %s budget" % rupees(cap * fx) if cap else ""
            out.append("This month: about %s%s (AWS updates this a few times a day)." % (rupees(spent * fx), of))
    except Exception as exc:
        say("limits: cost unknown: %s" % exc)
    return " ".join(out)


# What a person is told when a limit ends the machine.
ENDED = {
    "monthly": ("This month's play time is used up",
                "Your game PC is switching off and your games are being saved. Add hours in the ayis "
                "app (Safety) to play again this month."),
    "session": ("Session time limit reached",
                "Your game PC is switching off and your games are being saved. Press Play to start "
                "a new session."),
    "budget": ("Monthly budget used up",
               "AWS reports this month's budget as spent, so your game PC is switching off and new "
               "ones cannot start. Your games are being saved."),
}


def month_hours(ec2: Any, ssm: Any, budgets: Any, running: list[Inst], now: datetime, dry: bool) -> bool:
    """Counts the month, warns before its cap, and says whether the cap is
    reached with a machine running. Counted even with no machine running, so a
    run that has ended moves to "done"."""
    warn = settings.LIMIT_WARN_MINUTES * 60
    u = read_usage(ssm, now)
    used = count_usage(u, running, now)
    cap = (settings.MAX_HOURS_MONTH + extra_hours(ssm, now)) * 3600
    left = cap - used
    reached = False
    if running and left <= 0:
        reached = True
        say("limits: %s used of the %s monthly cap - ending the machine" % (hours(used), hours(cap)))
    elif running and left <= warn and not u["warned"]:
        if dry or notify("%d minutes of play left this month" % max(1, int(left // 60)),
                         ("Your game PC switches off when this month's %s are used. To keep playing, "
                          "add hours in the ayis app (Safety). %s"
                          % (hours(cap), cost_words(ec2, budgets, running[0], now))).strip(),
                         "high", "hourglass"):
            u["warned"] = True
    elif left > warn:
        u["warned"] = False
    if running:
        say("limits: %s used of %s this month" % (hours(used), hours(cap)))
    if not dry:
        mark_put(ssm, "usage/" + month_key(now), json.dumps(u, sort_keys=True))
    return reached


def session_ends(ec2: Any, budgets: Any, inst: Inst, now: datetime, dry: bool) -> bool:
    """Whether this machine's session is over; warns once before it is."""
    deadline = session_deadline(inst)
    if deadline is None:
        return False
    iid = inst["InstanceId"]
    if now >= deadline:
        say("%s has run since %s, past its session limit (%s) - ending it" % (iid, iso(inst["LaunchTime"]), iso(deadline)))
        return True
    left = deadline - now
    if left <= timedelta(minutes=settings.LIMIT_WARN_MINUTES) and not dry and \
            tag_value(inst, settings.SESSION_WARNED_TAG) != iso(deadline) and \
            notify("Game PC switches off in %d minutes" % max(1, minutes(left)),
                   ("This session reaches its time limit. To keep playing, extend it in the "
                    "ayis app (Safety). %s" % cost_words(ec2, budgets, inst, now)).strip(),
                   "high", "hourglass"):
        tag(ec2, iid, settings.SESSION_WARNED_TAG, iso(deadline))
    return False


def limits(ec2: Any, ssm: Any, iam: Any, now: datetime, dry: bool = False, budgets: Any = None) -> dict[str, Any] | None:
    """Ends a RUNNING machine at a hard limit, busy or not: the month's hours,
    the session's length, or a spent budget. Gracefully, like the idle stop -
    the games are saved on the way down. Warns once, LIMIT_WARN_MINUTES before."""
    if not settings.limits_on():
        return None
    try:
        running = instances(ec2, ["pending", "running"])
    except Exception as exc:
        say("limits: CANNOT QUERY AWS: %s" % exc)
        raise
    failure: Exception | None = None
    why_all = None

    if settings.MAX_HOURS_MONTH:
        try:
            if month_hours(ec2, ssm, budgets, running, now, dry):
                why_all = "monthly"
        except Exception as exc:
            say("limits: monthly hours could not be counted - not enforced this run: %s" % exc)
            failure = exc

    if running and why_all is None and settings.BLOCK_POLICY_ARN:
        try:
            if budget_spent(iam):
                why_all = "budget"
                say("limits: the AWS budget is spent (its block policy is attached) - ending the machine")
        except Exception as exc:
            say("limits: could not tell whether the budget is spent: %s" % exc)
            failure = failure or exc

    decisions = []
    for inst in running:
        iid = inst["InstanceId"]
        why = why_all
        if why is None and session_ends(ec2, budgets, inst, now, dry):
            why = "session"
        if why is None or inst["State"]["Name"] != "running":
            continue
        verb = end_verb(inst)
        if dry:
            say("%s WOULD %s - %s limit (dry run)" % (iid, verb, why))
            decisions.append({"instance": iid, "action": "would-" + verb, "reason": why})
            continue
        call(ec2, verb, iid)
        say("%s %s issued - %s limit; the box saves its games as it shuts down" % (iid, verb, why))
        title, body = ENDED[why]
        notify(title, (body + " " + cost_words(ec2, budgets, inst, now)).strip(), "high", "stop_sign")
        decisions.append({"instance": iid, "action": verb, "reason": why})
    if failure:
        raise failure
    return {"decisions": decisions}
