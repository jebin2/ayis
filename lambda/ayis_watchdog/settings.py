"""What ayis configured the function with, read once from its environment, and
the names it writes on instances. Other modules read these as settings.NAME at
call time, never with from-imports, so a test can change one for a case.
"""
import os

TS_HOST = os.environ.get("AYIS_TS_HOST", "ayis")
IDLE_MINUTES = int(os.environ.get("AYIS_IDLE_MINUTES", "30"))
BOOT_GRACE_MINUTES = int(os.environ.get("AYIS_BOOT_GRACE_MINUTES", "20"))
STUCK_MINUTES = int(os.environ.get("AYIS_STUCK_MINUTES", "60"))
# Bytes in + out per 5-minute period that count as use. Streaming at 20 Mbps
# moves ~750 MB a period, so 10 MB is comfortably idle.
THRESHOLD = int(os.environ.get("AYIS_THRESHOLD_BYTES", "10485760"))
PERIOD = 300
# Written on an instance going down with no timestamp in its state reason (an
# in-guest `shutdown -h`), so the next run can tell how long it has been stuck.
SINCE_TAG = "ayis-going-down-since"
# Notifications about one shutdown, recorded on the instance so each is sent once.
# Their value starts with when that shutdown began, so an earlier one never counts.
SLOW_MINUTES = 30
SLOW_TAG = "ayis-slow-noted"
FORCED_TAG = "ayis-forced"
# When a stopped box was first seen stopped, where AWS did not timestamp the stop,
# and the stop a warning of its deletion was sent for - so it is sent once.
STOPPED_SINCE_TAG = "ayis-stopped-since"
STOPPED_WARNED_TAG = "ayis-stopped-warned"

STATE_EVENT = "EC2 Instance State-change Notification"
SPOT_EVENT = "EC2 Spot Instance Interruption Warning"

# Archive expiry, in days with no box. 0 turns it off.
BUCKET = os.environ.get("AYIS_BUCKET", "")
# Where ayis-library keeps the archive inside the bucket: its "everything is saved"
# marker is <PREFIX>/pushed.json.
PREFIX = os.environ.get("AYIS_PREFIX", "steam")
# The games disk ayis adds beside the machine's own drive.
GAMES_DISK_DEVICE = "/dev/sdg"
# The account, so this host's OTHER buckets can be recognised by name: a region
# move leaves games in a bucket nothing points at, billing until someone looks.
# Unset, only BUCKET is ever touched - which is how it worked before.
ACCOUNT = os.environ.get("AYIS_ACCOUNT", "")
EXPIRY_DAYS = int(os.environ.get("AYIS_ARCHIVE_EXPIRY_DAYS", "0") or 0)


# The expiry check's marks are SSM Parameter Store standard parameters - which cost
# nothing - under /ayis/<host>/, not bucket tags, which are billed S3
# requests. Whether an archive exists comes from S3's free daily size metric.
# AWS's S3 price and the rupee rate (GST included), as ayis had them when it
# deployed this - never a number written here. Either missing, the archive is
# described by its size alone.
def _rate(k: str) -> float | None:
    try:
        return float(os.environ[k])
    except (KeyError, ValueError):
        return None


S3_USD_PER_GB = _rate("AYIS_S3_USD_GB_MONTH")
INR_PER_USD = _rate("AYIS_INR_PER_USD")
# An on-demand hour of the machine type ayis builds, in USD, for the cost in a
# limit's notification. A spot hour is asked of AWS instead (free), since it moves.
OD_USD_HOUR = _rate("AYIS_OD_USD_HOUR")

# HARD LIMITS. The idle guards end a machine nobody uses; these end one somebody
# IS using, because cost has to have a ceiling that does not depend on anybody
# remembering to stop. Each is 0 (off) unless ayis passed it.
#   MAX_HOURS_MONTH    machine hours in a calendar month (UTC, as AWS bills it)
#   MAX_SESSION_HOURS  hours one run of the machine may last
#   BLOCK_POLICY_ARN   the deny policy the AWS budget attaches when it is spent:
#                      attached anywhere means the budget is used up
MAX_HOURS_MONTH = int(os.environ.get("AYIS_MAX_HOURS_MONTH", "0") or 0)
MAX_SESSION_HOURS = int(os.environ.get("AYIS_MAX_SESSION_HOURS", "0") or 0)
BLOCK_POLICY_ARN = os.environ.get("AYIS_BLOCK_POLICY_ARN", "")
# A warning this long before a limit ends the machine, sent once per deadline.
LIMIT_WARN_MINUTES = 30
# Written by `ayis limits extend-session`: the session may run until this time.
SESSION_UNTIL_TAG = "ayis-session-until"
SESSION_WARNED_TAG = "ayis-session-warned"

# ntfy push notifications. Off unless ayis passed a URL.
NTFY_URL = os.environ.get("AYIS_NTFY_URL", "")
# An access token for a protected topic (GAME_NTFY_TOKEN); "" for a public one.
NTFY_TOKEN = os.environ.get("AYIS_NTFY_TOKEN", "")
# A launch history longer than this is treated as unreadable, not as empty.
TRAIL_PAGES = 40
DELETE_ROUNDS = 1000


def limits_on() -> bool:
    """Whether any hard limit is set."""
    return bool(MAX_HOURS_MONTH or MAX_SESSION_HOURS or BLOCK_POLICY_ARN)
