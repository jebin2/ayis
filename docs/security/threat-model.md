# Threat model

What ayis holds that is worth taking, who can reach each piece, and what stops them. ayis is a
desktop tool for one person, driving their own AWS account; there is no ayis server and no ayis
account. So the attacker worth planning for is not "someone breaks into ayis" but:

- **A. Someone who gets a copy of a file on your laptop** - a stolen or shared laptop, a backup, a
  synced folder, a support chat where `.env` was pasted.
- **B. Someone on the internet who learns a name** - an ntfy topic, a bucket name, an IP address.
- **C. Someone who can read this public repository** - the code, its history, its releases.
- **D. Code ayis runs that is not ayis's** - a dependency, a downloaded binary, a compromised release.

Out of scope: an attacker who already controls your laptop as you (they have everything you have),
and AWS itself.

## Assets

| Asset | Where it lives | Reachable by | Controls | Gaps |
|---|---|---|---|---|
| **AWS access key** - rents GPUs on your bill | `~/.aws/credentials` (written by `aws configure` or `ayis creds set`) | A | File is yours (0600 by the AWS CLI); the AWS budget emails at 80% and **blocks new machines at 100%** (`ayis limits`); hard limits on hours | An administrator key is more than ayis needs: `ayis aws policy` prints the exact policy, checked against the code ([how](../aws-account-setup.md#a-key-that-can-do-only-what-ayis-does)) |
| **Tailscale auth key and API token** - join or manage your tailnet | The system keychain (`.env` holds `@keychain`); `.env` (0600) where there is none | A | Kept in the OS store when it answers (moved there on the first run); auth keys are single-use and expire; the API token is optional | Plain text in `.env` on a computer with no keychain (a server), or with `AYIS_NO_KEYCHAIN=1` |
| **SSH key for the box** | `~/.ssh/<host>.pem` (0600) | A | The box has **no inbound SSH** from the internet - only Tailscale's UDP port is open; SSH works only over the tailnet | - |
| **Sunshine (streaming) login** | The system keychain (as above), and the box | A | Sunshine listens on the tailnet only | As above |
| **Steam login token** | The box's disk; archived as `steam-account.tgz` in S3 | A (via the AWS key) | Bucket: private, all public access blocked, encrypted at rest (SSE-S3); the box's own role reaches only its bucket | Anyone with your AWS key can read it - protect the key |
| **Saved games** | S3 bucket `ayis-library-<hash>` | A (via the AWS key), B (by name) | As above; the name is a hash, but a name alone gives nothing - no public access | - |
| **ntfy topic and token** - your alerts, which carry costs | The system keychain (the token) and `.env` (the topic); your account's SSM settings; the watchdog's environment; the box's `/etc/ayis-notify.conf` (0600) | **B** (a public topic is readable by anyone who knows its name), A | Topic is long and random; optional access token (`GAME_NTFY_TOKEN`); the app warns about a public topic ([ADR-0004](../adr/0004-public-ntfy-topic-by-default.md)) | Public by default - a choice, not an oversight |
| **The cloud watchdog** - can stop and delete your machines and games | Lambda + IAM role in your account | (none outside AWS) | Its role may end only instances tagged with your host, tag only with its own keys (tested against the code), and touch only ayis's buckets and SSM path | - |
| **This repository and its releases** | GitHub | C, D | gitleaks scans every push's whole history and blocks; `tests/secrets-guard.sh` checks key shapes and the owner's own identifiers (`GUARD_EXTRA`); releases carry `SHA256SUMS` and GitHub build provenance; dependencies are checked weekly (govulncheck, npm audit) | macOS and Windows builds are **unsigned** ([ADR-0005](../adr/0005-unsigned-builds.md)) |

## Secrets on your computer

`TAILSCALE_API_KEY`, `TAILSCALE_AUTH_KEY`, `SUNSHINE_PASS` and `GAME_NTFY_TOKEN` are kept in the
operating system's own store - Secret Service (GNOME Keyring, KWallet) on Linux, Keychain on macOS,
Credential Manager on Windows - and `.env` holds `@keychain` in their place. The first run with a
store that works moves them; a computer with none keeps them in `.env` (readable by you alone), as
before. A `.env` copied to another computer does not carry them: ayis says which it could not read,
and they are set again there. The AWS key stays in `~/.aws`, which the AWS CLI owns.

## What the box exposes

The game PC's security group opens one port: **UDP 41641**, Tailscale's direct path. Tailscale
traffic is end-to-end encrypted and an unauthenticated peer gets nowhere. SSH, Sunshine and
everything else are reached over the tailnet only. `ayis status` lists the inbound rules, so a
rule added by hand shows up.

## Code ayis runs that is not ayis's

- Go modules and npm packages: pinned by `go.sum` and `package-lock.json`; advisories checked
  weekly and on every push to main (`.github/workflows/security.yml`).
- Tools downloaded in CI (gitleaks) are pinned and checksum-verified.
- On the box: Ubuntu packages, the NVIDIA driver, Sunshine, Steam and Moonlight's builds come from
  their publishers over HTTPS.

## Reporting a problem

See [SECURITY.md](../../SECURITY.md).

## Revisit when

- Anyone other than the owner uses a build (then: signing, and a review of every default).
- ayis gains a server, an account, or shared machines.
- A new secret is added to `.env` - it belongs in the table above.
