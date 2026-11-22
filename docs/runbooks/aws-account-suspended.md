# The AWS account is suspended

What it looks like: every AWS call fails with `InvalidClientTokenId` - with every key you have,
including one that worked yesterday. `ayis doctor` says AWS refused the key.

Before rotating keys or debugging ayis, **open the AWS console as the root user** and look at the
account's status. This happened once (2026-09-26 to 2026-10-09, "account details couldn't be
verified"); everything below is what it taught.

## While it is suspended

- **Send verification documents only through the one-time secure link AWS emails.** Documents
  attached to a support case are removed before the team that decides sees them - that cost ten
  days. The link expires two hours after the upload starts; only the root user can ask for a
  new one; a submission cannot be replaced. Remove a PDF's password first (`qpdf --decrypt`).
  The only receipt is AWS's "Documents Received" email listing the files.
- Name the irreversible deadline in the case (the saved games' expiry, below). A public post to
  @AWSSupport got a case that sat unassigned looked at; asking for a supervisor did not.

## What a suspension takes, and what it leaves

- **Gone:** the machine and every disk (no snapshots, whatever the email says), and the cloud
  watchdog's function.
- **Kept:** the saved games in S3, credits, quotas, the key pair, the security group, the IAM
  roles - and your access keys, which work again once the account is back. No rotation needed.

## When it is back - in this order

1. `./ayis doctor` - the key is accepted again.
2. **Before anything else**, move the saved games' countdown: the watchdog deletes them after
   `GAME_ARCHIVE_EXPIRY_DAYS` (14) with no machine, and its last-seen mark outlived the suspension.
   A watchdog redeployed after a long suspension can delete the games within the hour. Set the
   mark to now:

       aws ssm put-parameter --overwrite --type String \
         --name /ayis/<host>/archive-last-seen --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

   or set `GAME_ARCHIVE_EXPIRY_DAYS=0` until you have played once.
3. `./ayis watchdog install` - recreates the function ([watchdog-redeploy.md](watchdog-redeploy.md)).
4. Build as usual: Play, or `./ayis init`.
