"""EC2's own events, from the second EventBridge rule: an instance finished
stopping or terminating, or AWS is taking a spot instance back. They answer "is
the box really gone", not "is it idle"."""
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from . import settings
from .archive import archive_look, archive_note, archive_words, mark_gone
from .common import Inst, error_code, say
from .notify import notify


def state_changed(ec2: Any, event: dict[str, Any], cw: Any = None, now: datetime | None = None, ssm: Any = None,
                  s3: Any = None, sleep: Callable[[float], None] | None = None) -> dict[str, str]:
    """An instance finished stopping or terminating. The box cannot report its own
    end - by then it is gone - so this is the notification that says it really is,
    however it ended: a watchdog, ayis destroy, a spot interruption, the console.
    EventBridge sends every instance in the region, so only this host's counts."""
    detail = event.get("detail") or {}
    iid = detail.get("instance-id", "")
    state = "interruption" if event.get("detail-type") == settings.SPOT_EVENT else detail.get("state", "")
    # The rule delivers every state change; only an end, or a spot warning, matters.
    if not iid or state not in ("stopped", "terminated", "interruption"):
        return {"state": "ignored"}
    try:
        resp = ec2.describe_instances(InstanceIds=[iid])
    except Exception as exc:
        say("%s %s, but it could not be described - not notified: %s" % (iid, state, exc))
        return {"state": "unknown"}
    names = [t.get("Value") for r in resp.get("Reservations", []) for i in r.get("Instances", [])
             for t in i.get("Tags", []) if t.get("Key") == "Name"]
    if settings.TS_HOST not in names:
        return {"state": "not-ours"}
    now = now or datetime.now(timezone.utc)
    if state in ("terminated", "stopped"):
        mark_gone(ssm, now)
    if state == "interruption":
        say("%s spot interruption warning - AWS reclaims it in about 2 minutes" % iid)
        notify("AWS is taking your game PC back",
               "You have about 2 minutes. Games you installed in the last few minutes may not be saved.",
               "urgent", "warning")
    elif state == "terminated":
        # "No longer bills" was half true while the games sit in S3, so say what still does.
        look = archive_look(cw, now)
        say("%s terminated - compute no longer bills.%s" % (iid, archive_note(look, now)))
        notify("Game PC removed",
               "The charge for the PC has stopped.%s" % archive_words(look), "low", "white_check_mark")
    else:
        inst = (resp.get("Reservations") or [{}])[0].get("Instances", [{}])[0]
        drop_games_disk(ec2, s3, inst, sleep)
        look = archive_look(cw, now)
        say("%s stopped - compute no longer bills, its disk still does.%s" % (iid, archive_note(look, now)))
        notify("Game PC is off",
               "The charge for the PC has stopped. A small storage charge continues until you start it "
               "again or delete it.%s" % archive_words(look), "low", "white_check_mark")
    return {"state": state, "instance": iid}


def drop_games_disk(ec2: Any, s3: Any, inst: Inst, sleep: Callable[[float], None] | None = None) -> str:
    """After the machine stopped ITSELF - the idle watchdog's shutdown - its games
    disk goes too, once the games are saved: an idle stop otherwise left the disk
    billing every month with nobody deciding anything. Only then:

      - the stop was the machine's own ("InstanceInitiatedShutdown"), not a person's
        Stop machine, whose own choice about the disk stands;
      - the machine has a games disk;
      - Saved games holds a complete save made after this machine last started -
        the marker ayis-library writes only when it saved everything. No marker, or
        an older one, and the disk is kept: something on it may not be saved.
    """
    sleep = sleep or time.sleep
    iid = inst.get("InstanceId", "")
    if "InstanceInitiatedShutdown" not in (inst.get("StateTransitionReason") or ""):
        return "not-an-idle-stop"
    vol = next((m.get("Ebs", {}).get("VolumeId") for m in inst.get("BlockDeviceMappings", [])
                if m.get("DeviceName") == settings.GAMES_DISK_DEVICE and m.get("Ebs")), None)
    if not vol:
        return "no-games-disk"
    if s3 is None or not settings.BUCKET:
        say("%s stopped by itself; its games disk %s is kept - Saved games cannot be checked here" % (iid, vol))
        return "unchecked"
    try:
        marker = s3.head_object(Bucket=settings.BUCKET, Key=settings.PREFIX + "/pushed.json")
    except Exception as exc:
        say("%s stopped by itself; its games disk %s is kept - no complete save in Saved games (%s)"
            % (iid, vol, error_code(exc) or exc))
        return "not-saved"
    launched, saved = inst.get("LaunchTime"), marker.get("LastModified")
    if not launched or not saved or saved < launched:
        say("%s stopped by itself; its games disk %s is kept - the last complete save is older than this run" % (iid, vol))
        return "not-saved"
    try:
        ec2.detach_volume(VolumeId=vol, InstanceId=iid)
        for _ in range(40):
            v = ec2.describe_volumes(VolumeIds=[vol]).get("Volumes", [{}])[0]
            if v.get("State") == "available":
                break
            sleep(3)
        else:
            say("%s: games disk %s did not come free - kept" % (iid, vol))
            return "kept"
        ec2.delete_volume(VolumeId=vol)
    except Exception as exc:
        say("%s: could not delete the games disk %s - kept: %s" % (iid, vol, exc))
        return "kept"
    say("%s stopped by itself after its games were saved; games disk %s deleted" % (iid, vol))
    notify("Games disk deleted",
           "Your game PC stopped after being idle and its games were saved, so the games disk "
           "was deleted to stop its charge. Play brings your games back.", "low", "white_check_mark")
    return "deleted"
