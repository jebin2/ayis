"""Small things every check uses: the log line, AWS error codes, and how times
and sizes are written."""
from datetime import datetime, timedelta, timezone
from typing import Any

# An EC2 instance as describe_instances returns it.
Inst = dict[str, Any]

TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def say(msg: str) -> None:
    print("ayis-watchdog: " + msg, flush=True)


def error_code(exc: BaseException) -> str:
    code: str = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    return code


def iso(t: datetime) -> str:
    return t.strftime(TIME_FORMAT)


def parse_iso(value: str) -> datetime:
    """The reverse of iso(); ValueError when it is not one."""
    return datetime.strptime(value, TIME_FORMAT).replace(tzinfo=timezone.utc)


def mb(n: float) -> str:
    return "%.1f MB" % (n / 1048576)


def minutes(delta: timedelta) -> int:
    return int(delta.total_seconds() // 60)


def hours(secs: float) -> str:
    return "%.1fh" % (secs / 3600.0)


def span(delta: timedelta) -> str:
    h = max(0, int(delta.total_seconds() // 3600))
    if h < 24:
        return "%dh" % h
    return "%dd" % (h // 24) if h % 24 == 0 else "%dd %dh" % (h // 24, h % 24)


def words(delta: timedelta) -> str:
    """span() for a person: "3 days", "21 hours"."""
    h = max(0, int(delta.total_seconds() // 3600))
    if h < 24:
        return "%d hour%s" % (h, "" if h == 1 else "s")
    days = h // 24
    return "%d day%s" % (days, "" if days == 1 else "s")


def tag_value(inst: Inst, key: str) -> str | None:
    return next((t.get("Value") for t in inst.get("Tags", []) if t.get("Key") == key), None)
