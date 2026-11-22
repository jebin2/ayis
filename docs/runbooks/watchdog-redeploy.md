# Redeploying the cloud watchdog

When: `ayis doctor` or the Safety page says the cloud watchdog is **not running**, **late** (no
check finished cleanly for 15 minutes), **disabled**, or **from an older version of ayis**.

1. **See why**: `./ayis watchdog` - its state, what drifted, and its last decision.
   `./ayis watchdog logs` shows the last three hours of what it decided.
2. **Redeploy**: `./ayis watchdog install`. It repairs every piece that drifted - the role, its
   policy, the log group, the function, both schedules - and proves the function can act on your
   account with a dry run. Idempotent: running it twice changes nothing the second time.
   A function rolled back on purpose is left alone; `--force` replaces it.
3. **Confirm**: `./ayis doctor`. Within 5 minutes the cloud watchdog line should say "running every
   5 minutes"; its last good run is recorded after each check.
4. **Still late?** The schedule runs it but each run fails. `./ayis watchdog logs` names the
   failure - usually a permission (the dry run in step 2 says which), or AWS refusing calls.
   If the bad state came with a new deploy, [roll it back](rollback.md).

Costs nothing: the function, its schedule and its log stay inside AWS's free tier.
