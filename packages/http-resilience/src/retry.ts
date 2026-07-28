// Retry-wait calculation, honouring RFC 7231 Retry-After in both forms.
// Ported verbatim from crm-haverford sync/src/cin7Client.ts where it is
// battle-tested against Cin7's 429s (KOENIG-CIN7-SYNC-3).

/** Parse a Retry-After header into milliseconds. Accepts both RFC 7231 forms -
 *  an integer delta-seconds (`"2"`) and an HTTP-date
 *  (`"Fri, 24 Jul 2026 00:00:05 GMT"`). Returns null when absent or unparseable
 *  so the caller can fall back to its own backoff. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // RFC 7231 delta-seconds is a non-negative integer - reject decimals, signs,
  // exponent notation, etc. (they would otherwise parse via Number and give a
  // bogus wait); anything else is tried as an HTTP-date.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP-date always contains spaces; bail on space-less numeric-ish garbage
  // (e.g. "1e3", "2.5", "-5") that Date.parse would otherwise misinterpret.
  if (!trimmed.includes(' ')) return null;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? at - nowMs : null;
}

/** Milliseconds to wait before a retry: honour Retry-After when present, else
 *  exponential backoff (`retryDelayMs * 2^attempt`). Floored at `retryDelayMs`
 *  and capped at `maxDelayMs`. The cap intentionally does NOT wait out a long
 *  daily-quota window - that is the caller's budgeting concern, not a
 *  per-request retry's. */
export function computeRetryWaitMs(
  retryAfter: string | null | undefined,
  attempt: number,
  retryDelayMs: number,
  nowMs: number,
  maxDelayMs = 30_000,
): number {
  const parsed = parseRetryAfter(retryAfter, nowMs);
  const ms = parsed ?? retryDelayMs * 2 ** attempt;
  return Math.min(Math.max(ms, retryDelayMs), maxDelayMs);
}
