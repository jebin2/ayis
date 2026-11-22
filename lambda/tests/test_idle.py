"""The idle check's decisions, against fake EC2 and CloudWatch. Its job is to end
instances, so every branch that acts, and every branch that must not, has a case.
Each case gives the actions, the calls made, and the log."""
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

import fakes
import pytest
from fakes import AwsError, calls

from ayis_watchdog import idle, settings

NOW = datetime(2026, 9, 15, 12, 0, 0, tzinfo=timezone.utc)


def ago(m: float, now: datetime = NOW) -> datetime:
    return now - timedelta(minutes=m)


class EC2:
    def __init__(s, instances, deny=False, old_boto=False, describe_fails=False, fail_ids=()):
        s.instances, s.deny, s.old_boto, s.describe_fails, s.fail_ids = instances, deny, old_boto, describe_fails, fail_ids

    def describe_instances(s, Filters):
        if s.describe_fails:
            raise AwsError("AuthFailure", "AuthFailure: bad key")
        return {"Reservations": [{"Instances": s.instances}]}

    def _act(s, name, kw):
        if kw.get("DryRun"):
            calls.append(name + "(dry)")
            raise AwsError("UnauthorizedOperation" if s.deny else "DryRunOperation")
        if s.old_boto and "SkipOsShutdown" in kw:
            raise Exception('Parameter validation failed: Unknown parameter in input: "SkipOsShutdown"')
        if kw["InstanceIds"][0] in s.fail_ids:
            raise AwsError("UnauthorizedOperation", "denied")
        extra = "".join("+" + k for k in ("Force", "SkipOsShutdown") if kw.get(k))
        calls.append("%s:%s%s" % (name, kw["InstanceIds"][0], extra))
        return {}

    def terminate_instances(s, **kw):
        return s._act("terminate", kw)

    def stop_instances(s, **kw):
        return s._act("stop", kw)

    def create_tags(s, Resources, Tags):
        calls.append("tag:%s=%s" % (Resources[0], Tags[0]["Value"]))


class CW:
    def __init__(s, points=None, fails=False):
        s.points, s.fails = points or {}, fails   # {metric: [(minutes_ago, bytes)]}

    def get_metric_statistics(s, MetricName, **kw):
        if s.fails:
            raise AwsError("Throttling", "Rate exceeded")
        return {"Datapoints": [{"Timestamp": ago(m), "Sum": b} for m, b in s.points.get(MetricName, [])]}


def inst(iid="i-a", state="running", age=180, spot=True, reason="", tags=None) -> dict[str, Any]:
    d = {"InstanceId": iid, "State": {"Name": state}, "LaunchTime": ago(age),
         "StateTransitionReason": reason, "Tags": tags or []}
    if spot:
        d["InstanceLifecycle"] = "spot"
    return d


QUIET = {"NetworkIn": [(m, 1000) for m in (5, 10, 15, 20, 25, 30)],
         "NetworkOut": [(m, 2000) for m in (5, 10, 15, 20, 25, 30)]}
MB = 1048576


class R(NamedTuple):
    acts: str
    calls: str
    log: str

    def __str__(self) -> str:
        return "%s | %s | %s" % self


def case(ec2: Any, cw: Any, dry: bool = False, now: datetime = NOW) -> R:
    res, log = fakes.capture(lambda: idle.run(ec2, cw, now, dry))
    acts = "RAISED" if res == "RAISED" else (",".join(d["action"] for d in res["decisions"]) or "-")
    return R(acts, fakes.joined(), log)


def test_no_instance_nothing_to_do():
    r = case(EC2([]), CW())
    assert r.acts == "-"
    assert "nothing to do" in str(r)


def test_inside_the_boot_grace():
    r = case(EC2([inst(age=10)]), CW())
    assert (r.acts, r.calls) == ("none", "-")


def test_quiet_but_not_yet_watched_for_the_whole_window():
    # 20 min grace + 30 min window: at 45 minutes old it has been judged for 25.
    r = case(EC2([inst(age=45)]), CW(QUIET))
    assert (r.acts, r.calls) == ("none", "-")
    assert "watched for only 25m of the 30m" in str(r)


def test_busy_in_and_out_are_added_per_period():
    # 6 MB in + 6 MB out in one period is 12 MB of use; either alone is under 10.
    r = case(EC2([inst()]), CW({"NetworkIn": [(10, 6 * MB)], "NetworkOut": [(10, 6 * MB)]}))
    assert (r.acts, r.calls) == ("none", "-")
    assert "busy: 12.0 MB" in str(r)


def test_exactly_the_threshold_counts_as_use():
    assert case(EC2([inst()]), CW({"NetworkIn": [(10, 10485760)]})).acts == "none"


def test_quiet_spot_box_past_the_window_is_terminated_gracefully():
    r = case(EC2([inst(spot=True)]), CW(QUIET))
    assert (r.acts, r.calls) == ("terminate", "terminate:i-a")
    assert "mirrors its games to S3" in str(r)


def test_quiet_on_demand_box_is_stopped_not_terminated():
    r = case(EC2([inst(spot=False)]), CW(QUIET))
    assert (r.acts, r.calls) == ("stop", "stop:i-a")


def test_running_with_no_metrics_at_all_is_wedged_and_acted_on():
    r = case(EC2([inst()]), CW({}))
    assert r.acts == "terminate"
    assert "wedged" in str(r)


def test_traffic_from_before_the_window_does_not_keep_it_alive():
    # A period that ended 35 minutes ago is outside a 30-minute window.
    assert case(EC2([inst()]), CW({"NetworkIn": [(40, 50 * MB), (10, 1000)]})).acts == "terminate"


def test_a_period_that_overlaps_the_window_does():
    assert case(EC2([inst()]), CW({"NetworkIn": [(33, 50 * MB), (10, 1000)]})).acts == "none"


def test_a_dry_run_acts_on_nothing_and_proves_the_permission():
    r = case(EC2([inst()]), CW(QUIET), dry=True)
    assert (r.acts, r.calls) == ("would-terminate", "terminate(dry)")
    assert "permission to terminate: ok" in str(r)


def test_a_dry_run_reports_a_denied_permission():
    assert "DENIED" in str(case(EC2([inst()], deny=True), CW(QUIET), dry=True))


def test_a_dry_run_proves_the_permission_on_a_box_it_would_not_end():
    # The case that matters in practice: `ayis watchdog check` is run during a
    # session, on a busy box - and used to say nothing about the permission.
    r = case(EC2([inst()]), CW({"NetworkIn": [(10, 50 * MB)]}), dry=True)
    assert (r.acts, r.calls) == ("none", "terminate(dry)")
    assert "dry run: permission to terminate: ok" in str(r)


def test_a_dry_run_on_demand_in_the_boot_grace_tests_stop():
    r = case(EC2([inst(age=5, spot=False)]), CW(), dry=True)
    assert (r.acts, r.calls) == ("none", "stop(dry)")


def test_a_dry_run_reports_a_denied_permission_on_a_busy_box():
    assert "DENIED" in str(case(EC2([inst()], deny=True), CW({"NetworkIn": [(10, 50 * MB)]}), dry=True))


def test_a_real_run_on_a_busy_box_makes_no_permission_call():
    assert case(EC2([inst()]), CW({"NetworkIn": [(10, 50 * MB)]})).calls == "-"


def test_metrics_unreadable_is_not_idle_it_raises_and_acts_on_nothing():
    r = case(EC2([inst()]), CW(fails=True))
    assert (r.acts, r.calls) == ("RAISED", "-")


def test_cannot_describe_instances_is_blind_and_says_so():
    r = case(EC2([], describe_fails=True), CW())
    assert r.acts == "RAISED"
    assert "CANNOT QUERY AWS" in str(r)


def test_shutting_down_for_70_minutes_is_forced():
    r = case(EC2([inst(state="shutting-down", reason="User initiated (2026-09-15 10:50:00 GMT)")]), CW())
    assert (r.acts, r.calls) == ("force-terminate", "terminate:i-a+SkipOsShutdown")


def test_shutting_down_for_20_minutes_is_left_to_finish_its_push():
    r = case(EC2([inst(state="shutting-down", reason="User initiated (2026-09-15 11:40:00 GMT)")]), CW())
    assert (r.acts, r.calls) == ("none", "-")
    assert "letting it finish" in str(r)


def test_an_in_guest_shutdown_is_tagged_when_first_seen():
    r = case(EC2([inst(state="stopping", spot=False, reason="")]), CW())
    assert (r.acts, r.calls) == ("none", "tag:i-a=2026-09-15T12:00:00Z")


def test_an_in_guest_shutdown_is_forced_an_hour_later():
    r = case(EC2([inst(state="stopping", spot=False, tags=[{"Key": settings.SINCE_TAG, "Value": "2026-09-15T10:55:00Z"}])]), CW())
    assert (r.acts, r.calls) == ("force-stop", "stop:i-a+Force+SkipOsShutdown")


def test_a_tag_left_from_an_earlier_shutdown_is_ignored():
    # An on-demand box stopped last week and started again an hour ago: measuring
    # from last week's tag would force it down the moment it began stopping.
    r = case(EC2([inst(state="stopping", spot=False, age=60,
                       tags=[{"Key": settings.SINCE_TAG, "Value": "2026-09-08T10:00:00Z"}])]), CW())
    assert (r.acts, r.calls) == ("none", "tag:i-a=2026-09-15T12:00:00Z")


def test_a_boto3_without_skip_os_shutdown_still_forces_a_terminate():
    r = case(EC2([inst(state="shutting-down", reason="User initiated (2026-09-15 10:00:00 GMT)")], old_boto=True), CW())
    assert r.calls == "terminate:i-a"


def test_a_boto3_without_skip_os_shutdown_still_forces_a_stop():
    r = case(EC2([inst(state="stopping", spot=False, reason="User initiated (2026-09-15 10:00:00 GMT)")], old_boto=True), CW())
    assert r.calls == "stop:i-a+Force"


def test_one_instance_failing_does_not_spare_the_other_and_the_run_still_errors():
    r = case(EC2([inst("i-a"), inst("i-b")], fail_ids=("i-a",)), CW(QUIET))
    assert (r.acts, r.calls) == ("RAISED", "terminate:i-b")
    assert "i-a FAILED" in str(r)


def test_pending_is_not_judged():
    r = case(EC2([inst(state="pending")]), CW())
    assert (r.acts, r.calls) == ("none", "-")


# --- notifications from the idle check - only when a URL is set ----------------

def test_terminated_then_notified():
    settings.NTFY_URL = "https://ntfy.sh/t"
    r = case(EC2([inst(spot=True)]), CW(QUIET))
    assert r.calls == "terminate:i-a,notify:Game PC removed - nobody was playing"


def test_no_url_no_notification():
    assert "notify" not in case(EC2([inst(spot=True)]), CW(QUIET)).calls


def test_on_demand_says_stopped():
    settings.NTFY_URL = "https://ntfy.sh/t"
    r = case(EC2([inst(spot=False)]), CW(QUIET))
    assert r.calls == "stop:i-a,notify:Game PC switched off - nobody was playing"


def test_a_dry_run_never_notifies():
    settings.NTFY_URL = "https://ntfy.sh/t"
    assert "notify" not in case(EC2([inst()]), CW(QUIET), dry=True).calls


def test_forced_then_notified_and_recorded():
    settings.NTFY_URL = "https://ntfy.sh/t"
    r = case(EC2([inst(state="shutting-down", reason="User initiated (2026-09-15 10:00:00 GMT)")]), CW())
    assert r.calls == ("terminate:i-a+SkipOsShutdown,notify:Game PC was forced off,"
                       "tag:i-a=2026-09-15T10:00:00Z/2026-09-15T12:00:00Z")


def test_a_failed_send_changes_nothing_and_is_logged():
    settings.NTFY_URL = "https://ntfy.sh/t"
    fakes.send_fails[0] = True
    r = case(EC2([inst()]), CW(QUIET))
    assert (r.acts, r.calls) == ("terminate", "terminate:i-a")
    assert "notification not sent (ignored)" in str(r)


# --- a slow, then a stuck, shutdown - each said once, then hourly while it lasts --

def slow(tags=None):
    return inst(state="shutting-down", reason="User initiated (2026-09-15 11:25:00 GMT)", tags=tags)


FORCED = [{"Key": "ayis-forced", "Value": "2026-09-15T10:00:00Z/2026-09-15T12:00:00Z"}]


def stuck():
    return inst(state="shutting-down", reason="User initiated (2026-09-15 10:00:00 GMT)", tags=FORCED)


@pytest.fixture
def ntfy():
    settings.NTFY_URL = "u"


def test_slow_35_minutes_a_heads_up_recorded_against_this_shutdown(ntfy):
    assert case(EC2([slow()]), CW()).calls == "notify:Game PC is slow to switch off,tag:i-a=2026-09-15T11:25:00Z"


def test_slow_already_sent_for_this_shutdown_is_silent(ntfy):
    r = case(EC2([slow([{"Key": "ayis-slow-noted", "Value": "2026-09-15T11:25:00Z"}])]), CW())
    assert r.calls == "-"


def test_slow_a_mark_from_an_earlier_shutdown_does_not_count(ntfy):
    r = case(EC2([slow([{"Key": "ayis-slow-noted", "Value": "2026-09-01T08:00:00Z"}])]), CW())
    assert "notify:Game PC is slow to switch off" in r.calls


def test_slow_15_minutes_nothing_yet(ntfy):
    r = case(EC2([inst(state="shutting-down", reason="User initiated (2026-09-15 11:45:00 GMT)")]), CW())
    assert r.calls == "-"


def test_slow_a_dry_run_no_heads_up_no_tag(ntfy):
    assert case(EC2([slow()]), CW(), dry=True).calls == "-"


def test_slow_no_url_no_heads_up_no_tag():
    assert case(EC2([slow()]), CW()).calls == "-"


def test_forced_again_3_minutes_later_is_silent(ntfy):
    assert case(EC2([stuck()]), CW(), now=NOW + timedelta(minutes=3)).calls == "terminate:i-a+SkipOsShutdown"


def test_still_stuck_half_an_hour_later_is_silent(ntfy):
    assert case(EC2([stuck()]), CW(), now=NOW + timedelta(minutes=30)).calls == "terminate:i-a+SkipOsShutdown"


def test_an_hour_after_forcing_the_hourly_reminder(ntfy):
    r = case(EC2([stuck()]), CW(), now=NOW + timedelta(minutes=60))
    assert r.calls == "terminate:i-a+SkipOsShutdown,notify:Game PC will not switch off - it may still be charging"


# --- the run that started a machine, in the lines about it ---------------------

def test_lines_about_a_machine_carry_its_run():
    r = case(EC2([inst(tags=[{"Key": "ayis:run", "Value": "ab12cd34"}])]), CW(QUIET))
    assert "terminate issued" in r.log and "run=ab12cd34" in r.log


def test_a_machine_with_no_run_has_none_and_none_leaks_to_the_next():
    r = case(EC2([inst("i-a", tags=[{"Key": "ayis:run", "Value": "ab12cd34"}]), inst("i-b")]), CW(QUIET))
    lines = r.log.split(" / ")
    assert any("i-a" in x and "run=ab12cd34" in x for x in lines)
    assert all("run=" not in x for x in lines if "i-b" in x)
