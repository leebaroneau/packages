import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSentry, releaseFromEnv } from './index.js';

// A syntactically valid DSN pointing nowhere; beforeSend returns null so no
// event ever leaves the process - the whole suite runs offline.
const TEST_DSN = 'https://abc123@o0.ingest.sentry.io/0';

test('no DSN => inert reporter; methods are safe no-ops', async () => {
  const r = initSentry({});
  assert.equal(r.enabled, false);
  r.captureException(new Error('x'));
  r.captureMessage('y');
  assert.equal(r.captureCheckIn({ monitorSlug: 's', status: 'ok' }), undefined);
  await r.flush();
});

test('releaseFromEnv precedence: SENTRY_RELEASE > SOURCE_COMMIT > COOLIFY_GIT_COMMIT_SHA > dev', () => {
  assert.equal(releaseFromEnv({ SENTRY_RELEASE: 'a', SOURCE_COMMIT: 'b', COOLIFY_GIT_COMMIT_SHA: 'c' } as NodeJS.ProcessEnv), 'a');
  assert.equal(releaseFromEnv({ SOURCE_COMMIT: 'b', COOLIFY_GIT_COMMIT_SHA: 'c' } as NodeJS.ProcessEnv), 'b');
  assert.equal(releaseFromEnv({ COOLIFY_GIT_COMMIT_SHA: 'c' } as NodeJS.ProcessEnv), 'c');
  assert.equal(releaseFromEnv({} as NodeJS.ProcessEnv), 'dev');
});

test('captureException reports tags, level and the handled mechanism', async () => {
  const events: any[] = [];
  const r = initSentry({
    dsn: TEST_DSN,
    release: 'test',
    beforeSend: (event) => {
      events.push(event);
      return null;
    },
  });
  assert.equal(r.enabled, true);

  r.captureException(new Error('boom'), {
    tags: { area: 'test' },
    extra: { detail: 1 },
    level: 'error',
    handled: false,
  });
  await r.flush();
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.tags?.area, 'test');
  assert.equal(ev.extra?.detail, 1);
  assert.equal(ev.exception?.values?.[0]?.value, 'boom');
  assert.equal(ev.exception?.values?.[0]?.mechanism?.handled, false);
});

test('non-Error values are wrapped; captureMessage carries level and tags', async () => {
  const events: any[] = [];
  const r = initSentry({ dsn: TEST_DSN, release: 'test', beforeSend: (e) => (events.push(e), null) });

  r.captureException('string failure');
  await r.flush();
  assert.equal(events[0].exception?.values?.[0]?.value, 'string failure');

  r.captureMessage('cin7 daily usage', { level: 'warning', tags: { consumer: 'webhooks' } });
  await r.flush();
  assert.equal(events[1].message, 'cin7 daily usage');
  assert.equal(events[1].level, 'warning');
  assert.equal(events[1].tags?.consumer, 'webhooks');
});

test('undefined tag values are pruned so the tag map survives', async () => {
  const events: any[] = [];
  const r = initSentry({ dsn: TEST_DSN, release: 'test', beforeSend: (e) => (events.push(e), null) });
  r.captureMessage('x', { tags: { route: '/quotes', method: undefined } });
  await r.flush();
  assert.deepEqual(events[0].tags, { route: '/quotes' });
});

test('captureBrowserEvent preserves the event platform', async () => {
  const events: any[] = [];
  const r = initSentry({ dsn: TEST_DSN, release: 'test', beforeSend: (e) => (events.push(e), null) });
  r.captureBrowserEvent({ message: 'dom broke', platform: 'javascript', tags: { page: 'quote' } });
  await r.flush();
  assert.equal(events[0].message, 'dom broke');
  assert.equal(events[0].platform, 'javascript');
  assert.equal(events[0].tags?.page, 'quote');
});

test('integrations override is passed to the SDK init', () => {
  let sawDefaults = false;
  const r = initSentry({
    dsn: TEST_DSN,
    release: 'test',
    beforeSend: () => null,
    integrations: (defaults) => {
      sawDefaults = Array.isArray(defaults);
      return defaults.filter((i) => i.name !== 'OnUncaughtException');
    },
  });
  assert.equal(r.enabled, true);
  assert.equal(sawDefaults, true);
});

test('reporter never throws even when fed hostile input', () => {
  const r = initSentry({ dsn: TEST_DSN, release: 'test', beforeSend: () => null });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  r.captureException(cyclic, { extra: cyclic as Record<string, unknown> });
  r.captureMessage(undefined as unknown as string);
  r.captureCheckIn({ monitorSlug: undefined as unknown as string, status: 'ok' });
});
