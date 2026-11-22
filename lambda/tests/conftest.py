"""Every test starts from the same settings and empty records, and no test can
send a real notification."""
from collections.abc import Iterator

import fakes
import pytest

from ayis_watchdog import notify, settings

# What each test starts from. A test module's own fixture changes what its old
# Bash harness changed; a test changes one more for its case.
BASE = {
    "TS_HOST": "ayis", "IDLE_MINUTES": 30, "BOOT_GRACE_MINUTES": 20, "STUCK_MINUTES": 60,
    "THRESHOLD": 10485760, "BUCKET": "", "PREFIX": "steam", "ACCOUNT": "", "EXPIRY_DAYS": 0,
    # What ayis passes at deploy: the Lambda holds no price of its own.
    "S3_USD_PER_GB": 0.025, "INR_PER_USD": 88.0, "OD_USD_HOUR": None,
    "MAX_HOURS_MONTH": 0, "MAX_SESSION_HOURS": 0, "BLOCK_POLICY_ARN": "",
    "NTFY_URL": "", "NTFY_TOKEN": "", "TRAIL_PAGES": 40,
}


@pytest.fixture(autouse=True)
def fresh(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for k, v in BASE.items():
        monkeypatch.setattr(settings, k, v)
    monkeypatch.setattr(notify, "send", fakes.fake_send)
    fakes.calls.clear()
    fakes.sent.clear()
    fakes.send_fails[0] = False
    yield
