# MR-2026-11-19-4 · Schedules attention

Board #710. Both Schedules panels put failed jobs first, followed by stuck runs, overdue jobs, then healthy jobs in their previous order. Each panel has one initially collapsed **Paused (N)** group. Its open state survives refresh.

Each panel header shows its job total followed by counts such as **1 failing - 1 stuck - 2 overdue**. Zero categories disappear. A healthy panel shows only its total. The page summary retains the separate 24-hour failure history.

Both job APIs return `attention` evaluated at read time. Disabled jobs return `null`. An enabled job with a failure or error status returns `failed`. A running job returns `stuck` once its elapsed time exceeds twice its interval. The server reads Hermes intervals and recurring systemd monotonic intervals, computes cron spacing from consecutive triggers, and estimates calendar timer spacing from the reported start and next trigger. A running job with unknown spacing remains unclassified. Other enabled jobs return `overdue` when their reported next trigger is in the past. Local jobs calculate their next trigger prospectively from cron, so only the mirrors currently supply overdue timestamps.

The Playwright fixture includes a failed timer, a timer running for 20 minutes on a two-minute interval, healthy jobs, and five paused jobs across two sources. It checks the live API, order, header count, desktop viewport visibility, and paused disclosure. Unit tests cover the two-interval boundary and overdue precedence.

The fixture screenshots belong in the existing [docs/images](docs/images/) directory. The [1440×900 light screenshot](docs/images/schedules-attention-light.png) shows the operator's initial viewport. The [375-wide dark screenshot](docs/images/schedules-attention-dark.png) captures the full page from a 375×812 viewport so both stacked panels are visible.
