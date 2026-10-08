# Archived: BizEazy's schema before the shared database

These built BizEazy's own Supabase project (`rtleeehglawquekygfoh`). BizEazy now
runs on the shared ecosystem database, whose schema lives only in
`~/biz-platform/supabase/migrations` (BizEazy's part:
`20261009000010_bizeazy_hub.sql`, which consolidates these three with the
`hub_` renames).

**Never apply these to the shared database.** They are kept to explain the old
project, which stays as the fallback until it is retired.
