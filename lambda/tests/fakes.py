"""What every watchdog test shares: the calls the fakes record, an AWS error
with a code, and the clock and capture helpers."""
import contextlib
import io
from collections.abc import Callable
from typing import Any

# Each fake appends what it was asked to do; conftest empties it before a test.
calls: list[str] = []
# The phone messages sent, in order.
sent: list[str] = []
# Set by a test to make the next notification fail to send.
send_fails = [False]


class AwsError(Exception):
    def __init__(self, code: str, msg: str = ""):
        super().__init__(msg or code)
        self.response = {"Error": {"Code": code}}


def fake_send(url: str, title: str, message: str, priority: str, tags: str) -> None:
    if send_fails[0]:
        raise Exception("network down")
    calls.append("notify:" + title)
    sent.append(message)


def joined() -> str:
    return ",".join(calls) or "-"


def capture(fn: Callable[[], Any]) -> tuple[Any, str]:
    """Runs fn, returning (its result or "RAISED", the log it printed on one line).
    An exception is logged as "error: ..." the way the old harness did."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            res = fn()
        except Exception as e:
            res = "RAISED"
            print("error: %s" % e)
    return res, buf.getvalue().replace("\n", " / ").strip()
