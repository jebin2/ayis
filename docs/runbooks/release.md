# Cutting a release

A release is cut by pushing a tag; the only thing done by hand is pressing **Publish**.

1. **main is green.** The Tests and Lint workflows passed on the commit you will tag:
   `gh run list --branch main --limit 4`.
2. **Tag it.** A suffix makes a pre-release:

       git tag v0.1.0-beta.5 && git push origin v0.1.0-beta.5

3. **The Desktop Release workflow does the rest**, in order, and stops at the first failure:
   every test suite; the Linux, macOS and Windows builds (the AppImage held to its size budget,
   [docs/performance.md](../performance.md)); `SHA256SUMS`; build provenance for every file; and a
   **draft** release whose notes are `.github/release-body.md` followed by one line per commit
   since the previous tag (`tools/ci/release-notes.sh`).
4. **Read the draft** on GitHub - the files, the notes, the pre-release tick - and press
   **Publish**.
5. **Check one download** the way a person would: `sha256sum -c --ignore-missing SHA256SUMS`
   and `gh attestation verify <file> --repo jebin2/ayis`.

A tag that failed: fix on main, delete the tag (`git push --delete origin <tag>; git tag -d <tag>`),
and tag the fixed commit. A draft that is wrong is deleted from the Releases page; nothing
reached anyone.

The cloud watchdog is not released with the app: each person's ayis deploys it to their own
account, at its next build or `ayis watchdog install`, and the Safety page offers the update.
