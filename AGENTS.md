# haverford-packages — AGENTS.md

## Identity

Shared infrastructure libraries for Haverford services, published to GitHub
Packages under `@haverford-brands`. This repo is the "shared behaviour →
library" leg of the workspace coupling rule: shared **state** belongs in one
owning service (e.g. the Dev API's audit/change-log), **domain logic** belongs
in the service that owns the data, and only pure reusable mechanics belong
here.

## What belongs here

- Infrastructure behaviour needed by 2+ services (HTTP retry/timeout/throttle,
  API clients for shared platforms, quota metering, telemetry facades).
- Pure, unit-tested, zero-I/O-by-default code. Callers own persistence,
  scheduling and emission.

## What does NOT belong here

- Business/domain logic of any service.
- Anything stateful (databases, caches, queues) — that is a service.
- Speculative abstractions with a single consumer. Extract on the second real
  consumer, not before.

## Working rules

- Every change to an exported API needs a semver-correct version bump in the
  same PR; CI publishes any version not yet in the registry on merge to main.
- The `usage-meter` tag names (`consumer`, `cin7_day`, `cin7_usage`, …) are a
  cross-service Sentry contract consumed by dashboards and alerts — never
  rename without migrating every emitter and query.
- The `cin7-client` retry policy (429 all methods, 5xx safe methods only) and
  its hard timeout encode production incidents (KOENIG-CIN7-SYNC-7/-A, the
  2026-07-10 frozen backfill, the PUT probability-reset class of bugs). Do not
  weaken them without reading the doc comments' incident references first.
- Tests are node:test, run via `npm test` at the root. A PR with failing tests
  does not merge.
- Issue-first workflow applies (see the workspace `pipeline-workflow` skill):
  issue → `type/<#>-slug` branch → PR with `Fixes #N`.

## Consumers (keep current)

| Service | Packages used | Since |
| :--- | :--- | :--- |
| quote.koenigmachinery.com.au-webhooks | http, cin7-client, usage-meter, sentry | 2026-07-28 (PR pending) |
| crm-haverford (sync) | — migrate on next touch | |
| koenig-sales | — migrate on next touch | |
