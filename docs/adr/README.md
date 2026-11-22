# Architecture decision records

One file per decision that shapes ayis: what was decided, why, and what it costs. A decision
is recorded the day it is made, and a record is never edited to say something else later - a
changed mind is a new record that **supersedes** the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-decisions.md) | Record decisions as ADRs | Accepted |
| [0002](0002-account-settings-live-in-the-account.md) | Account settings live in the account | Accepted |
| [0003](0003-renderer-scripts-not-modules.md) | The renderer stays ordered scripts, with its shared scope checked | Accepted |
| [0004](0004-public-ntfy-topic-by-default.md) | A public ntfy topic by default, with a warning and an optional token | Accepted |
| [0005](0005-unsigned-builds.md) | macOS and Windows builds stay unsigned for now | Accepted |

New record: copy [template.md](template.md) to the next number, fill it in, add a row above.
