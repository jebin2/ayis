"""The phone messages are for a person, not for a log: no instance ids, setting
names, AWS service names or commands in what ntfy shows. The log lines beside
each call keep all of that. (tests/notification-words.sh checks the box's own.)"""
import ast
import pathlib
import re

from ayis_watchdog import limits

BAD = re.compile(r"S3|EC2|GAME_[A-Z_]+|instance|mirror|\bayis (init|destroy|check|open)|\bi-[0-9a-f]|OS shutdown|compute")
PACKAGE = pathlib.Path(__file__).parent.parent / "ayis_watchdog"


def strings(node: ast.AST) -> str:
    return " ".join(c.value for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str))


def messages() -> list[tuple[str, str]]:
    """(where, words) for the title and text of every notify() call."""
    out = []
    for f in sorted(PACKAGE.glob("*.py")):
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "notify":
                out.append(("%s:%d" % (f.name, node.lineno), " ".join(strings(a) for a in node.args[:2])))
    return out


def test_every_notification_is_found():
    # A rename that hid the calls from this test would pass it with nothing checked.
    assert len(messages()) >= 15


def test_no_notification_speaks_like_a_log():
    assert [(where, text[:100]) for where, text in messages() if BAD.search(text)] == []


def test_nor_does_a_limit_ending_the_machine():
    assert [k for k, (title, body) in limits.ENDED.items() if BAD.search(title + " " + body)] == []
