"""Archive expiry. It deletes the only copy of every game, so every branch that
keeps the archive has a case, and every uncertainty must keep it too. It must
also cost nothing until it deletes: its marks are SSM parameters and whether an
archive exists is S3's daily CloudWatch metric - the S3 fake records every
billed request made to it.

Default scenario: no box, 160 GB measured yesterday, a last-seen mark 20 days
old, nothing in CloudTrail, 2,500 objects and one abandoned upload - the one
that DOES delete."""
import json
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

import fakes
import pytest
from fakes import AwsError, calls

from ayis_watchdog import archive, handler, settings

NOW = datetime(2026, 9, 15, 12, 0, 0, tzinfo=timezone.utc)
s3_requests: list[str] = []


def ago(days=0, hours=0, minutes=0):
    return NOW - timedelta(days=days, hours=hours, minutes=minutes)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture(autouse=True)
def harness():
    settings.TS_HOST, settings.BUCKET, settings.EXPIRY_DAYS, settings.TRAIL_PAGES = "ayis", "ayis-library-test", 14, 3
    s3_requests.clear()


class EC2:
    def __init__(s, *batches, fail_idle=False):
        s.batches, s.fail_idle = list(batches) or [[]], fail_idle

    def describe_instances(s, Filters):
        states = next(f for f in Filters if f["Name"] == "instance-state-name")["Values"]
        if "stopped" not in states:        # the idle check's query
            if s.fail_idle:
                raise AwsError("AuthFailure")
            return {"Reservations": []}
        b = s.batches.pop(0) if len(s.batches) > 1 else s.batches[0]
        return {"Reservations": [{"Instances": [{"InstanceId": i, "State": {"Name": st}} for i, st in b]}]}


class CWStub:
    def __init__(s, gb=160.0, measured_days_ago=1, fails=False):
        s.gb, s.days, s.fails = gb, measured_days_ago, fails

    def get_metric_statistics(s, Namespace=None, MetricName=None, **kw):
        if Namespace != "AWS/S3":
            return {"Datapoints": []}
        if s.fails:
            raise AwsError("Throttling")
        if s.gb is None:
            return {"Datapoints": []}
        day = (NOW - timedelta(days=s.days)).replace(hour=0, minute=0, second=0)
        return {"Datapoints": [{"Timestamp": day, "Average": s.gb * 1073741824}]}


class SSM:
    def __init__(s, **marks):
        s.p, s.fails = {}, False
        for k, v in marks.items():
            s.p["/ayis/ayis/archive-" + k.replace("_", "-")] = v if isinstance(v, str) else iso(v)

    def get_parameter(s, Name):
        if s.fails:
            raise AwsError("AccessDeniedException")
        if Name not in s.p:
            raise AwsError("ParameterNotFound")
        return {"Parameter": {"Value": s.p[Name]}}

    def put_parameter(s, Name, Value, Type, Overwrite):
        s.p[Name] = Value
        calls.append("%s=%s" % (Name.rsplit("/", 1)[1].replace("archive-", ""), Value))


class S3:
    def __init__(s, objects=0, uploads=0, delete_errors=False, gone=False):
        s.objects, s.uploads, s.delete_errors, s.gone = objects, uploads, delete_errors, gone

    def __getattr__(s, name):          # any S3 call not modelled here is still a request
        def call(**kw):
            s3_requests.append(name)
            return {}
        return call

    def list_objects_v2(s, Bucket, MaxKeys=1000):
        s3_requests.append("list")
        if s.gone:
            raise AwsError("NoSuchBucket")
        n = min(MaxKeys, s.objects)
        return {"Contents": [{"Key": "k%d" % i} for i in range(n)]} if n else {}

    def delete_objects(s, Bucket, Delete):          # DELETE requests are free
        if s.delete_errors:
            return {"Errors": [{"Key": "k0"}]}
        n = len(Delete["Objects"])
        s.objects -= n
        calls.append("delete-objects:%d" % n)
        return {}

    def list_multipart_uploads(s, Bucket):
        s3_requests.append("list-uploads")
        return {"Uploads": [{"Key": "u", "UploadId": "x"}]} if s.uploads else {}

    def abort_multipart_upload(s, **kw):
        s.uploads -= 1
        calls.append("abort")

    def delete_bucket(s, Bucket):
        calls.append("delete-bucket")


class Trail:
    def __init__(s, events=(), fails=False, pages=1, junk=False):
        s.events, s.fails, s.pages, s.junk, s.served = list(events), fails, pages, junk, 0

    def lookup_events(s, **kw):
        calls.append("lookup")
        if s.fails:
            raise AwsError("ThrottlingException")
        s.served += 1
        evs = []
        if s.served == 1:
            for name, days, err in s.events:
                d: dict[str, Any] = {"eventName": "RunInstances", "requestParameters": {"tagSpecificationSet": {"items": [
                    {"resourceType": "instance", "tags": [{"key": "Name", "value": name}]}]}}}
                if err:
                    d["errorCode"] = err
                evs.append({"EventTime": ago(days=days), "CloudTrailEvent": "{not json" if s.junk else json.dumps(d)})
        out: dict[str, Any] = {"Events": evs}
        if s.served < s.pages:
            out["NextToken"] = "t%d" % s.served
        return out


class R(NamedTuple):
    res: str
    calls: str
    log: str
    s3: str

    def __str__(self) -> str:
        return "%s | %s | %s | %s" % self


def case(ec2=None, cw=None, ssm=None, s3=None, trail=None, dry=False, now=NOW, mode="archive") -> R:
    ec2 = ec2 or EC2([])
    cw = cw or CWStub()
    ssm = ssm or SSM(last_seen=ago(days=20))
    s3 = s3 or S3(objects=2500, uploads=1)
    trail = trail or Trail()
    if mode == "archive":
        res, log = fakes.capture(lambda: archive.expire_archive(ec2, s3, ssm, cw, trail, now, dry))
    else:
        res, log = fakes.capture(lambda: handler.run_all(ec2, cw, s3, ssm, trail, now, dry))
    return R(str(res), fakes.joined(), log, "s3:" + (",".join(s3_requests) or "none"))


def test_expiry_off_nothing_is_looked_at():
    settings.EXPIRY_DAYS = 0
    r = case()
    assert (r.res, r.calls, r.s3) == ("None", "-", "s3:none")


def test_hourly_outside_the_first_5_minutes_a_real_run_does_nothing():
    r = case(now=NOW + timedelta(minutes=17))
    assert (r.res, r.calls, r.s3) == ("None", "-", "s3:none")


def test_a_box_exists_kept_and_its_last_seen_mark_refreshed_in_ssm():
    r = case(ec2=EC2([("i-a", "running")]))
    assert (r.res, r.calls) == ("in-use", "last-seen=2026-09-15T12:00:00Z")
    assert "archive: kept - a box exists (i-a)" in str(r)


def test_a_mark_under_an_hour_old_is_not_rewritten():
    assert case(ec2=EC2([("i-a", "running")]), ssm=SSM(last_seen=ago(minutes=30))).calls == "-"


def test_a_stopped_box_keeps_it_too():
    assert case(ec2=EC2([("i-a", "stopped")])).res == "in-use"


def test_no_size_measured_absent_nothing_deleted():
    r = case(cw=CWStub(gb=None))
    assert (r.res, r.calls) == ("absent", "-")


def test_an_empty_bucket_is_no_archive():
    assert case(cw=CWStub(gb=0)).res == "absent"


def test_a_size_measured_before_the_last_deletion_is_the_deleted_archive():
    r = case(ssm=SSM(last_seen=ago(days=20), deleted=ago(hours=5)))
    assert (r.res, r.calls) == ("absent", "-")


def test_a_deletion_long_ago_does_not_hide_a_new_archive():
    assert case(ssm=SSM(last_seen=ago(days=20), deleted=ago(days=30))).res == "deleted"


def test_no_last_seen_mark_yet_counting_starts_nothing_deleted():
    r = case(ssm=SSM())
    assert (r.res, r.calls) == ("started", "last-seen=2026-09-15T12:00:00Z")


def test_last_used_3_days_ago_kept_with_the_countdown_cloudtrail_not_asked():
    r = case(ssm=SSM(last_seen=ago(days=3)))
    assert (r.res, r.calls) == ("kept", "-")
    assert "kept - last used 3d ago; deleted in 11d unless a box is launched" in str(r)


def test_mark_old_but_cloudtrail_shows_a_launch_kept_and_the_mark_moved_to_it():
    r = case(trail=Trail([("ayis", 5, None)]))
    assert (r.res, r.calls) == ("kept", "lookup,last-seen=2026-09-10T12:00:00Z")
    assert "a box was launched 5d ago (CloudTrail)" in str(r)


def test_mark_old_and_cloudtrail_agrees_emptied_uploads_aborted_deleted_remembered():
    r = case()
    assert (r.res, r.calls) == ("deleted", "lookup,delete-objects:1000,delete-objects:1000,delete-objects:500,"
                                           "abort,delete-bucket,deleted=2026-09-15T12:00:00Z")
    assert "unused for 20d - DELETED s3://ayis-library-test (2500 objects)" in str(r)


def test_already_gone_when_deleting_absent_and_remembered():
    r = case(s3=S3(gone=True))
    assert (r.res, r.calls) == ("absent", "lookup,deleted=2026-09-15T12:00:00Z")


def test_another_hosts_launch_or_a_failed_launch_of_this_one_does_not_keep_it():
    assert case(trail=Trail([("other-box", 1, None), ("ayis", 2, "Client.InsufficientInstanceCapacity")])).res == "deleted"


def failing_ssm():
    s = SSM(last_seen=ago(days=20))
    s.fails = True
    return s


UNCERTAIN = {
    "cloudtrail failing": lambda: {"trail": Trail(fails=True)},
    "cloudtrail too long": lambda: {"trail": Trail(pages=5)},
    "cloudtrail unreadable": lambda: {"trail": Trail([("ayis", 1, None)], junk=True)},
    "mark unreadable": lambda: {"ssm": SSM(last_seen="yesterday")},
    "ssm failing": lambda: {"ssm": failing_ssm()},
    "metric failing": lambda: {"cw": CWStub(fails=True)},
}


@pytest.mark.parametrize("spec", UNCERTAIN)
def test_anything_uncertain_raises(spec):
    assert case(**UNCERTAIN[spec]()).res == "RAISED"


@pytest.mark.parametrize("spec", UNCERTAIN)
def test_anything_uncertain_deletes_nothing(spec):
    assert "delete" not in case(**UNCERTAIN[spec]()).calls


def test_s3_refusing_deletes_raises_at_the_first_refusal_and_keeps_the_bucket():
    r = case(s3=S3(objects=5, delete_errors=True))
    assert r.res == "RAISED"
    assert "S3 refused to delete" in str(r)
    assert "delete-bucket" not in r.calls


def test_a_box_appearing_mid_check_keeps_it():
    r = case(ec2=EC2([], [("i-b", "pending")]))
    assert r.res == "in-use"
    assert "delete" not in r.calls


def test_a_dry_run_looks_at_any_minute_and_changes_nothing():
    r = case(dry=True, now=NOW + timedelta(minutes=17))
    assert (r.res, r.calls) == ("would-delete", "lookup")
    assert "WOULD DELETE s3://ayis-library-test (dry run)" in str(r)


def test_no_mark_written_in_a_dry_run():
    r = case(dry=True, ssm=SSM())
    assert (r.res, r.calls) == ("started", "-")


def test_the_archive_check_still_runs_when_the_idle_check_fails():
    r = case(mode="all", ec2=EC2([("i-a", "running")], fail_idle=True))
    assert r.res == "RAISED"
    assert "archive: kept - a box exists" in str(r)


def warned_1_day():
    settings.NTFY_URL, settings.EXPIRY_DAYS = "u", 1
    return {"ssm": SSM(last_seen=ago(hours=3))}


# It costs nothing until it deletes: no S3 request on any path that keeps the archive.
KEEPS = {
    "a box exists": lambda: {"ec2": EC2([("i-a", "running")])},
    "no mark": lambda: {"ssm": SSM()},
    "used 3 days ago": lambda: {"ssm": SSM(last_seen=ago(days=3))},
    "launched 5 days ago": lambda: {"trail": Trail([("ayis", 5, None)])},
    "nothing measured": lambda: {"cw": CWStub(gb=None)},
    "dry run": lambda: {"dry": True},
    "the 24-hour warning": warned_1_day,
}


@pytest.mark.parametrize("spec", KEEPS)
def test_no_s3_request_on_a_path_that_keeps_the_archive(spec):
    assert case(**KEEPS[spec]()).s3 == "s3:none"


def test_deleting_only_the_listings_are_billed_requests():
    assert case().s3 == "s3:list,list,list,list,list-uploads,list-uploads"


# --- the 24-hour archive warning - once per countdown, recorded in SSM ---------

def test_warned_and_recorded_against_the_deletion_time():
    r = case(**warned_1_day())
    assert (r.res, r.calls) == ("kept", "notify:Saved games will be deleted in 21 hours,warned=2026-09-16T09:00:00Z")


def test_already_warned_for_this_deletion_is_silent():
    settings.NTFY_URL, settings.EXPIRY_DAYS = "u", 1
    assert case(ssm=SSM(last_seen=ago(hours=3), warned=ago(hours=-21))).calls == "-"


def test_days_changed_after_a_warning_warned_again():
    # Warned under 1 day, then the days were raised: the same mark, a later deletion.
    settings.NTFY_URL, settings.EXPIRY_DAYS = "u", 14
    r = case(ssm=SSM(last_seen=ago(days=13, hours=3), warned=ago(days=12, hours=3)))
    assert "notify:Saved games will be deleted in 21 hours" in r.calls


def test_a_warning_for_an_old_mark_does_not_count():
    settings.NTFY_URL, settings.EXPIRY_DAYS = "u", 1
    r = case(ssm=SSM(last_seen=ago(hours=3), warned=ago(days=9)))
    assert "notify:Saved games will be deleted in 21 hours" in r.calls


def test_more_than_24_hours_left_is_silent():
    settings.NTFY_URL = "u"
    assert case(ssm=SSM(last_seen=ago(days=3))).calls == "-"


def test_a_failed_send_is_not_recorded_so_the_next_hour_retries():
    spec = warned_1_day()
    fakes.send_fails[0] = True
    assert case(**spec).calls == "-"


def test_no_url_no_warning_no_mark():
    settings.EXPIRY_DAYS = 1
    assert case(ssm=SSM(last_seen=ago(hours=3))).calls == "-"


def test_a_dry_run_no_warning_no_mark():
    assert case(dry=True, **warned_1_day()).calls == "-"


# --- archive deleted, and a failing watchdog, are notified ---------------------

def test_deleted_remembered_then_notified():
    settings.NTFY_URL = "u"
    assert "delete-bucket,deleted=2026-09-15T12:00:00Z,notify:Saved games deleted" in case().calls


def test_a_failing_watchdog_is_notified():
    settings.NTFY_URL = "u"
    r = case(mode="all", ec2=EC2([("i-a", "running")], fail_idle=True))
    assert "notify:The cost-protection check is not working" in r.calls


def test_a_failing_watchdog_is_notified_at_most_once_an_hour():
    settings.NTFY_URL = "u"
    r = case(mode="all", now=NOW + timedelta(minutes=17), ec2=EC2([("i-a", "running")], fail_idle=True))
    assert "notify" not in r.calls
