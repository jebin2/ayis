"""One game at a time, wherever it is saved.

The rule is the same for every game - N days after a machine was last seen -
but each game can be kept longer from the app ("Reset"), which writes
/ayis/<host>/kept/<bucket>/<appid>. A game goes when the later of the two is N
days old. Nothing here decides whether the games are in use; that is
archive.expire_archive's job, and it only calls this once both records say
unused."""
import hashlib
import json
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from . import settings
from .aws import mark_name, mark_put
from .common import error_code, iso, parse_iso, say, span

KEPT_PATH = "kept"
App = dict[str, Any]


def empty_and_delete(s3: Any, bucket: str | None = None) -> int:
    bucket = bucket or settings.BUCKET
    rounds, removed = settings.DELETE_ROUNDS, 0
    for _ in range(rounds):
        page = s3.list_objects_v2(Bucket=bucket, MaxKeys=1000)
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if not keys:
            break
        out = s3.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True})
        if out.get("Errors"):
            raise RuntimeError("S3 refused to delete %d objects" % len(out["Errors"]))
        removed += len(keys)
    else:
        raise RuntimeError("bucket still not empty after %d rounds" % rounds)
    # Incomplete multipart uploads appear in no listing and block the delete.
    for _ in range(rounds):
        uploads = s3.list_multipart_uploads(Bucket=bucket).get("Uploads", [])
        if not uploads:
            break
        for up in uploads:
            s3.abort_multipart_upload(Bucket=bucket, Key=up["Key"], UploadId=up["UploadId"])
    s3.delete_bucket(Bucket=bucket)
    return removed


def bucket_name(*parts: str) -> str:
    """The name ayis gives this host's bucket (internal/library), and the name it
    used before the region went into the hash. Both are this host's; nothing else is."""
    return "ayis-library-" + hashlib.sha256("-".join(parts).encode()).hexdigest()[:12]


def own_buckets(s3: Any) -> list[tuple[str, str | None]]:
    """[(name, region)] for every bucket this host owns. A bucket is ours when its
    name is the one ayis derives for this account, host and ITS region - or the old
    form without a region - never merely because it starts with ayis-library-."""
    account, host, bucket = settings.ACCOUNT, settings.TS_HOST, settings.BUCKET
    if not account:
        return [(bucket, None)] if bucket else []
    legacy = bucket_name(account, host)
    out: list[tuple[str, str | None]] = []
    for b in s3.list_buckets().get("Buckets", []):
        name = b.get("Name", "")
        if not name.startswith("ayis-library-"):
            continue
        loc = s3.get_bucket_location(Bucket=name).get("LocationConstraint") or "us-east-1"
        if name in (bucket, legacy, bucket_name(account, host, loc)):
            out.append((name, loc))
    return out


def kept_marks(ssm: Any) -> dict[tuple[str, str], datetime]:
    """{(bucket, appid): time} from the Reset marks. Unreadable is not "none": raise."""
    out: dict[tuple[str, str], datetime] = {}
    kwargs: dict[str, Any] = {"Path": mark_name(KEPT_PATH), "Recursive": True}
    for _ in range(settings.TRAIL_PAGES):
        resp = ssm.get_parameters_by_path(**kwargs)
        for p in resp.get("Parameters", []):
            parts = p["Name"].rsplit("/", 2)
            try:
                when = parse_iso(p["Value"])
            except (TypeError, ValueError):
                raise RuntimeError("unreadable kept mark %r" % p["Name"]) from None
            out[(parts[-2], parts[-1])] = when
        if not resp.get("NextToken"):
            return out
        kwargs["NextToken"] = resp["NextToken"]
    raise RuntimeError("too many kept marks")


def read_index(c: Any, bucket: str) -> list[App]:
    """The games a bucket holds, from its index. No index is no games; an index
    that cannot be read is an error, never an empty list."""
    try:
        body = c.get_object(Bucket=bucket, Key="steam/index.json")["Body"].read()
    except Exception as exc:
        if error_code(exc) in ("NoSuchKey", "404", "NotFound"):
            return []
        raise
    apps = json.loads(body).get("apps", [])
    if not isinstance(apps, list):
        raise RuntimeError("unreadable index in s3://%s" % bucket)
    return apps


def game_dir(app: App) -> str:
    d = str(app.get("installdir") or "")
    # The folder is deleted recursively: an empty or climbing name would take
    # every game in the bucket with it.
    if not d or "/" in d or d in (".", ".."):
        raise RuntimeError("refusing to delete a game with install folder %r" % d)
    return d


def delete_game(c: Any, bucket: str, app: App) -> int:
    """What the library's forget removes: the game's three folders and its two files."""
    appid = str(app.get("appid"))
    if not appid.isdigit():
        raise RuntimeError("refusing to delete a game with appid %r" % appid)
    rounds, removed = settings.DELETE_ROUNDS, 0
    for prefix in ("steam/steamapps/common/%s/" % game_dir(app),
                   "steam/steamapps/compatdata/%s/" % appid,
                   "steam/steamapps/shadercache/%s/" % appid):
        for _ in range(rounds):
            page = c.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if not keys:
                break
            out = c.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True})
            if out.get("Errors"):
                raise RuntimeError("S3 refused to delete %d objects" % len(out["Errors"]))
            removed += len(keys)
        else:
            raise RuntimeError("%s still not empty after %d rounds" % (prefix, rounds))
    c.delete_objects(Bucket=bucket, Delete={"Quiet": True, "Objects": [
        {"Key": "steam/steamapps/appmanifest_%s.acf" % appid},
        {"Key": "steam/meta/symlinks-%s.tsv" % appid}]})
    return removed


def label(app: App) -> str:
    return str(app.get("name") or app.get("appid"))


def expire_games(s3: Any, s3_for: Callable[[str], Any] | None, ssm: Any, now: datetime, seen: datetime,
                 window: timedelta, dry: bool) -> tuple[list[App], list[str]]:
    """Each game past its own deadline goes; the rest stay. A bucket left with no
    games goes whole - its Steam login with it - which is what happened to the
    one bucket before games could be kept one by one."""
    kept = kept_marks(ssm)
    deleted_games: list[App] = []
    deleted_buckets: list[str] = []
    keeping: list[str] = []
    gone: set[tuple[str, str]] = set()

    def last_use(bucket: str, a: App) -> datetime:
        return max(seen, kept.get((bucket, str(a.get("appid"))), seen))

    for bucket, region in own_buckets(s3):
        c = s3_for(region) if (s3_for and region) else s3
        apps = read_index(c, bucket)
        due = [a for a in apps if now - last_use(bucket, a) >= window]
        stay = [a for a in apps if a not in due]
        keeping += ["%s (kept until %s)" % (label(a), iso(last_use(bucket, a) + window)) for a in stay]
        if dry:
            for a in due:
                say("archive: unused for %s - WOULD DELETE %s from s3://%s (dry run)" % (span(now - seen), label(a), bucket))
            if not stay:
                say("archive: WOULD DELETE s3://%s (dry run)" % bucket)
            deleted_games += due
            continue
        if not stay:
            removed = empty_and_delete(c, bucket)
            deleted_buckets.append(bucket)
            deleted_games += due
            gone.update((bucket, str(a.get("appid"))) for a in apps)
            say("archive: unused for %s - DELETED s3://%s (%d objects)" % (span(now - seen), bucket, removed))
            if bucket == settings.BUCKET:
                mark_put(ssm, "archive-deleted", iso(now))
            continue
        for a in due:
            n = delete_game(c, bucket, a)
            deleted_games.append(a)
            gone.add((bucket, str(a.get("appid"))))
            say("archive: unused for %s - DELETED %s from s3://%s (%d objects)" % (span(now - seen), label(a), bucket, n))
        if due:
            c.put_object(Bucket=bucket, Key="steam/index.json", ContentType="application/json",
                         Body=json.dumps({"apps": stay}, indent=1).encode())
    # A mark for a game that is gone would keep nothing; drop it so the next
    # copy of that game starts on the ordinary rule.
    for (bucket, appid) in list(kept):
        if (bucket, appid) in gone or bucket in deleted_buckets:
            try:
                ssm.delete_parameter(Name=mark_name("%s/%s/%s" % (KEPT_PATH, bucket, appid)))
            except Exception as exc:
                say("could not drop the kept mark for %s (ignored): %s" % (appid, exc))
    if keeping:
        say("archive: kept - %s" % ", ".join(keeping))
    return deleted_games, deleted_buckets
