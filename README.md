# Phase C perf baseline

This orphan branch holds the rolling baseline NDJSON used by
the `perf-compare` step in `.github/workflows/integration.yml`.
PR runs diff their fresh bench output against `baseline.ndjson`
and post a Markdown comment on the PR.

`baseline.ndjson` is rewritten by every push to `main` (or by a
nightly cron) — do not commit changes here directly.

Last updated from `c8ad42149a0f6a91af9dd1ab7e2c40009eb05cc6`.
