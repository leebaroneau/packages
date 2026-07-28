// Shared helpers for turning a transport failure into an error message that is
// actually useful once it reaches Sentry.
//
// WHY THIS EXISTS (2026-07-27, crm-haverford): KOENIG-CIN7-SYNC-7 arrived in
// Sentry as "TimeoutError: The operation was aborted due to timeout" with ZERO
// stack frames and no indication of which endpoint timed out. A TimeoutError
// from AbortSignal.timeout is a DOMException with an empty stack, and the client
// rethrew it bare - so nothing useful survived. Wrapping with these helpers puts
// the API name, redacted URL and attempt count into the message text itself.

/** Strip the query string from a URL before it goes into an error message.
 *  APIs should authenticate via headers rather than the query string, but
 *  filters can carry customer data and error messages end up in Sentry. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?<redacted>`;
}

/** Short, greppable description of a transport failure. DOMException-based
 *  errors (AbortSignal.timeout) carry a useful `name` but often an empty stack,
 *  which is exactly why the name has to make it into the message text. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Build the error thrown once a client has exhausted its retries.
 *  `cause` is preserved so @sentry/node's LinkedErrors integration still reports
 *  the original exception alongside this contextual wrapper.
 *
 *  @param api      human label for the upstream, e.g. "Cin7" or "CRM"
 *  @param url      request URL (redacted before use)
 *  @param attempts how many attempts were made in total
 *  @param err      the final underlying failure
 */
export function requestFailed(api: string, url: string, attempts: number, err: unknown): Error {
  return new Error(
    `${api} request failed after ${attempts} attempts: ${redactUrl(url)} (${describeError(err)})`,
    { cause: err },
  );
}
