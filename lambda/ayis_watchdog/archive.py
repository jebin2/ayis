"""The GAME ARCHIVE expires. Once no box has existed for EXPIRY_DAYS, the saved
games - the only thing that bills while no box exists - are deleted. Deleting
the only copy of every game is not something to get wrong, so the check fails
closed: two independent records must both say "unused" - the last-seen mark, a
free SSM parameter refreshed while a box exists, and CloudTrail's RunInstances
history - and any error, gap or unreadable answer keeps it.

It costs nothing until it deletes: its marks are SSM parameters and whether an
archive exists is S3's free daily size metric, never an S3 request."""
import json
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from . import settings
from .aws import boxes, mark_get, mark_put, mark_time
from .common import error_code, iso, say, span, words
from .games import empty_and_delete, expire_games, label, own_buckets
from .notify import notify

# The archive's size as the metric last measured it: (bytes, day), or
# (None, None) when nothing was measured.
Size = tuple[float | None, datetime | None]
# What archive_look found: a Size, None when there is nothing to read it with,
# or the exception that stopped it being read.
Look = Size | Exception | None


def archive_size(cw: Any, now: datetime) -> Size:
    """(bytes, day measured) from S3's daily BucketSizeBytes metric, or (None, None)
    when nothing was measured in 3 days. Free to read, unlike any S3 request."""
    resp = cw.get_metric_statistics(
        Namespace="AWS/S3", MetricName="BucketSizeBytes",
        Dimensions=[{"Name": "BucketName", "Value": settings.BUCKET},
                    {"Name": "StorageType", "Value": "StandardStorage"}],
        StartTime=now - timedelta(days=3), EndTime=now, Period=86400, Statistics=["Average"])
    points = sorted(resp.get("Datapoints", []), key=lambda p: p["Timestamp"])
    if not points:
        return None, None
    return points[-1].get("Average", 0), points[-1]["Timestamp"]


def archive_look(cw: Any, now: datetime) -> Look:
    """The archive's size from the free metric, read once for both wordings of the
    "box is gone" notification."""
    if not settings.BUCKET or cw is None:
        return None
    try:
        return archive_size(cw, now)
    except Exception as exc:
        say("archive size could not be read: %s" % exc)
        return exc


def gb_shown(gb: float) -> str:
    return ("%.1f" if gb < 10 else "%.0f") % gb


def archive_note(look: Look, now: datetime) -> str:
    """What still bills in S3, for the log, from the free metric."""
    if look is None:
        return ""
    if isinstance(look, Exception):
        return " The S3 game archive's size could not be read."
    size, day = look
    if not size or day is None:
        return " No game archive is measured in S3, so nothing else bills."
    gb = size / 1073741824
    price, fx, days = settings.S3_USD_PER_GB, settings.INR_PER_USD, settings.EXPIRY_DAYS
    if price is None:
        note = " S3 still holds about %s GB of games (as of %s)." % (gb_shown(gb), day.strftime("%Y-%m-%d"))
    else:
        usd = gb * price
        note = (" S3 still holds about %s GB of games (as of %s): about $%.2f a month%s."
                % (gb_shown(gb), day.strftime("%Y-%m-%d"), usd, " (INR %.0f)" % (usd * fx) if fx else ""))
    if days > 0:
        note += " Deleted after %d days with no box, around %s." % (days, (now + timedelta(days=days)).strftime("%Y-%m-%d"))
    else:
        note += " Kept until you delete it: ayis destroy --all."
    return note


def archive_words(look: Look) -> str:
    """archive_note() for the phone: what the saved games cost, in rupees, and when
    they go. Nothing at all when the size cannot be read - a message that says
    less is better than one that guesses."""
    if look is None or isinstance(look, Exception):
        return ""
    size, _day = look
    if not size:
        return " No games are stored, so nothing else is charged."
    gb = size / 1073741824
    price, fx, days = settings.S3_USD_PER_GB, settings.INR_PER_USD, settings.EXPIRY_DAYS
    note = " Your saved games take up about %s GB" % gb_shown(gb)
    if price is not None and fx:
        note += ", about ₹%.0f a month" % (gb * price * fx)
    note += "."
    if days > 0:
        note += " They are deleted after %d days with no game PC." % days
    else:
        note += " They are kept until you delete them."
    return note


def mark_gone(ssm: Any, now: datetime) -> None:
    """The archive's countdown starts when the box really ended. Otherwise it starts at
    the last hourly check that happened to see it - up to an hour earlier. A write
    that fails is said and ignored: the hourly mark still stands."""
    if settings.EXPIRY_DAYS <= 0 or not settings.BUCKET or ssm is None:
        return
    try:
        mark_put(ssm, "archive-last-seen", iso(now))
    except Exception as exc:
        say("could not record when the box ended - the hourly mark stands: %s" % exc)


def warn_once(ssm: Any, seen: datetime, idle: timedelta, left: timedelta) -> None:
    """The 24-hour warning, once per countdown. It is recorded against the deletion
    time it warned of, so a new box (a new mark) or a changed GAME_ARCHIVE_EXPIRY_DAYS
    arms it again, and a send that failed is retried at the next hourly check.
    Recording the mark alone kept a warning sent under 1 day from ever being
    repeated after the days were raised to 14."""
    if not settings.NTFY_URL:
        return
    due = iso(seen + idle + left)
    if mark_get(ssm, "archive-warned") == due:
        return
    if notify("Saved games will be deleted in %s" % words(left),
              "There has been no game PC for %s. Start one to keep your games, or turn the deletion "
              "off in the ayis app's settings." % words(idle), "high", "warning"):
        mark_put(ssm, "archive-warned", due)


def last_launch(trail: Any, since: datetime, now: datetime) -> datetime | None:
    """When this host's box was last launched since `since`, or None. Raises when
    the history cannot be read in full - an unfinished lookup is not an empty one."""
    kwargs: dict[str, Any] = {"LookupAttributes": [{"AttributeKey": "EventName", "AttributeValue": "RunInstances"}],
                              "StartTime": since, "EndTime": now, "MaxResults": 50}
    for _ in range(settings.TRAIL_PAGES):
        resp = trail.lookup_events(**kwargs)
        for event in resp.get("Events", []):
            try:
                detail = json.loads(event["CloudTrailEvent"])
            except (KeyError, TypeError, ValueError):
                raise RuntimeError("unreadable CloudTrail event") from None
            if detail.get("errorCode"):
                continue                      # a launch that failed launched nothing
            specs = ((detail.get("requestParameters") or {}).get("tagSpecificationSet") or {}).get("items", [])
            for spec in specs:
                if spec.get("resourceType", "instance") != "instance":
                    continue
                if any(t.get("key") == "Name" and t.get("value") == settings.TS_HOST for t in spec.get("tags", [])):
                    when: datetime = event["EventTime"]
                    return when
        if not resp.get("NextToken"):
            return None
        kwargs["NextToken"] = resp["NextToken"]
    raise RuntimeError("CloudTrail launch history longer than %d pages" % settings.TRAIL_PAGES)


def expire_archive(ec2: Any, s3: Any, ssm: Any, cw: Any, trail: Any, now: datetime, dry: bool = False,
                   s3_for: Callable[[str], Any] | None = None) -> str | None:
    days, bucket = settings.EXPIRY_DAYS, settings.BUCKET
    if days <= 0 or not bucket:
        return None
    # Hourly: one invocation in twelve lands in the first 5 minutes of an hour.
    # A dry run always looks, so `ayis watchdog check` can show the countdown.
    if not dry and now.minute >= 5:
        return None
    window = timedelta(days=days)

    live = boxes(ec2)
    if live:
        if not dry:
            seen = mark_time(ssm, "archive-last-seen")
            if seen is None or now - seen >= timedelta(hours=1):
                mark_put(ssm, "archive-last-seen", iso(now))
        say("archive: kept - a box exists (%s)" % ", ".join(live))
        return "in-use"

    # Whether there is an archive at all, from S3's free daily size metric - not an
    # S3 request. A size measured on or before the last deletion is that archive.
    size, day = archive_size(cw, now)
    deleted = mark_time(ssm, "archive-deleted")
    if not size or (deleted is not None and day is not None and day <= deleted):
        # The metric is regional and covers one bucket; games this host left in
        # another region are only found by asking for its buckets. Asked only
        # here, where the answer would otherwise be "nothing to expire".
        others = [b for b, _ in own_buckets(s3)] if settings.ACCOUNT else []
        if not [b for b in others if b != bucket]:
            say("archive: none measured in s3://%s - nothing to expire" % bucket)
            return "absent"

    seen = mark_time(ssm, "archive-last-seen")
    if seen is None:
        if not dry:
            mark_put(ssm, "archive-last-seen", iso(now))
        say("archive: no last-seen mark yet - counting %d days from now" % days)
        return "started"
    if now - seen < window:
        left = window - (now - seen)
        say("archive: kept - last used %s ago; deleted in %s unless a box is launched" % (span(now - seen), span(left)))
        if not dry and left <= timedelta(hours=24):
            warn_once(ssm, seen, now - seen, left)
        return "kept"

    launched = last_launch(trail, now - window, now)
    if launched is not None:
        if not dry and launched > seen:
            mark_put(ssm, "archive-last-seen", iso(launched))
        say("archive: kept - a box was launched %s ago (CloudTrail)" % span(now - launched))
        return "kept"

    # Both records say unused. One last look, in case a box started meanwhile.
    if boxes(ec2):
        say("archive: kept - a box appeared during the check")
        return "in-use"
    if not settings.ACCOUNT:
        return delete_whole(s3, ssm, now, seen, dry)
    games, buckets = expire_games(s3, s3_for, ssm, now, seen, window, dry)
    if dry:
        return "would-delete" if games or buckets else "kept"
    if not games and not buckets:
        return "kept"
    names = ", ".join(label(a) for a in games) or "nothing but leftovers"
    notify("Saved games deleted",
           "Nothing used them for %s: %s. Steam downloads them again on the next game PC."
           % (words(now - seen), names), "high", "wastebasket")
    return "deleted"


def delete_whole(s3: Any, ssm: Any, now: datetime, seen: datetime, dry: bool) -> str:
    """The one bucket, whole: how this worked before games could be kept one by
    one, and still how it works when ayis did not say whose account this is."""
    bucket = settings.BUCKET
    if dry:
        say("archive: unused for %s - WOULD DELETE s3://%s (dry run)" % (span(now - seen), bucket))
        return "would-delete"
    # The only S3 requests this check ever makes are these, once, when it deletes.
    try:
        removed = empty_and_delete(s3)
    except Exception as exc:
        if error_code(exc) in ("NoSuchBucket", "404", "NotFound"):
            mark_put(ssm, "archive-deleted", iso(now))
            say("archive: s3://%s is already gone - nothing to expire" % bucket)
            return "absent"
        raise
    mark_put(ssm, "archive-deleted", iso(now))
    say("archive: unused for %s - DELETED s3://%s (%d objects)" % (span(now - seen), bucket, removed))
    notify("Saved games deleted",
           "Nothing used them for %s. The next game PC starts empty, and Steam downloads your "
           "games again." % words(now - seen), "high", "wastebasket")
    return "deleted"
