# Rolling back

## The app

Releases are never edited. To undo a bad one, publish the previous good one again as the
newest: tag the good commit with a new, higher version (`v0.1.0-beta.6` on the commit of
`beta.4`) and follow [release.md](release.md). Mark the bad release as a pre-release or delete it
on GitHub so nobody downloads it.

## The cloud watchdog

Every time `ayis watchdog install` changes the function, it first keeps what was running as a
Lambda version - the last 3 are kept, free. To put the last one back:

    ./ayis watchdog rollback

It restores that deploy's code and settings, and marks the function as rolled back. From then on
a build's install leaves it alone - it is there because you chose it - and the Safety page says
so. To put the current version back:

    ./ayis watchdog install --force

Check either way with `./ayis doctor`: the cloud watchdog line says whether it runs and whether
its last check finished cleanly.
