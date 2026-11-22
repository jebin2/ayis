# Security

ayis drives your own AWS account from your own computer. There is no ayis server and no ayis
account, so a problem is almost always in what ayis does on your machine or in your AWS account.
What ayis protects, and how, is in [docs/security/threat-model.md](docs/security/threat-model.md).

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private report instead:
the repository's **Security** tab, then **Report a vulnerability**. Say what you found, how to
reproduce it, and what it lets someone do.

You will get an answer within a week. A fix ships in the next release, and the report is credited
unless you ask otherwise.

## Supported versions

Only the latest release is supported. ayis is in beta; fixes are not backported.

## What you can check yourself

- Every release has a `SHA256SUMS` file: `sha256sum -c --ignore-missing SHA256SUMS`.
- Every release file has a build provenance attestation:
  `gh attestation verify <file> --repo jebin2/ayis`.
- macOS and Windows builds are not code-signed ([why](docs/adr/0005-unsigned-builds.md)).
