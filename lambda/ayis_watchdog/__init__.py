"""Layer 3: the cloud watchdog. An AWS Lambda, run every 5 minutes by an
EventBridge rule, that ends a game instance nobody is using.

It exists for the cases the other layers cannot cover:
  - the on-host watchdog dies with the box it protects - a wedged instance
    takes its own watchdog with it
  - nothing else watches from outside the box, in a session or out of one

It runs inside the account on an IAM role, so no long-lived key exists for it
anywhere, and there is no second machine to keep alive.

It KEEPS NO STATE. It reads the last 30 minutes of metrics on every run and
decides from those rather than counting idle checks, so a missed or repeated
invocation cannot corrupt a counter, and a dry run changes nothing.

It never pulls the plug first. Terminating (spot) or stopping (on demand)
through the API is a GRACEFUL OS shutdown, which is where the box mirrors its
games to S3 (ayis-library-shutdown.service, up to 30 minutes). Only an instance
still stuck going down an hour later is forced, whichever guard started it.

Every decision is printed with the numbers behind it, prefixed "ayis-watchdog:",
which is what `ayis watchdog logs` filters on.

The checks, one module each, run in this order by handler.run_all:

  limits   the hard limits - month hours, session length, a spent budget
  idle     a running box nobody uses, and a shutdown that is stuck
  stopped  an on-demand box left stopped for the days games are kept
  archive  the saved games, once no box has existed for those days
           (games: one game at a time, in every bucket this host owns)

events answers EC2's own state-change events ("the box really is gone");
notify sends a phone message; aws holds the EC2 and SSM calls they share;
settings is everything ayis configured the function with.

It ships as one zip of this package (internal/watchdog.Zip); the handler is
ayis_watchdog.handler.handler.
"""
