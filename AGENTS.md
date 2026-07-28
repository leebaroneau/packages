# packages — AGENTS.md

## Identity

Lee Barone's shared infrastructure libraries, published publicly to npm under
`@leebaroneau/*`. This repo is the "shared behaviour → library" leg of the
workspace coupling rule: shared **state** belongs in one owning service (e.g.
the Dev API's audit/change-log), **domain logic** belongs in the service that
owns the data, and only pure reusable mechanics belong here. Consumed by
services across all orgs (Haverford-Brands, alx-finance, Genvest-Property, …).

## Naming convention

Integration packages are named for the platform (`cin7`, `sentry`, `shopify`
when it lands). Pure utilities are named for what they do (`http-resilience`,
`api-quota-meter`). Check npm for conflicts before adding a name.

## What belongs here

- Infrastructure behaviour needed by 2+ services (HTTP retry/timeout/throttle,
  API clients for shared platforms, quota metering, telemetry facades).
- Pure, unit-tested, zero-I/O-by-default code. Callers own persistence,
  scheduling and emission.

## What does NOT belong here

- Business/domain logic of any service.
- Anything stateful (databases, caches, queues) — that is a service.
- Secrets or internal endpoints — this repo is PUBLIC. Credentials always come
  from consumer env at runtime.
- Speculative abstractions with a single consumer. Extract on the second real
  consumer, not before.

## Working rules

- Every change to an exported API needs a semver-correct version bump in the
  same PR; CI publishes any version not yet on npmjs on merge to main.
- The `api-quota-meter` tag names (`consumer`, `cin7_day`, `cin7_usage`, …)
  are a cross-service Sentry contract consumed by dashboards and alerts —
  never rename without migrating every emitter and query.
- The `cin7` retry policy (429 all methods, 5xx safe methods only, transport
  errors safe methods only) and its hard timeout encode production incidents
  (KOENIG-CIN7-SYNC-7/-A, the 2026-07-10 frozen backfill). Do not weaken them
  without reading the doc comments' incident references first.
- Tests are node:test, run via `npm test` at the root. A PR with failing tests
  does not merge.
- Issue-first workflow applies (see the workspace `pipeline-workflow` skill).

## Consumers (keep current)

| Service | Packages used | Since |
| :--- | :--- | :--- |
| quote.koenigmachinery.com.au-webhooks | http-resilience, cin7, api-quota-meter | 2026-07-28 (PR pending) |
| crm-haverford (sync) | — migrate on next touch | |
| koenig-sales | — migrate on next touch | |
