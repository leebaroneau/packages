# haverford-packages

Shared infrastructure packages for Haverford services, published to GitHub
Packages under the `@haverford-brands` scope.

These exist because the same behaviours were hand-rolled in four services with
divergent bugs (four Cin7 clients, three Sentry setups, three Dev API clients —
see the 2026-07-28 survey). Shared **behaviour** lives here as versioned
libraries; shared **state** stays in the owning service; domain logic never
lands here.

## Packages

| Package | What it owns |
| :--- | :--- |
| `@haverford-brands/http` | Request timeouts, 429/5xx retry with Retry-After, rate-limit throttles (min-interval + sliding-window), Sentry-friendly error shaping, HTML-error-page-safe JSON reading |
| `@haverford-brands/cin7-client` | Cin7 Omni v1 REST client on top of `http`: 3/sec + 60/min sliding window, paging, per-attempt usage counting, typed errors |
| `@haverford-brands/usage-meter` | Daily API-quota accounting: UTC-day buckets, rollover emission, near-cap classification, the shared Sentry tag contract (`cin7_day` / `cin7_usage` / `consumer`) |
| `@haverford-brands/sentry` | Reporter facade: inert without a DSN, never throws, `handled` mechanism, cron check-ins, standardised release sourcing |

## Consuming from a service

1. Add a `.npmrc` next to the service's `package.json`:

   ```
   @haverford-brands:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NPM_TOKEN}
   ```

2. Provide `NPM_TOKEN` (a classic PAT with `read:packages`) wherever `npm ci`
   runs — locally in your shell, and as a **build-time** variable on the
   service's Coolify app. In a Dockerfile, accept it as a build arg and scope
   it to the install step; never bake it into the final image:

   ```dockerfile
   ARG NPM_TOKEN
   COPY .npmrc package.json package-lock.json ./
   RUN npm ci --omit=dev && rm -f .npmrc
   ```

3. Depend on packages with a caret range and upgrade deliberately:

   ```json
   "dependencies": { "@haverford-brands/cin7-client": "^1.0.0" }
   ```

Upgrades are **opt-in per service**: bump the version in a PR when you choose
to take new behaviour. A service left alone keeps working on its pinned
version — that is the point.

## Publishing

CI publishes automatically: any package whose `version` in `package.json` is
not yet in the registry is published on merge to main. To release a change,
bump the package's version in the same PR (semver: breaking = major, feature =
minor, fix = patch). No manual `npm publish` needed.

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
