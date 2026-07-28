// Cin7 Omni v1 REST client - the single shared implementation.
//
// History: four hand-rolled Cin7 clients existed across Haverford services
// (crm-haverford sync, koenig-sales, quote-webhooks, Dev API proxy), each
// missing behaviour another had. This client merges the survivors:
//   - sliding-window throttle faithful to Cin7's documented "3/sec, 60/min"
//     (from quote-webhooks; configure a smaller share when several services
//     run against the same API connection)
//   - hard 45s per-attempt timeout (from crm-haverford, 2026-07-10 frozen
//     backfill incident)
//   - 429 retried on every method, 5xx on safe methods only (KOENIG-CIN7-SYNC-A
//     and the PUT double-apply guard), Retry-After honoured in both forms
//   - text-first body parsing - Cin7's fronting infra answers with HTML error
//     pages, and res.json()-first hides the real status behind a SyntaxError
//   - requestsMade counts every attempt including retries (each is a real call
//     against the shared daily quota; feed it to @haverford-brands/usage-meter)

import {
  requestWithRetry,
  readJsonBody,
  slidingWindowThrottle,
  type Throttle,
} from '@haverford-brands/http';

/** Cin7 v1 REST collections commonly paged. Any /v1 collection name works. */
export type Cin7Resource =
  | 'Contacts'
  | 'Quotes'
  | 'Products'
  | 'SalesOrders'
  | 'PurchaseOrders'
  | 'CreditNotes'
  | 'Categories'
  | 'Users'
  | (string & {});

export interface Cin7ClientOptions {
  baseUrl: string;
  username: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Rate-limit gate. Default: sliding window at `perSecond`/`perMinute`. */
  throttle?: Throttle;
  /** Default-throttle share of Cin7's 3/sec cap. Default 3. */
  perSecond?: number;
  /** Default-throttle share of Cin7's 60/min cap. Default 60. */
  perMinute?: number;
  /** base ms to wait before a 429/error retry; default 1500. */
  retryDelayMs?: number;
  /** max retries after the first attempt; default 2 (=> 3 attempts). */
  maxRetries?: number;
  /** hard per-attempt timeout; default 45_000. */
  timeoutMs?: number;
  /** Called on every outbound attempt (usage accounting hook). */
  onRequest?: () => void;
}

/** Non-OK Cin7 response, with the status and body text preserved so callers
 *  can branch (e.g. 404 handling) without string-parsing the message. */
export class Cin7HttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.name = 'Cin7HttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export class Cin7Client {
  readonly baseUrl: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly throttle: Throttle;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly onRequest?: () => void;
  /** Cumulative count of outbound Cin7 HTTP requests made by this instance
   *  (includes retries - each is a real call against the daily quota). */
  requestsMade = 0;

  constructor(opts: Cin7ClientOptions) {
    if (!opts.baseUrl || !opts.username || !opts.apiKey) {
      throw new Error('Cin7Client: baseUrl, username, apiKey are required');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${opts.username}:${opts.apiKey}`).toString('base64')}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.throttle =
      opts.throttle ??
      slidingWindowThrottle({ perSecond: opts.perSecond ?? 3, perMinute: opts.perMinute ?? 60 });
    this.retryDelayMs = opts.retryDelayMs ?? 1500;
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.onRequest = opts.onRequest;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<Cin7ClientOptions> = {}): Cin7Client {
    const baseUrl = env.CIN7_BASE_URL ?? 'https://api.cin7.com/api';
    const username = env.CIN7_USERNAME ?? '';
    const apiKey = env.CIN7_API_KEY ?? '';
    if (!username || !apiKey) throw new Error('Cin7Client.fromEnv: set CIN7_USERNAME + CIN7_API_KEY');
    return new Cin7Client({ baseUrl, username, apiKey, ...extra });
  }

  /** test-only accessor for the auth header */
  authHeaderForTest(): string {
    return this.auth;
  }

  private async request(url: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
    return requestWithRetry(url, init, {
      apiName: 'Cin7',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
      throttle: this.throttle,
      fetchImpl: this.fetchImpl,
      onAttempt: () => {
        this.requestsMade += 1;
        this.onRequest?.();
      },
    });
  }

  /** Generic call: GET/POST/PUT a /v1 path, JSON in/out, typed error on non-OK.
   *  `params` are appended as query-string values. 404 on GET returns null. */
  async call<T = unknown>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<T | null> {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    const res = await this.request(url.toString(), {
      method,
      headers: {
        Authorization: this.auth,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const { text, data, parseError } = await readJsonBody<T>(res);
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      throw new Cin7HttpError(
        `Cin7 ${method} ${path}: HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        text,
      );
    }
    if (parseError) {
      // A truncated/corrupted 200 must not read as an empty result.
      throw new Cin7HttpError(
        `Cin7 ${method} ${path}: HTTP ${res.status} returned malformed JSON: ${text.slice(0, 200)}`,
        res.status,
        text,
      );
    }
    return data;
  }

  async listPage<T = unknown>(resource: Cin7Resource, page: number, rows: number, query?: string): Promise<T[]> {
    const url = `${this.baseUrl}/v1/${resource}?page=${page}&rows=${rows}${query ? `&${query}` : ''}`;
    const res = await this.request(url, { headers: { Authorization: this.auth } });
    const { text, data, parseError } = await readJsonBody(res);
    if (!res.ok) {
      throw new Cin7HttpError(
        `Cin7 ${resource} p${page}: HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        text,
      );
    }
    if (parseError) {
      // A truncated 200 must not read as an empty page - that would stop
      // pagination silently and yield an incomplete sync.
      throw new Cin7HttpError(
        `Cin7 ${resource} p${page}: HTTP ${res.status} returned malformed JSON: ${text.slice(0, 200)}`,
        res.status,
        text,
      );
    }
    if (data === null) return [];
    return (Array.isArray(data) ? data : ((data as { data?: T[] }).data ?? [])) as T[];
  }

  /** Fetch a single record by id (GET /v1/{resource}/{id}); 404 -> null. */
  async getOne<T = unknown>(resource: Cin7Resource, id: number | string): Promise<T | null> {
    return this.call<T>('GET', `/v1/${resource}/${id}`);
  }

  /** PUT with an array body (Cin7's partial list-update shape). NOT retried on
   *  5xx - a 500 may mean the write partially applied. */
  async put<T = unknown>(path: string, body: unknown): Promise<T | null> {
    return this.call<T>('PUT', path, { body });
  }

  /** POST a new record. NOT retried on 5xx (double-apply risk: a retried
   *  create can duplicate sales orders). Callers needing stronger delivery
   *  should implement idempotency at the domain level. */
  async post<T = unknown>(path: string, body: unknown): Promise<T | null> {
    return this.call<T>('POST', path, { body });
  }

  /** Yields pages until a short page (< rows) signals the end.
   *  Optional query string is appended verbatim (e.g. 'order=modifieddate DESC'). */
  async *pages<T = unknown>(resource: Cin7Resource, rows = 250, query?: string): AsyncGenerator<T[]> {
    for (let page = 1; ; page += 1) {
      const batch = await this.listPage<T>(resource, page, rows, query);
      if (batch.length === 0) return;
      yield batch;
      if (batch.length < rows) return;
    }
  }
}
