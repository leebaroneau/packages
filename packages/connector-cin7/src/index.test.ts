import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cin7Client, Cin7HttpError } from './index.js';

const base = { baseUrl: 'https://api.cin7.com/api', username: 'u', apiKey: 'k' };
// Tests bypass the sliding-window default so they run instantly.
const instant = { throttle: { acquire: async () => {} }, retryDelayMs: 1 };

test('auth header builds HTTP Basic from username:apiKey', () => {
  const c = new Cin7Client({ ...base, ...instant });
  assert.equal(c.authHeaderForTest(), 'Basic dTpr'); // base64("u:k")
});

test('listPage hits page/rows and returns the array', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  const rows = await c.listPage('Contacts', 1, 250);
  assert.equal(rows.length, 2);
  assert.match(calls[0], /\/v1\/Contacts\?page=1&rows=250$/);
});

test('listPage unwraps {data: [...]} envelope', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [{ id: 9 }] }), { status: 200 })) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  assert.deepEqual(await c.listPage('Quotes', 1, 250), [{ id: 9 }]);
});

test('GET 502 with an HTML body retries then surfaces status + text (no SyntaxError)', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return new Response('<!DOCTYPE html><html>bad gateway</html>', { status: 502 });
  }) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  await assert.rejects(
    () => c.listPage('SalesOrders', 1, 250),
    (err: Cin7HttpError) => {
      assert.equal(err.name, 'Cin7HttpError');
      assert.equal(err.status, 502);
      assert.match(err.message, /HTTP 502/);
      assert.match(err.bodyText, /DOCTYPE/);
      return true;
    },
  );
  assert.equal(n, 3); // initial + 2 retries (GET 5xx is retried)
  assert.equal(c.requestsMade, 3);
});

test('POST 500 is NOT retried (double-apply guard) and throws typed error', async () => {
  let n = 0;
  const fetchImpl = (async () => { n += 1; return new Response('boom', { status: 500 }); }) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  await assert.rejects(() => c.post('/v1/SalesOrders', [{ ref: 'x' }]), /HTTP 500/);
  assert.equal(n, 1);
});

test('429 retried for POST too; requestsMade counts each attempt; onRequest fires', async () => {
  let n = 0;
  let counted = 0;
  const fetchImpl = (async () => {
    n += 1;
    return n === 1
      ? new Response('rate', { status: 429, headers: { 'retry-after': '0' } })
      : new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl, onRequest: () => { counted += 1; } });
  const out = await c.post<{ ok: boolean }>('/v1/SalesOrders', [{}]);
  assert.deepEqual(out, { ok: true });
  assert.equal(c.requestsMade, 2);
  assert.equal(counted, 2);
});

test('a malformed 200 body throws instead of reading as an empty page', async () => {
  const fetchImpl = (async () =>
    new Response('[{"id":1},{"id":2', { status: 200 })) as unknown as typeof fetch; // truncated JSON
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  await assert.rejects(() => c.listPage('SalesOrders', 1, 250), /malformed JSON/);
});

test('getOne returns null on 404', async () => {
  const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  assert.equal(await c.getOne('Quotes', 123), null);
});

test('call() appends params to the query string', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return new Response('[]', { status: 200 }); }) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  await c.call('GET', '/v1/SalesOrders', { params: { fields: 'id,reference', where: "reference='Q1'" } });
  assert.match(calls[0], /fields=id%2Creference/);
  assert.match(calls[0], /where=reference/);
});

test('pages() stops on short page', async () => {
  let page = 0;
  const fetchImpl = (async () => {
    page += 1;
    const batch = page === 1 ? Array.from({ length: 3 }, (_, i) => ({ id: i })) : [{ id: 99 }];
    return new Response(JSON.stringify(batch), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  const seen: number[] = [];
  for await (const batch of c.pages<{ id: number }>('Products', 3)) seen.push(batch.length);
  assert.deepEqual(seen, [3, 1]);
});

test('per-call timeoutMs override reaches the fetch signal', async () => {
  // A 1ms per-call timeout must abort a slow fetch even though the client
  // default is much larger.
  const fetchImpl = ((url: string, init: RequestInit) =>
    new Promise((resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      setTimeout(() => resolve(new Response('[]', { status: 200 })), 5_000).unref();
    })) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl, timeoutMs: 60_000, maxRetries: 0 });
  await assert.rejects(
    () => c.call('GET', '/v1/Contacts', { timeoutMs: 1 }),
    /after 1 attempts/,
  );
});

test("on404: 'throw' raises instead of resolving null", async () => {
  const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  const c = new Cin7Client({ ...base, ...instant, fetchImpl });
  assert.equal(await c.call('GET', '/v1/Quotes/9'), null);
  await assert.rejects(() => c.call('GET', '/v1/Quotes/9', { on404: 'throw' }), /HTTP 404/);
});

test('onRetry observability hook fires with attempt/status/wait', async () => {
  let n = 0;
  const seen: Array<{ attempt: number; status?: number }> = [];
  const fetchImpl = (async () => {
    n += 1;
    return n === 1 ? new Response('r', { status: 429 }) : new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  const c = new Cin7Client({
    ...base, ...instant, fetchImpl,
    onRetry: ({ attempt, status }) => seen.push({ attempt, status }),
  });
  await c.listPage('Quotes', 1, 250);
  assert.deepEqual(seen, [{ attempt: 0, status: 429 }]);
});

test('fromEnv requires credentials', () => {
  assert.throws(() => Cin7Client.fromEnv({} as NodeJS.ProcessEnv), /CIN7_USERNAME/);
  const c = Cin7Client.fromEnv(
    { CIN7_USERNAME: 'u', CIN7_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv,
    { throttle: { acquire: async () => {} } },
  );
  assert.equal(c.baseUrl, 'https://api.cin7.com/api');
});
