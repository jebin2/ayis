"""An on-demand box left stopped is deleted after the days games are kept.
Stopped, it billed for its disk with no end, and kept the archive "in use" as
long. Same days as the archive; a day's warning; 0 keeps it."""
from datetime import datetime, timedelta, timezone

import fakes
import pytest
from fakes import calls

from ayis_watchdog import handler, settings, stopped

NOW = datetime(2026, 10, 25, 12, 2, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def harness():
    settings.TS_HOST, settings.EXPIRY_DAYS, settings.NTFY_URL = "ayis", 14, "u"


def days(n):
    return NOW - timedelta(days=n)


def gmt(t):
    return "User initiated (%s GMT)" % t.strftime("%Y-%m-%d %H:%M:%S")


class EC2:
    def __init__(s, instances):
        s.instances = instances

    def describe_instances(s, Filters):
        states = next(f for f in Filters if f["Name"] == "instance-state-name")["Values"]
        return {"Reservations": [{"Instances": [i for i in s.instances if i["State"]["Name"] in states]}]}

    def terminate_instances(s, **kw):
        calls.append("terminate:" + kw["InstanceIds"][0])
        return {}

    def stop_instances(s, **kw):
        calls.append("stop:" + kw["InstanceIds"][0])
        return {}

    def create_tags(s, Resources, Tags):
        calls.append("tag:%s=%s" % (Tags[0]["Key"], Tags[0]["Value"]))


def box(stopped=None, spot=False, launched=30, tags=None, state="stopped"):
    d = {"InstanceId": "i-s", "State": {"Name": state}, "LaunchTime": days(launched),
         "StateTransitionReason": gmt(stopped) if stopped else "", "Tags": tags or []}
    if spot:
        d["InstanceLifecycle"] = "spot"
    return d


def case(ec2, dry=False, now=NOW):
    res, log = fakes.capture(lambda: stopped.expire_stopped(ec2, now, dry))
    return ",".join(r["action"] for r in res or []) or "-", fakes.joined(), log


def test_stopped_3_days_of_14_kept_nothing_done_and_when_it_goes_is_said():
    acts, calls_, log = case(EC2([box(stopped=days(3))]))
    assert (acts, calls_) == ("kept", "-")
    assert "deleted in 11d unless it is started" in log


def test_inside_the_last_day_warned():
    _, calls_, _ = case(EC2([box(stopped=days(13.5))]))
    assert calls_ == "notify:Game PC will be deleted tomorrow,tag:ayis-stopped-warned=2026-10-12T00:02:00Z"


def test_inside_the_last_day_warned_once():
    _, calls_, _ = case(EC2([box(stopped=days(13.5), tags=[{"Key": "ayis-stopped-warned", "Value": "2026-10-12T00:02:00Z"}])]))
    assert calls_ == "-"


def test_past_the_14_days_deleted_saying_its_games_stay_in_s3():
    acts, calls_, log = case(EC2([box(stopped=days(15))]))
    assert (acts, calls_) == ("terminate", "terminate:i-s,notify:Old game PC deleted")
    assert "its games stay in S3 for 14 days" in log


def test_a_spot_box_is_not_this_checks():
    assert case(EC2([box(stopped=days(15), spot=True)]))[:2] == ("-", "-")


def test_no_aws_timestamp_counted_from_now_and_recorded():
    assert case(EC2([box()]))[:2] == ("kept", "tag:ayis-stopped-since=2026-10-25T12:02:00Z")


def test_no_aws_timestamp_deleted_once_that_is_past():
    assert case(EC2([box(tags=[{"Key": "ayis-stopped-since", "Value": "2026-10-01T00:00:00Z"}], launched=40)]))[0] == "terminate"


def test_a_record_from_an_earlier_stop_does_not_count():
    r = case(EC2([box(tags=[{"Key": "ayis-stopped-since", "Value": "2026-09-01T00:00:00Z"}], launched=2)]))
    assert r[:2] == ("kept", "tag:ayis-stopped-since=2026-10-25T12:02:00Z")


def test_a_dry_run_deletes_nothing():
    assert case(EC2([box(stopped=days(15))]), dry=True)[:2] == ("would-terminate", "-")


def test_kept_forever_with_0_days():
    settings.EXPIRY_DAYS = 0
    assert case(EC2([box(stopped=days(400))]))[:2] == ("-", "-")


def test_hourly_as_the_archive_check_not_at_half_past():
    assert case(EC2([box(stopped=days(15))]), now=NOW.replace(minute=30))[:2] == ("-", "-")


def test_it_runs_with_the_other_checks():
    # Was a source-text check; now the scheduled run itself deletes the box.
    class Quiet:
        def get_metric_statistics(s, **kw):
            return {"Datapoints": []}
    ec2 = EC2([box(stopped=days(15))])
    res, _log = fakes.capture(lambda: handler.run_all(ec2, Quiet(), None, None, None, NOW))
    assert res["stopped"] == [{"instance": "i-s", "action": "terminate"}]
    assert "terminate:i-s" in calls
