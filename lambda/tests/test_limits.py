"""The HARD LIMITS, against fake EC2, SSM and IAM clients: the month's hours,
one session's length, and a spent AWS budget. Unlike the idle check these end a
machine that IS in use, so every branch that acts, and every one that must not,
has a case. Each case gives the actions, the calls, the usage mark and the log."""
import json
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

import fakes
import pytest
from fakes import AwsError, calls

from ayis_watchdog import limits, settings

NOW = datetime(2026, 11, 20, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def harness():
    settings.NTFY_URL = "https://ntfy.example/t"
    # A notification's cost words need a rupee rate; the cost cases set one.
    settings.INR_PER_USD = None


def ago(m):
    return NOW - timedelta(minutes=m)


class EC2:
    def __init__(s, instances=(), fails=False):
        s.instances, s.fails = list(instances), fails

    def describe_instances(s, Filters):
        if s.fails:
            raise AwsError("AuthFailure")
        return {"Reservations": [{"Instances": s.instances}]}

    def stop_instances(s, **kw):
        calls.append("stop:" + kw["InstanceIds"][0])

    def terminate_instances(s, **kw):
        calls.append("terminate:" + kw["InstanceIds"][0])

    def create_tags(s, Resources, Tags):
        calls.append("tag:%s=%s" % (Tags[0]["Key"], Tags[0]["Value"]))


class SSM:
    def __init__(s, usage=None, extra=None, fails=False):
        s.p, s.fails = {}, fails
        if usage is not None:
            s.p["/ayis/ayis/usage/2026-11"] = usage if isinstance(usage, str) else json.dumps(usage)
        if extra is not None:
            s.p["/ayis/ayis/usage/2026-11-extra"] = str(extra)

    def get_parameter(s, Name):
        if s.fails:
            raise AwsError("ThrottlingException")
        if Name not in s.p:
            raise AwsError("ParameterNotFound")
        return {"Parameter": {"Value": s.p[Name]}}

    def put_parameter(s, Name, Value, **kw):
        s.p[Name] = Value


class IAM:
    def __init__(s, attached=False, missing=False):
        s.attached, s.missing = attached, missing

    def list_entities_for_policy(s, PolicyArn):
        if s.missing:
            raise AwsError("NoSuchEntity")
        return {"PolicyUsers": [{"UserName": "CLI"}] if s.attached else [], "PolicyRoles": [], "PolicyGroups": []}


def inst(iid="i-a", age=60, spot=False, state="running", tags=None):
    d = {"InstanceId": iid, "State": {"Name": state}, "LaunchTime": ago(age), "Tags": tags or []}
    if spot:
        d["InstanceLifecycle"] = "spot"
    return d


class R(NamedTuple):
    acts: str
    calls: str
    mark: str
    log: str

    def __str__(self) -> str:
        return "%s | %s | %s | %s" % self


def case(ec2=None, ssm=None, iam=None, dry=False, now=NOW) -> R:
    ec2, ssm = ec2 or EC2(), ssm or SSM()
    res, log = fakes.capture(lambda: limits.limits(ec2, ssm, iam, now, dry))
    if res == "RAISED":
        acts = "RAISED"
    else:
        acts = "off" if res is None else (",".join("%s:%s" % (d["action"], d["reason"]) for d in res["decisions"]) or "-")
    return R(acts, fakes.joined(), ssm.p.get("/ayis/ayis/usage/" + now.strftime("%Y-%m"), "none"), log)


def test_every_limit_off_nothing_is_looked_at():
    r = case(EC2([inst(age=6000)]))
    assert (r.acts, r.calls, r.mark) == ("off", "-", "none")


def test_monthly_cap_under_it_the_running_machines_time_is_recorded():
    settings.MAX_HOURS_MONTH = 10
    r = case(EC2([inst(age=90)]))
    assert (r.acts, r.calls) == ("-", "-")
    assert '"i-a@2026-11-20T10:30:00Z": 5400.0' in r.mark
    assert "1.5h used of 10.0h" in str(r)


def test_a_run_that_has_ended_moves_to_done_and_a_new_run_is_counted_on_top():
    settings.MAX_HOURS_MONTH = 10
    r = case(EC2([inst(age=60)]), SSM({"done": 3600, "open": {"i-old@2026-11-19T10:00:00Z": 7200}}))
    assert '"done": 10800.0' in r.mark
    assert "i-old" not in r.mark
    assert "4.0h used of 10.0h" in str(r)


def test_a_repeated_run_adds_nothing_time_comes_from_launch_time():
    settings.MAX_HOURS_MONTH = 10
    r = case(EC2([inst(age=60)]), SSM({"done": 0, "open": {"i-a@2026-11-20T11:00:00Z": 3000}}))
    assert "1.0h used of 10.0h" in str(r)


def test_a_machine_launched_last_month_counts_only_from_the_1st():
    settings.MAX_HOURS_MONTH = 500
    i = inst()
    i["LaunchTime"] = datetime(2026, 10, 29, tzinfo=timezone.utc)
    r = case(EC2([i]), now=datetime(2026, 11, 1, 2, 0, tzinfo=timezone.utc))
    assert "2.0h used of 500.0h" in str(r)


def test_at_the_cap_an_on_demand_machine_is_stopped_gracefully_and_told():
    settings.MAX_HOURS_MONTH = 2
    r = case(EC2([inst(age=10)]), SSM({"done": 3600 * 2, "open": {}}))
    assert r.acts == "stop:monthly"
    assert "stop:i-a" in r.calls
    assert "notify:This month's play time is used up" in r.calls


def test_at_the_cap_a_spot_machine_is_terminated():
    settings.MAX_HOURS_MONTH = 2
    assert case(EC2([inst(spot=True)]), SSM({"done": 3600 * 2, "open": {}})).acts == "terminate:monthly"


def test_extra_hours_for_the_month_lift_the_cap():
    settings.MAX_HOURS_MONTH = 2
    r = case(EC2([inst(age=10)]), SSM({"done": 3600 * 2, "open": {}}, extra=5))
    assert r.acts == "-"
    assert "of 7.0h" in str(r)


def test_30_minutes_before_the_cap_warned_once_and_remembered():
    settings.MAX_HOURS_MONTH = 2
    r = case(EC2([inst(age=10)]), SSM({"done": 3600 * 2 - 1800 - 600, "open": {}}))
    assert "notify:30 minutes of play left this month" in r.calls
    assert '"warned": true' in r.mark


def test_30_minutes_before_the_cap_not_warned_twice():
    settings.MAX_HOURS_MONTH = 2
    assert case(EC2([inst(age=10)]), SSM({"done": 3600 * 2 - 1800 - 600, "open": {}, "warned": True})).calls == "-"


def test_no_machine_running_nothing_ended_the_ended_run_still_filed():
    settings.MAX_HOURS_MONTH = 2
    r = case(ssm=SSM({"done": 3600 * 5, "open": {"i-a@x": 60}}))
    assert (r.acts, r.calls) == ("-", "-")
    assert '"done": 18060.0' in r.mark


def test_an_unreadable_usage_mark_is_an_error_never_zero_hours():
    settings.MAX_HOURS_MONTH = 2
    r = case(EC2([inst()]), SSM("{not json"))
    assert r.acts == "RAISED"
    assert "not enforced this run" in str(r)


def test_ssm_failing_does_not_stop_the_session_limit_working():
    settings.MAX_HOURS_MONTH, settings.MAX_SESSION_HOURS = 2, 1
    r = case(EC2([inst(age=61)]), SSM(fails=True))
    assert r.acts == "RAISED"
    assert "stop:i-a" in r.calls


def test_session_limit_under_it_left_alone_no_mark_written():
    settings.MAX_SESSION_HOURS = 4
    r = case(EC2([inst(age=60)]))
    assert (r.acts, r.calls, r.mark) == ("-", "-", "none")


def test_session_limit_past_it_ended_and_told():
    settings.MAX_SESSION_HOURS = 4
    r = case(EC2([inst(age=241)]))
    assert r.acts == "stop:session"
    assert "notify:Session time limit reached" in r.calls


def test_session_warning_30_minutes_before_with_the_deadline_tagged():
    settings.MAX_SESSION_HOURS = 4
    r = case(EC2([inst(age=220)]))
    assert "notify:Game PC switches off in 20 minutes" in r.calls
    assert "tag:ayis-session-warned=2026-11-20T12:20:00Z" in r.calls


def test_session_warning_not_twice():
    settings.MAX_SESSION_HOURS = 4
    r = case(EC2([inst(age=220, tags=[{"Key": "ayis-session-warned", "Value": "2026-11-20T12:20:00Z"}])]))
    assert r.calls == "-"


def test_an_extended_session_runs_to_its_new_end():
    settings.MAX_SESSION_HOURS = 4
    r = case(EC2([inst(age=300, tags=[{"Key": "ayis-session-until", "Value": "2026-11-20T13:00:00Z"}])]))
    assert (r.acts, r.calls) == ("-", "-")


def test_an_extension_earlier_than_the_limit_does_not_shorten_it():
    settings.MAX_SESSION_HOURS = 4
    assert case(EC2([inst(age=60, tags=[{"Key": "ayis-session-until", "Value": "2026-11-20T11:30:00Z"}])])).acts == "-"


def test_a_garbled_extension_is_ignored_not_obeyed():
    settings.MAX_SESSION_HOURS = 4
    assert case(EC2([inst(age=241, tags=[{"Key": "ayis-session-until", "Value": "forever"}])])).acts == "stop:session"


def test_budget_spent_every_running_machine_ends():
    settings.BLOCK_POLICY_ARN = "arn:x"
    r = case(EC2([inst("i-a"), inst("i-b", spot=True)]), iam=IAM(attached=True))
    assert r.acts == "stop:budget,terminate:budget"
    assert "notify:Monthly budget used up" in r.calls


def test_budget_policy_not_attached_left_alone():
    settings.BLOCK_POLICY_ARN = "arn:x"
    assert case(EC2([inst()]), iam=IAM()).acts == "-"


def test_budget_policy_not_made_yet_left_alone():
    settings.BLOCK_POLICY_ARN = "arn:x"
    assert case(EC2([inst()]), iam=IAM(missing=True)).acts == "-"


def test_a_dry_run_ends_nothing_and_writes_nothing():
    settings.MAX_HOURS_MONTH, settings.MAX_SESSION_HOURS = 2, 1
    r = case(EC2([inst(age=120)]), SSM({"done": 3600 * 9, "open": {}}), dry=True)
    assert r.acts == "would-stop:monthly"
    assert (r.calls, r.mark) == ("-", '{"done": 32400, "open": {}}')


def test_a_machine_still_starting_is_counted_but_not_ended_until_it_runs():
    settings.MAX_SESSION_HOURS = 1
    r = case(EC2([inst(age=120, state="pending")]))
    assert (r.acts, r.calls) == ("-", "-")


def test_aws_not_answering_is_an_error_not_all_clear():
    settings.MAX_SESSION_HOURS = 1
    assert case(EC2(fails=True)).acts == "RAISED"


# --- the cost in a notification: this session and this month, or nothing -------

class PriceEC2:
    def describe_spot_price_history(s, **k):
        return {"SpotPriceHistory": [{"SpotPrice": "0.2"}]}


class Budgets:
    def describe_budget(s, **k):
        return {"Budget": {"CalculatedSpend": {"ActualSpend": {"Amount": "12.3"}}, "BudgetLimit": {"Amount": "50"}}}


def priced(spot=False):
    settings.INR_PER_USD, settings.OD_USD_HOUR, settings.ACCOUNT = 100.0, 0.5, "1"
    i = {"LaunchTime": NOW - timedelta(hours=2), "InstanceType": "g4dn.xlarge", "Placement": {"AvailabilityZone": "a"}}
    if spot:
        i["InstanceLifecycle"] = "spot"
    return i


def words(ec2, budgets, i):
    res, _log = fakes.capture(lambda: limits.cost_words(ec2, budgets, i, NOW))
    return res


def test_cost_on_demand_session():
    assert "This session: about ₹100 so far (2.0 h at ₹50 an hour)." in words(PriceEC2(), Budgets(), priced())


def test_cost_the_month_from_the_budget():
    assert "This month: about ₹1,230 of your ₹5,000 budget" in words(PriceEC2(), Budgets(), priced())


def test_cost_spot_asks_aws_for_the_price():
    assert "at ₹20 an hour" in words(PriceEC2(), Budgets(), priced(spot=True))


def test_cost_no_exchange_rate_nothing():
    i = priced()
    settings.INR_PER_USD = None
    assert words(PriceEC2(), Budgets(), i) == ""


def test_cost_aws_not_answering_no_words_no_error():
    assert words(object(), None, priced(spot=True)) == ""
