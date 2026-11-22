"""The box confirmed gone, from EC2's own state-change events, and the games
disk after an idle stop."""
import sys
from datetime import datetime, timezone
from typing import NamedTuple

import fakes
import pytest
from fakes import AwsError, calls

from ayis_watchdog import events, handler, settings

NOW = datetime(2026, 9, 15, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def harness():
    settings.TS_HOST, settings.NTFY_URL = "ayis", "https://ntfy.sh/t"
    settings.BUCKET, settings.EXPIRY_DAYS = "ayis-library-test", 14


class EC2:
    def __init__(s, name="ayis", fails=False):
        s.name, s.fails = name, fails

    def describe_instances(s, InstanceIds=None, Filters=None):
        calls.append("describe:%s" % (InstanceIds or ["by-filter"])[0])
        if s.fails:
            raise AwsError("InvalidInstanceID.NotFound")
        return {"Reservations": [{"Instances": [{"InstanceId": InstanceIds[0],
                "Tags": [{"Key": "Name", "Value": s.name}]}]}]}


def event(state, iid="i-a"):
    return {"source": "aws.ec2", "detail-type": "EC2 Instance State-change Notification",
            "detail": {"instance-id": iid, "state": state}}


def spot(iid="i-a"):
    return {"source": "aws.ec2", "detail-type": "EC2 Spot Instance Interruption Warning",
            "detail": {"instance-id": iid, "instance-action": "terminate"}}


class CWS:
    def __init__(s, gb=160.0, fails=False):
        s.gb, s.fails = gb, fails

    def get_metric_statistics(s, **kw):
        calls.append("metric")
        if s.fails:
            raise AwsError("Throttling")
        if s.gb is None:
            return {"Datapoints": []}
        return {"Datapoints": [{"Timestamp": datetime(2026, 9, 14, tzinfo=timezone.utc), "Average": s.gb * 1073741824}]}


class SSMS:
    def __init__(s, fails=False):
        s.fails = fails

    def put_parameter(s, Name, Value, Type, Overwrite):
        if s.fails:
            raise AwsError("AccessDeniedException")
        calls.append("%s=%s" % (Name.rsplit("/", 1)[1].replace("archive-", ""), Value))


class R(NamedTuple):
    state: str
    calls: str
    log: str

    def __str__(self) -> str:
        return "%s | %s | %s" % self


def case(ev=None, ec2=None, cw=None, ssm=None, via_handler=False) -> R:
    ev, ec2, cw, ssm = ev or event("terminated"), ec2 or EC2(), cw or CWS(), ssm or SSMS()

    def go():
        if not via_handler:
            return events.state_changed(ec2, ev, cw, NOW, ssm)
        made = []

        class Boto3:
            def client(s, name):
                made.append(name)
                return ec2 if name == "ec2" else cw if name == "cloudwatch" else ssm if name == "ssm" else object()
        sys.modules["boto3"] = Boto3()  # type: ignore[assignment]
        try:
            return handler.handler(ev, None)
        finally:
            del sys.modules["boto3"]
            calls.append("clients:" + "+".join(made))
    res, log = fakes.capture(go)
    state = "RAISED" if res == "RAISED" else res.get("state", "-")
    sent = " / ".join("sent: " + m for m in fakes.sent)
    return R(state, fakes.joined(), (log + " / " + sent) if sent else log)


def test_terminated_is_notified():
    r = case()
    assert (r.state, r.calls) == ("terminated", "describe:i-a,last-seen=2026-09-15T12:00:00Z,metric,notify:Game PC removed")


def test_stopped_is_notified():
    assert case(event("stopped")).calls == "describe:i-a,last-seen=2026-09-15T12:00:00Z,metric,notify:Game PC is off"


def test_another_instance_in_the_account_is_silent():
    r = case(ec2=EC2(name="someone-else"))
    assert (r.state, r.calls) == ("not-ours", "describe:i-a")


def test_cannot_describe_it_is_silent_and_says_why():
    r = case(ec2=EC2(fails=True))
    assert (r.state, r.calls) == ("unknown", "describe:i-a")
    assert "could not be described" in str(r)


def test_a_state_that_is_not_an_end_is_ignored():
    r = case(event("running"))
    assert (r.state, r.calls) == ("ignored", "-")


def test_no_url_logged_nothing_sent():
    settings.NTFY_URL = ""
    r = case()
    assert r.calls == "describe:i-a,last-seen=2026-09-15T12:00:00Z,metric"
    assert "i-a terminated - compute no longer bills." in str(r)


def test_the_handler_routes_it_and_runs_no_idle_or_archive_check():
    # The handler uses the real clock, so the mark's value is not asserted here.
    r = case(via_handler=True)
    assert "describe:i-a,last-seen=" in r.calls
    assert "notify:Game PC removed,clients:ec2+cloudwatch+ssm+s3" in r.calls


def test_a_spot_interruption_warning_is_notified():
    r = case(spot())
    assert (r.state, r.calls) == ("interruption", "describe:i-a,notify:AWS is taking your game PC back")


def test_another_instances_warning_is_silent():
    r = case(spot(), ec2=EC2(name="someone-else"))
    assert (r.state, r.calls) == ("not-ours", "describe:i-a")


def test_the_handler_routes_a_warning_too():
    r = case(spot(), via_handler=True)
    assert r.calls == "describe:i-a,notify:AWS is taking your game PC back,clients:ec2+cloudwatch+ssm+s3"


# --- the archive countdown starts when the box really ended ---------------------

def test_terminated_last_seen_set_to_that_moment():
    assert "last-seen=2026-09-15T12:00:00Z" in case().calls


def test_stopped_last_seen_the_same():
    assert "last-seen=2026-09-15T12:00:00Z" in case(event("stopped")).calls


def test_expiry_off_nothing_written():
    settings.EXPIRY_DAYS = 0
    assert "last-seen" not in case().calls


def test_another_instance_nothing_written():
    assert "last-seen" not in case(ec2=EC2(name="someone-else")).calls


def test_a_spot_warning_is_not_an_end():
    assert "last-seen" not in case(spot()).calls


def test_ssm_refusing_is_said_and_the_notification_still_sent():
    r = case(ssm=SSMS(fails=True))
    assert "could not record when the box ended" in str(r)
    assert "notify:Game PC removed" in r.calls


# --- 'box gone' says what still bills in S3 - from the free size metric ---------

def test_size_month_cost_and_inr():
    assert "S3 still holds about 160 GB of games (as of 2026-09-14): about $4.00 a month (INR 352)." in str(case())


def test_and_when_it_expires():
    assert "Deleted after 14 days with no box, around 2026-09-29." in str(case())


def test_no_archive_nothing_else_bills():
    assert "No game archive is measured in S3, so nothing else bills." in str(case(cw=CWS(gb=None)))


def test_expiry_off_kept_until_deleted():
    settings.EXPIRY_DAYS = 0
    assert "Kept until you delete it: ayis destroy --all." in str(case())


def test_a_small_archive_keeps_a_decimal():
    assert "about 0.5 GB of games" in str(case(cw=CWS(gb=0.5)))


def test_size_unreadable_says_so_and_still_notifies():
    r = case(cw=CWS(fails=True))
    assert "size could not be read" in str(r)
    assert "notify:Game PC removed" in r.calls


def test_stopped_the_disk_still_bills():
    assert "its disk still does. S3 still holds" in str(case(event("stopped")))


# --- the games disk after an idle stop ------------------------------------------
# The machine stopped itself (idle) and its games are saved: the disk goes. A
# person's own Stop, no complete save, or a save older than this run: it stays.

LAUNCH = datetime(2026, 11, 9, 10, 0, tzinfo=timezone.utc)
SAVED_AFTER = datetime(2026, 11, 9, 11, 0, tzinfo=timezone.utc)
SAVED_BEFORE = datetime(2026, 11, 8, 11, 0, tzinfo=timezone.utc)


class DiskEC2:
    def detach_volume(s, **k):
        calls.append("detach:" + k["VolumeId"])

    def describe_volumes(s, **k):
        return {"Volumes": [{"State": "available"}]}

    def delete_volume(s, **k):
        calls.append("delete:" + k["VolumeId"])


class S3:
    def __init__(s, at):
        s.at = at

    def head_object(s, **k):
        calls.append("head:" + k["Key"])
        if s.at is None:
            raise Exception("NoSuchKey")
        return {"LastModified": s.at}


def stopped_inst(reason="Client.InstanceInitiatedShutdown: Instance initiated shutdown", disk=True):
    m = [{"DeviceName": "/dev/sda1", "Ebs": {"VolumeId": "vol-root"}}]
    if disk:
        m.append({"DeviceName": "/dev/sdg", "Ebs": {"VolumeId": "vol-games"}})
    return {"InstanceId": "i-1", "StateTransitionReason": reason, "LaunchTime": LAUNCH, "BlockDeviceMappings": m}


def disk(inst, s3):
    settings.BUCKET, settings.PREFIX, settings.NTFY_URL = "b", "steam", ""
    res, _log = fakes.capture(lambda: events.drop_games_disk(DiskEC2(), s3, inst, sleep=lambda s: None))
    return "%s | %s" % (res, fakes.joined())


def test_idle_stop_games_saved_after_it_started_the_games_disk_is_deleted():
    assert disk(stopped_inst(), S3(SAVED_AFTER)) == "deleted | head:steam/pushed.json,detach:vol-games,delete:vol-games"


def test_a_persons_own_stop_the_disk_is_theirs_to_decide():
    assert disk(stopped_inst(reason="User initiated (2026-11-09 11:30:00 GMT)"), S3(SAVED_AFTER)) == "not-an-idle-stop | -"


def test_no_complete_save_kept():
    assert disk(stopped_inst(), S3(None)) == "not-saved | head:steam/pushed.json"


def test_a_save_older_than_this_run_kept():
    assert disk(stopped_inst(), S3(SAVED_BEFORE)) == "not-saved | head:steam/pushed.json"


def test_no_games_disk_nothing_to_do():
    assert disk(stopped_inst(disk=False), S3(SAVED_AFTER)) == "no-games-disk | -"
