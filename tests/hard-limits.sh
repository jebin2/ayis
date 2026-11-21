#!/usr/bin/env bash
# The cloud watchdog's HARD LIMITS (lambda/cloud_watchdog.py limits()), against
# fake EC2, SSM and IAM clients: the month's hours, one session's length, and a
# spent AWS budget. Unlike the idle check these end a machine that IS in use, so
# every branch that acts, and every one that must not, has a case.
#
# Each case prints "<actions> | <calls> | <usage mark> | <log>".
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
check() { if [[ $2 == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1));
          else echo "  FAIL $1: got '$2' want '$3'"; fail=$((fail+1)); fi; }
contains() { if [[ $2 == *"$3"* ]]; then echo "  ok   $1"; pass=$((pass+1));
             else echo "  FAIL $1: '$2' lacks '$3'"; fail=$((fail+1)); fi; }
lacks()    { if [[ $2 != *"$3"* ]]; then echo "  ok   $1"; pass=$((pass+1));
             else echo "  FAIL $1: '$2' contains '$3'"; fail=$((fail+1)); fi; }

case_() {
  PYTHONDONTWRITEBYTECODE=1 python3 - "$1" <<'PY' 2>&1
import sys, io, json, contextlib
from datetime import datetime, timedelta, timezone
sys.path.insert(0, "lambda")
import cloud_watchdog as w
w.TS_HOST = "ayis"
w.MAX_HOURS_MONTH, w.MAX_SESSION_HOURS, w.BLOCK_POLICY_ARN = 0, 0, ""
w.NTFY_URL = "https://ntfy.example/t"
calls = []
def fake_send(url, title, message, priority, tags): calls.append("notify:" + title)
w.send = fake_send

NOW = datetime(2026, 11, 20, 12, 0, 0, tzinfo=timezone.utc)
def ago(m): return NOW - timedelta(minutes=m)

class AwsError(Exception):
    def __init__(s, code): super().__init__(code); s.response = {"Error": {"Code": code}}

class EC2:
    def __init__(s, instances=(), fails=False): s.instances, s.fails = list(instances), fails
    def describe_instances(s, Filters):
        if s.fails: raise AwsError("AuthFailure")
        return {"Reservations": [{"Instances": s.instances}]}
    def stop_instances(s, **kw): calls.append("stop:" + kw["InstanceIds"][0])
    def terminate_instances(s, **kw): calls.append("terminate:" + kw["InstanceIds"][0])
    def create_tags(s, Resources, Tags): calls.append("tag:%s=%s" % (Tags[0]["Key"], Tags[0]["Value"]))

class SSM:
    def __init__(s, usage=None, extra=None, fails=False):
        s.p, s.fails = {}, fails
        if usage is not None: s.p["/ayis/ayis/usage/2026-11"] = usage if isinstance(usage, str) else json.dumps(usage)
        if extra is not None: s.p["/ayis/ayis/usage/2026-11-extra"] = str(extra)
    def get_parameter(s, Name):
        if s.fails: raise AwsError("ThrottlingException")
        if Name not in s.p: raise AwsError("ParameterNotFound")
        return {"Parameter": {"Value": s.p[Name]}}
    def put_parameter(s, Name, Value, **kw): s.p[Name] = Value

class IAM:
    def __init__(s, attached=False, missing=False): s.attached, s.missing = attached, missing
    def list_entities_for_policy(s, PolicyArn):
        if s.missing: raise AwsError("NoSuchEntity")
        return {"PolicyUsers": [{"UserName": "CLI"}] if s.attached else [], "PolicyRoles": [], "PolicyGroups": []}

def inst(iid="i-a", age=60, spot=False, state="running", tags=None):
    d = {"InstanceId": iid, "State": {"Name": state}, "LaunchTime": ago(age), "Tags": tags or []}
    if spot: d["InstanceLifecycle"] = "spot"
    return d

ec2 = EC2(); ssm = SSM(); iam = None; dry = False; now = NOW
exec(sys.argv[1])
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    try:
        res = w.limits(ec2, ssm, iam, now, dry)
        acts = "off" if res is None else (",".join("%s:%s" % (d["action"], d["reason"]) for d in res["decisions"]) or "-")
    except Exception as e:
        acts = "RAISED"; print("error: %s" % e)
mark = ssm.p.get("/ayis/ayis/usage/" + now.strftime("%Y-%m"), "none")
print("%s | %s | %s | %s" % (acts, ",".join(calls) or "-", mark, buf.getvalue().replace("\n", " / ").strip()))
PY
}
field() { cut -d'|' -f"$1" <<<"$2" | sed 's/^ *//; s/ *$//'; }

echo "1. every limit off: nothing is looked at"
r=$(case_ 'ec2 = EC2([inst(age=6000)])')
check "off, no calls, no mark" "$(field 1 "$r")|$(field 2 "$r")|$(field 3 "$r")" "off|-|none"

echo "2. monthly cap: under it, the running machine's time is recorded"
r=$(case_ 'w.MAX_HOURS_MONTH = 10; ec2 = EC2([inst(age=90)])')
check "left alone" "$(field 1 "$r")|$(field 2 "$r")" "-|-"
contains "records 90 minutes as open" "$(field 3 "$r")" '"i-a@2026-11-20T10:30:00Z": 5400.0'
contains "says the count" "$r" "1.5h used of 10.0h"

echo "3. a run that has ended moves to done; a new run is counted on top"
r=$(case_ 'w.MAX_HOURS_MONTH = 10; ssm = SSM({"done": 3600, "open": {"i-old@2026-11-19T10:00:00Z": 7200}}); ec2 = EC2([inst(age=60)])')
contains "done = 1h + 2h" "$(field 3 "$r")" '"done": 10800.0'
lacks "old run no longer open" "$(field 3 "$r")" "i-old"
contains "4h in all" "$r" "4.0h used of 10.0h"

echo "4. a repeated run adds nothing: time comes from LaunchTime, not a counter"
r=$(case_ 'w.MAX_HOURS_MONTH = 10; ssm = SSM({"done": 0, "open": {"i-a@2026-11-20T11:00:00Z": 3000}}); ec2 = EC2([inst(age=60)])')
contains "1h, not 1h + 50m" "$r" "1.0h used of 10.0h"

echo "5. a machine launched LAST month counts only from the 1st"
r=$(case_ 'w.MAX_HOURS_MONTH = 500; now = datetime(2026, 11, 1, 2, 0, tzinfo=timezone.utc); i = inst(); i["LaunchTime"] = datetime(2026, 10, 29, tzinfo=timezone.utc); ec2 = EC2([i])')
contains "2h since midnight UTC" "$r" "2.0h used of 500.0h"

echo "6. at the cap: an ON-DEMAND machine is stopped, gracefully, and told"
r=$(case_ 'w.MAX_HOURS_MONTH = 2; ssm = SSM({"done": 3600*2, "open": {}}); ec2 = EC2([inst(age=10)])')
check "stopped for the month" "$(field 1 "$r")" "stop:monthly"
contains "a plain stop, not forced" "$(field 2 "$r")" "stop:i-a"
contains "the person is told" "$(field 2 "$r")" "notify:This month's play time is used up"

echo "7. at the cap: a SPOT machine is terminated"
r=$(case_ 'w.MAX_HOURS_MONTH = 2; ssm = SSM({"done": 3600*2, "open": {}}); ec2 = EC2([inst(spot=True)])')
check "terminated" "$(field 1 "$r")" "terminate:monthly"

echo "8. extra hours for the month lift the cap"
r=$(case_ 'w.MAX_HOURS_MONTH = 2; ssm = SSM({"done": 3600*2, "open": {}}, extra=5); ec2 = EC2([inst(age=10)])')
check "left alone" "$(field 1 "$r")" "-"
contains "cap is 2 + 5" "$r" "of 7.0h"

echo "9. 30 minutes before the cap: warned once, and the warning is remembered"
r=$(case_ 'w.MAX_HOURS_MONTH = 2; ssm = SSM({"done": 3600*2 - 1800 - 600, "open": {}}); ec2 = EC2([inst(age=10)])')
contains "warned" "$(field 2 "$r")" "notify:30 minutes of play left this month"
contains "remembered" "$(field 3 "$r")" '"warned": true'
r=$(case_ 'w.MAX_HOURS_MONTH = 2; ssm = SSM({"done": 3600*2 - 1800 - 600, "open": {}, "warned": True}); ec2 = EC2([inst(age=10)])')
check "not warned twice" "$(field 2 "$r")" "-"

echo "10. no machine running: nothing is ended, the ended run is still filed"
r=$(case_ 'w.MAX_HOURS_MONTH = 2; ssm = SSM({"done": 3600*5, "open": {"i-a@x": 60}})')
check "nothing ended" "$(field 1 "$r")|$(field 2 "$r")" "-|-"
contains "filed as done" "$(field 3 "$r")" '"done": 18060.0'

echo "11. an unreadable usage mark is an ERROR, never zero hours"
r=$(case_ 'w.MAX_HOURS_MONTH = 2; ssm = SSM("{not json"); ec2 = EC2([inst()])')
check "raised" "$(field 1 "$r")" "RAISED"
contains "says it was not enforced" "$r" "not enforced this run"

echo "12. SSM failing does not stop the SESSION limit working"
r=$(case_ 'w.MAX_HOURS_MONTH = 2; w.MAX_SESSION_HOURS = 1; ssm = SSM(fails=True); ec2 = EC2([inst(age=61)])')
check "raised" "$(field 1 "$r")" "RAISED"
contains "but the session was still ended" "$(field 2 "$r")" "stop:i-a"

echo "13. session limit: under it, left alone; past it, ended"
r=$(case_ 'w.MAX_SESSION_HOURS = 4; ec2 = EC2([inst(age=60)])')
check "left alone, no mark written" "$(field 1 "$r")|$(field 2 "$r")|$(field 3 "$r")" "-|-|none"
r=$(case_ 'w.MAX_SESSION_HOURS = 4; ec2 = EC2([inst(age=241)])')
check "ended" "$(field 1 "$r")" "stop:session"
contains "told" "$(field 2 "$r")" "notify:Session time limit reached"

echo "14. session warning 30 minutes before, once per deadline"
r=$(case_ 'w.MAX_SESSION_HOURS = 4; ec2 = EC2([inst(age=220)])')
contains "warned" "$(field 2 "$r")" "notify:Game PC switches off in 20 minutes"
contains "deadline tagged" "$(field 2 "$r")" "tag:ayis-session-warned=2026-11-20T12:20:00Z"
r=$(case_ 'w.MAX_SESSION_HOURS = 4; ec2 = EC2([inst(age=220, tags=[{"Key": "ayis-session-warned", "Value": "2026-11-20T12:20:00Z"}])])')
check "not twice" "$(field 2 "$r")" "-"

echo "15. an extended session runs to its new end"
r=$(case_ 'w.MAX_SESSION_HOURS = 4; ec2 = EC2([inst(age=300, tags=[{"Key": "ayis-session-until", "Value": "2026-11-20T13:00:00Z"}])])')
check "left alone" "$(field 1 "$r")|$(field 2 "$r")" "-|-"
echo "15b. an extension EARLIER than the limit does not shorten it"
r=$(case_ 'w.MAX_SESSION_HOURS = 4; ec2 = EC2([inst(age=60, tags=[{"Key": "ayis-session-until", "Value": "2026-11-20T11:30:00Z"}])])')
check "left alone" "$(field 1 "$r")" "-"
echo "15c. a garbled extension is ignored, not obeyed"
r=$(case_ 'w.MAX_SESSION_HOURS = 4; ec2 = EC2([inst(age=241, tags=[{"Key": "ayis-session-until", "Value": "forever"}])])')
check "ended" "$(field 1 "$r")" "stop:session"

echo "16. budget spent (its block policy attached): every running machine ends"
r=$(case_ 'w.BLOCK_POLICY_ARN = "arn:x"; iam = IAM(attached=True); ec2 = EC2([inst("i-a"), inst("i-b", spot=True)])')
check "both ended" "$(field 1 "$r")" "stop:budget,terminate:budget"
contains "told" "$(field 2 "$r")" "notify:Monthly budget used up"
echo "16b. not attached, or the policy not made yet: left alone"
r=$(case_ 'w.BLOCK_POLICY_ARN = "arn:x"; iam = IAM(); ec2 = EC2([inst()])')
check "left alone" "$(field 1 "$r")" "-"
r=$(case_ 'w.BLOCK_POLICY_ARN = "arn:x"; iam = IAM(missing=True); ec2 = EC2([inst()])')
check "left alone" "$(field 1 "$r")" "-"

echo "17. a dry run ends nothing and writes nothing"
r=$(case_ 'dry = True; w.MAX_HOURS_MONTH = 2; w.MAX_SESSION_HOURS = 1; ssm = SSM({"done": 3600*9, "open": {}}); ec2 = EC2([inst(age=120)])')
check "would stop" "$(field 1 "$r")" "would-stop:monthly"
check "no calls, mark unchanged" "$(field 2 "$r")|$(field 3 "$r")" '-|{"done": 32400, "open": {}}'

echo "18. a machine still starting is counted but not ended until it runs"
r=$(case_ 'w.MAX_SESSION_HOURS = 1; ec2 = EC2([inst(age=120, state="pending")])')
check "left for the next run" "$(field 1 "$r")|$(field 2 "$r")" "-|-"

echo "19. AWS not answering: an error, not all clear"
r=$(case_ 'w.MAX_SESSION_HOURS = 1; ec2 = EC2(fails=True)')
check "raised" "$(field 1 "$r")" "RAISED"

echo; echo "passed $pass, failed $fail"; [[ $fail -eq 0 ]]
