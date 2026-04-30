# Phase C perf baseline

This orphan branch holds the rolling baseline NDJSON used by
the `perf-compare` step in `.github/workflows/integration.yml`.
PR runs diff their fresh bench output against `baseline.ndjson`
and post a Markdown comment on the PR.

`baseline.ndjson` is rewritten by every push to `main` (or by a
nightly cron) — do not commit changes here directly.

Last updated from `6232eebe1acd71f7c1e61fa0e277a9d0be7664de`.
