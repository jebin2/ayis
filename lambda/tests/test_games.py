"""One game at a time, wherever it is saved.

A region move left 162.8 GB of Diablo IV in a bucket nothing pointed at. With
the account known, the watchdog finds this host's buckets by the name ayis
derives - never just by the ayis-library- prefix - and expires each game on the
later of "a machine was last seen" and that game's Reset mark. Default: no box,
last seen 20 days ago, CloudTrail empty, the 14-day rule."""
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

import fakes
import pytest
from fakes import AwsError, calls

from ayis_watchdog import archive, settings

ACCT = "123456789012"


def name(*p):
    return "ayis-library-" + hashlib.sha256("-".join(p).encode()).hexdigest()[:12]


NOW_B, OLD_B, FOREIGN = name(ACCT, "ayis", "ap-south-1"), name(ACCT, "ayis"), name("999999999999", "ayis", "ap-south-2")
NOWB, OLDB, FOR = NOW_B[-4:], OLD_B[-4:], FOREIGN[-4:]
NOW = datetime(2026, 9, 15, 12, 0, 0, tzinfo=timezone.utc)
requests: list[str] = []


def ago(days=0, hours=0):
    return NOW - timedelta(days=days, hours=hours)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture(autouse=True)
def harness():
    settings.TS_HOST, settings.BUCKET, settings.EXPIRY_DAYS, settings.TRAIL_PAGES, settings.ACCOUNT = "ayis", NOW_B, 14, 3, ACCT
    requests.clear()


def game(appid, n, d=None):
    return {"appid": appid, "name": n, "installdir": d if d is not None else n, "bytes": 1}


def files(bucket_games, login=True):
    keys = {}
    for g in bucket_games:
        for k in ("steam/steamapps/common/%s/a.pak" % g["installdir"], "steam/steamapps/common/%s/b.pak" % g["installdir"],
                  "steam/steamapps/compatdata/%s/x" % g["appid"], "steam/steamapps/appmanifest_%s.acf" % g["appid"]):
            keys[k] = 1
    if login:
        keys["steam/account/local.vdf"] = 1
    keys["steam/index.json"] = json.dumps({"apps": bucket_games})
    return keys


class Body:
    def __init__(s, b):
        s.b = b

    def read(s):
        return s.b.encode() if isinstance(s.b, str) else s.b


class S3:
    def __init__(s, buckets, bad_index=()):
        s.b, s.bad_index = buckets, bad_index          # {name: (region, {key: value})}

    def list_buckets(s):
        requests.append("list-buckets")
        return {"Buckets": [{"Name": n} for n in s.b]}

    def get_bucket_location(s, Bucket):
        return {"LocationConstraint": s.b[Bucket][0]}

    def get_object(s, Bucket, Key):
        requests.append("get:" + Bucket[-4:])
        if Bucket in s.bad_index:
            return {"Body": Body("{not json")}
        if Key not in s.b[Bucket][1]:
            raise AwsError("NoSuchKey")
        return {"Body": Body(s.b[Bucket][1][Key])}

    def list_objects_v2(s, Bucket, MaxKeys=1000, Prefix=""):
        requests.append("list")
        ks = [k for k in s.b[Bucket][1] if k.startswith(Prefix)][:MaxKeys]
        return {"Contents": [{"Key": k} for k in ks]} if ks else {}

    def delete_objects(s, Bucket, Delete):
        for o in Delete["Objects"]:
            s.b[Bucket][1].pop(o["Key"], None)
        calls.append("del:%s:%d" % (Bucket[-4:], len(Delete["Objects"])))
        return {}

    def put_object(s, Bucket, Key, Body, ContentType):
        s.b[Bucket][1][Key] = Body.decode()
        calls.append("index:%s=%s" % (Bucket[-4:], ",".join(a["name"] for a in json.loads(Body)["apps"])))

    def list_multipart_uploads(s, Bucket):
        return {}

    def delete_bucket(s, Bucket):
        calls.append("delete-bucket:" + Bucket[-4:])
        del s.b[Bucket]


class SSM:
    def __init__(s, kept=None, last_seen=None, fails=False):
        s.p, s.fails = {}, fails
        if last_seen:
            s.p["/ayis/ayis/archive-last-seen"] = iso(last_seen)
        for (b, a), t in (kept or {}).items():
            s.p["/ayis/ayis/kept/%s/%s" % (b, a)] = t if isinstance(t, str) else iso(t)

    def get_parameter(s, Name):
        if Name not in s.p:
            raise AwsError("ParameterNotFound")
        return {"Parameter": {"Value": s.p[Name]}}

    def put_parameter(s, Name, Value, Type, Overwrite):
        s.p[Name] = Value
        calls.append("%s=%s" % (Name.rsplit("/", 1)[1].replace("archive-", ""), Value))

    def get_parameters_by_path(s, Path, Recursive):
        if s.fails:
            raise AwsError("AccessDeniedException")
        return {"Parameters": [{"Name": k, "Value": v} for k, v in s.p.items() if k.startswith(Path + "/")]}

    def delete_parameter(s, Name):
        del s.p[Name]
        calls.append("unmark:" + Name.rsplit("/", 1)[1])


class EC2:
    def describe_instances(s, Filters):
        return {"Reservations": []}


class CW:
    def __init__(s, gb=160.0):
        s.gb = gb

    def get_metric_statistics(s, Namespace=None, **kw):
        if s.gb is None:
            return {"Datapoints": []}
        return {"Datapoints": [{"Timestamp": NOW - timedelta(days=1), "Average": s.gb * 1073741824}]}


class Trail:
    def lookup_events(s, **kw):
        return {"Events": []}


RDR, D4, CP = game("1174180", "RDR2"), game("2344520", "Diablo IV"), game("1091500", "Cyberpunk")


def buckets():
    return S3({NOW_B: ("ap-south-1", files([RDR])), OLD_B: ("ap-south-2", files([D4])),
               FOREIGN: ("ap-south-2", files([CP])), "someone-elses": ("ap-south-1", {})})


class R(NamedTuple):
    res: str
    calls: str
    log: str
    s3: str
    left: str

    def __str__(self) -> str:
        return "%s | %s | %s | %s | %s" % self


def case(s3=None, ssm=None, cw=None, dry=False, now=NOW) -> R:
    s3, ssm, cw = s3 or buckets(), ssm or SSM(last_seen=ago(days=20)), cw or CW()
    res, log = fakes.capture(lambda: archive.expire_archive(EC2(), s3, ssm, cw, Trail(), now, dry, lambda r: s3))
    def names(keys):
        return ",".join(a["name"] for a in json.loads(keys.get("steam/index.json", '{"apps":[]}'))["apps"])
    left = ";".join("%s=%s" % (n[-4:], names(v[1])) for n, v in sorted(s3.b.items()) if n.startswith("ayis-"))
    return R(str(res), fakes.joined(), log, "s3:" + (",".join(requests) or "none"), "left:" + left)


def test_nothing_reset_every_game_of_this_host_goes_wherever_it_is_and_nothing_else():
    r = case()
    assert r.res == "deleted"
    assert "delete-bucket:" + NOWB in r.calls          # the bucket in use, emptied and removed
    assert "deleted=2026-09-15T12:00:00Z" in r.calls   # and remembered as deleted
    assert "delete-bucket:" + OLDB in r.calls          # the one an old region left, too
    assert "DELETED s3://" in str(r)                   # named in the log
    assert r.left == "left:%s=Cyberpunk" % FOR         # another account's look-alike is untouched


def test_a_game_reset_2_days_ago_stays_the_rest_go():
    r = case(ssm=SSM(last_seen=ago(days=20), kept={(OLD_B, "2344520"): ago(days=2)}))
    assert r.res == "deleted"
    assert "Diablo IV (kept until 2026-09-27T12:00:00Z)" in str(r)
    assert OLDB not in r.calls                         # its bucket is not touched
    assert r.left == "left:%s=Cyberpunk;%s=Diablo IV" % (FOR, OLDB)


def test_a_reset_older_than_the_rule_does_not_keep_it_and_its_mark_is_dropped():
    r = case(ssm=SSM(last_seen=ago(days=20), kept={(OLD_B, "2344520"): ago(days=15)}))
    assert "delete-bucket:" + OLDB in r.calls
    assert "unmark:2344520" in r.calls


def test_two_games_in_one_bucket_one_reset_only_the_other_goes():
    s3 = buckets()
    s3.b[OLD_B] = ("ap-south-2", files([D4, CP]))
    r = case(s3=s3, ssm=SSM(last_seen=ago(days=20), kept={(OLD_B, "2344520"): ago(days=1)}))
    assert "del:" + OLDB in r.calls                    # only Cyberpunk's files go
    assert "index:%s=Diablo IV" % OLDB in r.calls      # the index keeps Diablo IV
    assert "delete-bucket:" + OLDB not in r.calls      # the bucket stays
    assert "steam/account/local.vdf" in s3.b[OLD_B][1]  # and its login with it
    assert "DELETED Cyberpunk from s3://" in str(r)


KEEP = {(OLD_B, "2344520"): ago(days=1)}


def with_games(*games):
    s3 = buckets()
    s3.b[OLD_B] = ("ap-south-2", files(list(games)))
    return {"s3": s3, "ssm": SSM(last_seen=ago(days=20), kept=KEEP)}


def bad_index():
    s3 = buckets()
    s3.bad_index = (OLD_B,)
    return {"s3": s3}


# One game kept and one due, so the due one is removed by its folder - the only
# path where a bad folder name could take the whole bucket with it.
UNCERTAIN = {
    "reset marks unreadable": lambda: {"ssm": SSM(last_seen=ago(days=20), fails=True)},
    "index unreadable": bad_index,
    "empty install folder": lambda: with_games(D4, game("1091500", "Cyberpunk", "")),
    "climbing install folder": lambda: with_games(D4, game("1091500", "Cyberpunk", "..")),
}


@pytest.mark.parametrize("spec", UNCERTAIN)
def test_anything_uncertain_raises(spec):
    assert case(**UNCERTAIN[spec]()).res == "RAISED"


@pytest.mark.parametrize("spec", UNCERTAIN)
def test_anything_uncertain_leaves_the_old_regions_games(spec):
    assert OLDB not in case(**UNCERTAIN[spec]()).calls


def test_an_unreadable_reset_mark_raises():
    assert case(ssm=SSM(last_seen=ago(days=20), kept={(OLD_B, "2344520"): "not a time"})).res == "RAISED"


def test_a_dry_run_says_what_would_go_and_changes_nothing():
    r = case(dry=True, ssm=SSM(last_seen=ago(days=20), kept={(OLD_B, "2344520"): ago(days=2)}))
    assert (r.res, r.calls) == ("would-delete", "-")
    assert "WOULD DELETE RDR2 from s3://" in str(r)
    assert "Diablo IV (kept until" in str(r)


def test_inside_14_days_kept_with_no_s3_request():
    r = case(ssm=SSM(last_seen=ago(days=3)))
    assert (r.res, r.s3) == ("kept", "s3:none")


def test_the_one_bucket_measured_empty_does_not_hide_games_left_in_another_region():
    assert "delete-bucket:" + OLDB in case(cw=CW(gb=None)).calls


def test_with_no_other_bucket_of_ours_nothing_to_expire():
    s3 = buckets()
    del s3.b[OLD_B]
    del s3.b[NOW_B]
    assert case(s3=s3, cw=CW(gb=None)).res == "absent"
