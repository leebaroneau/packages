import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRetryAfter,
  computeRetryWaitMs,
  redactUrl,
  describeError,
  requestFailed,
  requestWithRetry,
  requestTextWithRetry,
  readJsonBody,
  defaultRetryOnStatus,
  minIntervalThrottle,
  slidingWindowThrottle,
} from './index.js';

// ---- retry.ts (ported from crm-haverford, keep behaviour identical) ----

test('parseRetryAfter: integer seconds & HTTP-date; rejects non-integers/garbage', () => {
  assert.equal(parseRetryAfter('2', 0), 2000);
  assert.equal(parseRetryAfter('  2  ', 0), 2000);
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter(undefined, 0), null);
  assert.equal(parseRetryAfter('2.5', 0), null);
  assert.equal(parseRetryAfter('-5', 0), null);
  assert.equal(parseRetryAfter('1e3', 0), null);
  assert.equal(parseRetryAfter('not-a-date', 0), null);
  const now = Date.parse('2026-07-24T00:00:00Z');
  assert.equal(parseRetryAfter('Fri, 24 Jul 2026 00:00:05 GMT', now), 5000);
});

test('computeRetryWaitMs: honours header, backs off, floors + caps', () => {
  assert.equal(computeRetryWaitMs('2', 0, 1500, 0), 2000);
  assert.equal(computeRetryWaitMs(null, 0, 1500, 0), 1500);
  assert.equal(computeRetryWaitMs(null, 1, 1500, 0), 3000);
  assert.equal(computeRetryWaitMs('0', 0, 1500, 0), 1500);
  assert.equal(computeRetryWaitMs('3600', 0, 1500, 0), 30_000);
  assert.equal(computeRetryWaitMs('3600', 0, 1500, 0, 10_000), 10_000); // custom cap
});

// ---- errors.ts ----

test('redactUrl strips query strings; requestFailed names api/url/attempts and keeps cause', () => {
  assert.equal(redactUrl('https://x/y?secret=1'), 'https://x/y?<redacted>');
  assert.equal(redactUrl('https://x/y'), 'https://x/y');
  const cause = new Error('boom');
  cause.name = 'TimeoutError';
  const err = requestFailed('Cin7', 'https://x/v1/Quotes?page=1', 3, cause);
  assert.match(err.message, /Cin7 request failed after 3 attempts/);
  assert.match(err.message, /\/v1\/Quotes\?<redacted>/);
  assert.match(err.message, /TimeoutError: boom/);
  assert.equal(err.cause, cause);
  assert.equal(describeError('plain'), 'plain');
});

// ---- defaultRetryOnStatus ----

test('default policy: 429 all methods, 5xx safe methods only', () => {
  assert.equal(defaultRetryOnStatus(429, 'POST'), true);
  assert.equal(defaultRetryOnStatus(429, 'GET'), true);
  assert.equal(defaultRetryOnStatus(502, 'GET'), true);
  assert.equal(defaultRetryOnStatus(500, 'HEAD'), true);
  assert.equal(defaultRetryOnStatus(502, 'POST'), false);
  assert.equal(defaultRetryOnStatus(500, 'PUT'), false);
  assert.equal(defaultRetryOnStatus(404, 'GET'), false);
  assert.equal(defaultRetryOnStatus(200, 'GET'), false);
});

// ---- requestWithRetry ----

const fast = { retryDelayMs: 1, timeoutMs: 5_000 };

test('retries 429 then succeeds; onAttempt counts every attempt', async () => {
  let n = 0;
  const counted: number[] = [];
  const fetchImpl = (async () => {
    n += 1;
    return n === 1 ? new Response('rate', { status: 429 }) : new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  const res = await requestWithRetry('https://x/y', undefined, {
    ...fast, fetchImpl, onAttempt: () => counted.push(1),
  });
  assert.equal(res.status, 200);
  assert.equal(n, 2);
  assert.equal(counted.length, 2);
});

test('retries GET 502 then succeeds', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return n === 1
      ? new Response('<!DOCTYPE html>bad gateway', { status: 502 })
      : new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  const res = await requestWithRetry('https://x/y', undefined, { ...fast, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(n, 2);
});

test('does NOT retry POST 502; returns the response for the caller to handle', async () => {
  let n = 0;
  const fetchImpl = (async () => { n += 1; return new Response('boom', { status: 502 }); }) as unknown as typeof fetch;
  const res = await requestWithRetry('https://x/y', { method: 'POST' }, { ...fast, fetchImpl });
  assert.equal(res.status, 502);
  assert.equal(n, 1);
});

test('gives up after maxRetries on persistent 429 and returns the last response', async () => {
  let n = 0;
  const fetchImpl = (async () => { n += 1; return new Response('rate', { status: 429 }); }) as unknown as typeof fetch;
  const res = await requestWithRetry('https://x/y', undefined, { ...fast, fetchImpl, maxRetries: 2 });
  assert.equal(res.status, 429);
  assert.equal(n, 3);
});

test('persistent transport failure throws a contextual error with cause', async () => {
  const cause = new Error('The operation was aborted due to timeout');
  cause.name = 'TimeoutError';
  let n = 0;
  const fetchImpl = (async () => { n += 1; throw cause; }) as unknown as typeof fetch;
  await assert.rejects(
    () => requestWithRetry('https://x/v1/Quotes?p=1', undefined, { ...fast, fetchImpl, apiName: 'Cin7', maxRetries: 2 }),
    (err: Error) => {
      assert.match(err.message, /Cin7 request failed after 3 attempts/);
      assert.match(err.message, /\?<redacted>/);
      assert.equal(err.cause, cause);
      return true;
    },
  );
  assert.equal(n, 3);
});

test('transport failure on a POST is NOT retried by default (ambiguous write)', async () => {
  let n = 0;
  const fetchImpl = (async () => { n += 1; throw new Error('socket reset'); }) as unknown as typeof fetch;
  await assert.rejects(
    () => requestWithRetry('https://x/y', { method: 'POST' }, { ...fast, fetchImpl, maxRetries: 2 }),
    /after 1 attempts/,
  );
  assert.equal(n, 1);
});

test("retryOnTransportError:'always' opts a POST into transport retries", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    if (n < 2) throw new Error('reset');
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const res = await requestWithRetry('https://x/y', { method: 'POST' }, {
    ...fast, fetchImpl, retryOnTransportError: 'always',
  });
  assert.equal(res.status, 200);
  assert.equal(n, 2);
});

test('a caller-aborted signal is never retried', async () => {
  const ac = new AbortController();
  let n = 0;
  const fetchImpl = (async () => { n += 1; ac.abort(); throw new Error('aborted'); }) as unknown as typeof fetch;
  await assert.rejects(
    () => requestWithRetry('https://x/y', { signal: ac.signal }, { ...fast, fetchImpl, maxRetries: 5 }),
    /after 1 attempts/,
  );
  assert.equal(n, 1);
});

test('custom retryOnStatus overrides the default', async () => {
  let n = 0;
  const fetchImpl = (async () => { n += 1; return new Response('x', { status: 502 }); }) as unknown as typeof fetch;
  const res = await requestWithRetry('https://x/y', { method: 'POST' }, {
    ...fast, fetchImpl, maxRetries: 1,
    retryOnStatus: (status) => status >= 500, // opt in: POST 5xx retried
  });
  assert.equal(res.status, 502);
  assert.equal(n, 2);
});

// ---- requestTextWithRetry ----

test('requestTextWithRetry returns {res, text} and non-ok responses still carry their body', async () => {
  const fetchImpl = (async () => new Response('teapot says no', { status: 418 })) as unknown as typeof fetch;
  const { res, text } = await requestTextWithRetry('https://x/y', undefined, { ...fast, fetchImpl });
  assert.equal(res.status, 418);
  assert.equal(text, 'teapot says no');
});

test('requestTextWithRetry retries a body read that fails mid-stream (CRM stalled-read lesson)', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    if (n === 1) {
      // 200 whose body stream dies mid-read - fetch resolved, text() rejects.
      const body = new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  const { res, text } = await requestTextWithRetry('https://x/y', undefined, { ...fast, fetchImpl });
  assert.equal(n, 2);
  assert.equal(res.status, 200);
  assert.equal(text, '{"ok":true}');
});

test('requestTextWithRetry stalled read on a POST is NOT retried by default (ambiguous write)', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => requestTextWithRetry('https://x/y', { method: 'POST' }, { ...fast, fetchImpl }),
    /after 1 attempts/,
  );
  assert.equal(n, 1);
  // ...but 'always' opts writes in (CRM's GraphQL POSTs are retry-safe by design).
  n = 0;
  const out = await requestTextWithRetry('https://x/y', { method: 'POST' }, {
    ...fast,
    fetchImpl: (async () => {
      n += 1;
      return n === 1
        ? new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { status: 200 })
        : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch,
    retryOnTransportError: 'always',
  });
  assert.equal(out.text, 'ok');
  assert.equal(n, 2);
});

// ---- readJsonBody ----

test('readJsonBody survives an HTML error page and flags the parse failure', async () => {
  const html = new Response('<!DOCTYPE html><html>502</html>', { status: 502 });
  const bad = await readJsonBody(html);
  assert.match(bad.text, /DOCTYPE/);
  assert.equal(bad.data, null);
  assert.equal(bad.parseError, true);
  const ok = await readJsonBody<{ a: number }>(new Response('{"a":1}', { status: 200 }));
  assert.deepEqual(ok.data, { a: 1 });
  assert.equal(ok.parseError, false);
  const empty = await readJsonBody(new Response('', { status: 200 }));
  assert.equal(empty.data, null);
  assert.equal(empty.parseError, false); // empty body is NOT a parse error
});

// ---- throttles ----

test('minIntervalThrottle spaces request starts', async () => {
  const t = minIntervalThrottle(40);
  const t0 = Date.now();
  await t.acquire();
  await t.acquire();
  await t.acquire();
  assert.ok(Date.now() - t0 >= 80, `elapsed ${Date.now() - t0}ms, expected >= 80ms`);
});

test('slidingWindowThrottle enforces the per-second window', async () => {
  const t = slidingWindowThrottle({ perSecond: 2, perMinute: 100 });
  const t0 = Date.now();
  await t.acquire();
  await t.acquire();
  await t.acquire(); // third must wait for the 1s window
  assert.ok(Date.now() - t0 >= 900, `elapsed ${Date.now() - t0}ms, expected >= ~1000ms`);
});

test('slidingWindowThrottle rejects nonsense limits', () => {
  assert.throws(() => slidingWindowThrottle({ perSecond: 0, perMinute: 60 }));
});
