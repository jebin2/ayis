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
| [0006](0006-tailscale-is-the-only-way-in.md) | Tailscale is the only way in | Accepted |
| [0007](0007-stream-from-a-gpu-with-no-screen.md) | Stream from a GPU that has no screen | Accepted |
| [0008](0008-two-watchdogs-no-cloudwatch-alarm.md) | Two watchdogs, and no CloudWatch alarm | Accepted |
| [0009](0009-a-stateless-lambda-watchdog.md) | The cloud watchdog is a stateless Lambda | Accepted |
| [0010](0010-every-guard-ends-in-one-graceful-shutdown.md) | Every guard ends in the same graceful shutdown | Accepted |
| [0011](0011-cost-first.md) | Cost first: design out what would bill | Accepted |
| [0012](0012-games-on-local-nvme-kept-in-s3.md) | Games on local NVMe, kept in S3 - and Proton is not | Accepted |
| [0013](0013-one-time-spot-that-terminates.md) | Spot machines terminate; on-demand ones stop | Accepted |
| [0014](0014-the-archive-expires-and-errs-towards-keeping.md) | The archive expires, and errs towards keeping | Accepted |
| [0015](0015-roles-not-keys.md) | Roles, not keys | Accepted |
| [0016](0016-tailscale-through-its-api.md) | Tailscale through its API | Accepted |
| [0017](0017-notifications-are-never-load-bearing.md) | Notifications are never load-bearing | Accepted |
| [0018](0018-init-ends-with-a-summary.md) | `ayis init` ends with a summary, not chores | Accepted |
| [0019](0019-ubuntu-not-nixos.md) | The box runs Ubuntu, not NixOS | Accepted |
| [0020](0020-no-new-game-at-build.md) | No new game at build time | Accepted |
| [0021](0021-the-box-is-found-by-its-tag.md) | The box is found by its tag, not by `.env` | Accepted |
| [0022](0022-hard-limits-enforced-by-the-watchdog.md) | Hard limits are enforced by the cloud watchdog | Accepted |

New record: copy [template.md](template.md) to the next number, fill it in, add a row above.
