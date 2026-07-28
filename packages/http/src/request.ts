// The single request chokepoint: throttle -> hard timeout -> status-based retry
// -> transport-catch retry -> contextual error. This algorithm existed in four
// hand-rolled variants across Haverford services (crm-haverford Cin7Client and
// CrmClient, koenig-sales cin7(), quote-webhooks cin7Request), each missing
// something the others had. This is the merge of the surviving behaviour:
//
//  - HARD timeout on every attempt (2026-07-10: a dead connection with no
//    timeout silently froze a backfill for 2 hours - native fetch waits forever)
//  - 429 retried for every method (a 429 means the request was NOT processed)
//  - 5xx retried for safe methods only by default (a 500 on a PUT/POST may mean
//    the write partially applied; re-sending could double-apply)
//  - Retry-After honoured in both RFC 7231 forms, else exponential backoff
//    floored at retryDelayMs and capped at maxDelayMs
//  - thrown transport errors (timeout, DNS, reset) always retried
//  - the final failure names the API, redacted URL and attempt count so it is
//    diagnosable when it reaches Sentry (KOENIG-CIN7-SYNC-7)
//  - every attempt (including retries) can be counted via onAttempt for quota
//    accounting - each retry is a real call against a daily cap

import { requestFailed } from './errors.js';
import { computeRetryWaitMs } from './retry.js';
import type { Throttle } from './throttle.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type RetryStatusDecider = (status: number, method: string) => boolean;

/** When thrown transport errors (timeout, reset, DNS) may be retried:
 *  - 'safe-methods' (default): GET/HEAD/OPTIONS only. A timeout on a write is
 *    ambiguous - the server may have applied it, and re-sending can
 *    double-apply. (Stricter than the legacy crm-haverford client, which
 *    retried transport failures for every method.)
 *  - 'always': every method - opt in only when the endpoint is idempotent.
 *  - 'never': fail fast on the first transport error. */
export type TransportRetryMode = 'safe-methods' | 'always' | 'never';

/** Default status-retry policy: 429 always; 5xx only for safe methods. */
export const defaultRetryOnStatus: RetryStatusDecider = (status, method) =>
  status === 429 || (status >= 500 && SAFE_METHODS.has(method));

export interface RequestPolicy {
  /** Human label for error messages, e.g. "Cin7". Default "HTTP". */
  apiName?: string;
  /** Hard per-attempt timeout. Default 45_000. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2 (=> 3 attempts). */
  maxRetries?: number;
  /** Base backoff before a retry. Default 1_500. */
  retryDelayMs?: number;
  /** Backoff cap. Default 30_000. */
  maxDelayMs?: number;
  /** Which response statuses to retry. Default: 429 always, 5xx safe methods. */
  retryOnStatus?: RetryStatusDecider;
  /** When thrown transport errors may be retried. Default 'safe-methods'. */
  retryOnTransportError?: TransportRetryMode;
  /** Rate-limit gate acquired before every attempt. */
  throttle?: Throttle;
  /** Called before every attempt (including retries) - quota accounting hook. */
  onAttempt?: () => void;
  /** Injectable for tests. Default globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/** Fetch with throttle + timeout + retry. Returns the final Response (which may
 *  still be non-ok - status handling beyond retry is the caller's contract);
 *  throws only when the transport itself fails on the last attempt. */
export async function requestWithRetry(
  url: string,
  init: Parameters<typeof fetch>[1],
  policy: RequestPolicy = {},
): Promise<Response> {
  const {
    apiName = 'HTTP',
    timeoutMs = 45_000,
    maxRetries = 2,
    retryDelayMs = 1_500,
    maxDelayMs = 30_000,
    retryOnStatus = defaultRetryOnStatus,
    retryOnTransportError = 'safe-methods',
    throttle,
    onAttempt,
    fetchImpl = fetch,
  } = policy;
  const method = (init?.method ?? 'GET').toUpperCase();
  const transportRetryable =
    retryOnTransportError === 'always' ||
    (retryOnTransportError === 'safe-methods' && SAFE_METHODS.has(method));

  for (let attempt = 0; ; attempt += 1) {
    if (throttle) await throttle.acquire();
    try {
      onAttempt?.();
      // Compose the caller's signal with the per-attempt timeout so an outer
      // shutdown/cancellation can still abort in-flight requests and retries.
      const signal = init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl(url, { ...init, signal });
      if (retryOnStatus(res.status, method) && attempt < maxRetries) {
        // Consume the body so the connection can be reused before we retry.
        await res.arrayBuffer().catch(() => {});
        await sleep(
          computeRetryWaitMs(res.headers.get('retry-after'), attempt, retryDelayMs, Date.now(), maxDelayMs),
        );
        continue;
      }
      return res;
    } catch (err) {
      // Never retry a deliberate caller cancellation.
      const callerAborted = init?.signal?.aborted === true;
      if (transportRetryable && !callerAborted && attempt < maxRetries) {
        await sleep(Math.min(retryDelayMs * 2 ** attempt, maxDelayMs));
        continue;
      }
      throw requestFailed(apiName, url, attempt + 1, err);
    }
  }
}

/** Read a body as text and parse JSON only when non-empty. Never call
 *  res.json() directly on an upstream that can answer with an HTML error page -
 *  the SyntaxError masks the real status and bypasses status-based handling
 *  (this is exactly how the quote-webhooks client hid Cin7's HTML 502s).
 *
 *  `parseError` distinguishes "empty body" from "body present but not JSON".
 *  Callers MUST treat parseError on an OK response as a failure: a truncated
 *  200 that silently becomes `data: null` reads as a legitimate empty page and
 *  stops pagination early with incomplete data. */
export async function readJsonBody<T = unknown>(
  res: Response,
): Promise<{ text: string; data: T | null; parseError: boolean }> {
  const text = await res.text();
  if (!text) return { text, data: null, parseError: false };
  try {
    return { text, data: JSON.parse(text) as T, parseError: false };
  } catch {
    return { text, data: null, parseError: true };
  }
}
