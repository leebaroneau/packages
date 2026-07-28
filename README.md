# packages

Shared infrastructure packages by Lee Barone, published publicly to npm under
the `@leebaroneau` scope. Provided as-is under MIT — no support, no
guarantees; issues and PRs are disabled.

These exist because the same behaviours were hand-rolled in four services with
divergent bugs (four Cin7 clients, three Sentry setups — see the 2026-07-28
infrastructure survey). Shared **behaviour** lives here as versioned
libraries; shared **state** stays in the owning service; domain logic never
lands here.

Integration packages are named for the platform they integrate
(`connector-cin7`, `connector-sentry`, `connector-shopify` when it lands); pure utilities are named for
what they do.

## Packages

| Package | What it owns |
| :--- | :--- |
| `@leebaroneau/http-resilience` | Request timeouts, 429/5xx retry with Retry-After, rate-limit throttles (min-interval + sliding-window), error shaping, HTML-error-page-safe JSON reading |
| `@leebaroneau/connector-cin7` | Cin7 Omni v1 REST client on top of http-resilience: 3/sec + 60/min sliding window, paging, per-attempt usage counting, typed errors |
| `@leebaroneau/api-quota-meter` | Daily API-quota accounting: UTC-day buckets, rollover emission, near-cap classification, the shared Sentry tag contract (`cin7_day` / `cin7_usage` / `consumer`) |
| `@leebaroneau/connector-sentry` | Reporter facade over `@sentry/node`: inert without a DSN, never throws, `handled` mechanism, cron check-ins, standardised release sourcing |

## Consuming

Public packages — no registry config, no tokens. Just:

```json
"dependencies": { "@leebaroneau/connector-cin7": "^1.0.0" }
```

Upgrades are **opt-in per service**: bump the version in a PR when you choose
to take new behaviour. A service left alone keeps working on its pinned
version — that is the point.

## Publishing

CI publishes automatically: any package whose `version` in `package.json` is
not yet on npmjs is published on merge to main (requires the `NPM_TOKEN` repo
secret — an npmjs automation token). To release a change, bump the package's
version in the same PR (semver: breaking = major, feature = minor, fix =
patch). No manual `npm publish` needed.

## Development

```bash
npm install
npm test          # builds + runs node:test for every workspace
```

Rules of the road:

- Pure functions and small contracts; zero runtime deps unless unavoidable
  (`@sentry/node` is a peer dep of `sentry`).
- Every behavioural claim in a doc comment is backed by a test.
- Breaking an exported API means a major version bump — consumers upgrade on
  their own schedule.
