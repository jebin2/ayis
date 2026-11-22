"""The dead-man signal: a run that finished without an error records when."""
from datetime import datetime, timezone

import fakes
from fakes import AwsError

from ayis_watchdog import handler

NOW = datetime(2026, 11, 22, 12, 7, tzinfo=timezone.utc)


class EC2:
    def __init__(s, fails=False):
        s.fails = fails

    def describe_instances(s, Filters):
        if s.fails:
            raise AwsError("AuthFailure")
        return {"Reservations": []}


class SSM:
    def __init__(s, fails=False):
        s.p, s.fails = {}, fails

    def put_parameter(s, Name, Value, Type, Overwrite):
        if s.fails:
            raise AwsError("AccessDeniedException")
        s.p[Name] = Value


def run(ec2, ssm, dry=False):
    return fakes.capture(lambda: handler.run_all(ec2, None, None, ssm, None, NOW, dry))


def test_a_good_run_records_when():
    ssm = SSM()
    res, _ = run(EC2(), ssm)
    assert res != "RAISED"
    assert ssm.p == {"/ayis/ayis/watchdog/last-ok": "2026-11-22T12:07:00Z"}


def test_a_failed_run_records_nothing():
    ssm = SSM()
    res, _ = run(EC2(fails=True), ssm)
    assert res == "RAISED"
    assert ssm.p == {}


def test_a_dry_run_records_nothing():
    ssm = SSM()
    run(EC2(), ssm, dry=True)
    assert ssm.p == {}


def test_a_refused_write_is_said_and_the_run_still_good():
    res, log = run(EC2(), SSM(fails=True))
    assert res != "RAISED"
    assert "could not record this good run" in log
