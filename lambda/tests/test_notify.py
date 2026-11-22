"""The phone message itself: what is sent, and how a protected topic is reached."""
import urllib.request

from ayis_watchdog import notify, settings


class Resp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b""


REAL = notify.send


def test_a_public_topic_sends_no_authorization(monkeypatch):
    got = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: got.append(req) or Resp())
    REAL("https://ntfy.sh/t", "Title", "Body", "high", "warning")
    assert got[0].get_header("Title") == "Title"
    assert got[0].get_header("Authorization") is None


def test_a_protected_topic_sends_its_token(monkeypatch):
    got = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: got.append(req) or Resp())
    settings.NTFY_TOKEN = "tk_test"
    REAL("https://ntfy.sh/t", "Title", "Body", "high", "warning")
    assert got[0].get_header("Authorization") == "Bearer tk_test"
