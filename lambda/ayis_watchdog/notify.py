"""Phone messages, through ntfy."""
import urllib.request

from . import settings
from .common import say


def send(url: str, title: str, message: str, priority: str, tags: str) -> None:
    req = urllib.request.Request(url, data=message.encode("utf-8"), method="POST",
                                 headers={"Title": title, "Priority": priority, "Tags": tags})
    with urllib.request.urlopen(req, timeout=5) as resp:
        resp.read()


def notify(title: str, message: str, priority: str = "default", tags: str = "") -> bool:
    """Words for a person, not for a log: the title says what happened, the message
    whether the games are safe and what it costs. No instance ids, setting names or
    AWS service names - the log lines next to each call keep those. Priority is
    kept for what costs money or loses games: the rest is "low", which shows up
    without buzzing the phone.

    Best effort. A notification that cannot be sent is logged and ignored: it
    must never change what a guard decides or does."""
    if not settings.NTFY_URL:
        return False
    try:
        send(settings.NTFY_URL, title, message, priority, tags)
        return True
    except Exception as exc:
        say("notification not sent (ignored): %s" % exc)
        return False
