// Sentry reporter facade - the single shared implementation.
//
// History: three Sentry setups existed across Haverford services - crm-haverford
// sync/src/sentry.mjs and koenig-sales lib/sentry.js (near-identical hand-rolled
// facades), plus a template-derived instrument.ts pair (app-Gateway /
// app-Shopify-Sales) that had already drifted (one lost its release tag). This
// package is the port of the crm-haverford facade, which had absorbed the most
// production lessons.
//
// Contract: all methods are no-ops when no DSN is supplied, so services ship
// fully inert. The reporter must NEVER throw - a broken reporter cannot be
// allowed to break the service it reports for.
//
// tracesSampleRate defaults to 0: Spans/Tracing is not enabled on the
// haverford-dev plan, so sampling would only burn quota. Override per service
// if that changes.

import * as Sentry from '@sentry/node';

/** How long flush() waits for in-flight events before giving up, in ms. Short
 *  on purpose: callers flush on failure paths and must not stall when Sentry
 *  is unreachable. */
const FLUSH_TIMEOUT_MS = 2000;

type Primitive = string | number | boolean | null | undefined;

export interface CaptureOptions {
  tags?: Record<string, Primitive>;
  extra?: Record<string, unknown>;
  user?: { id?: string; email?: string; username?: string };
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
}

export interface CaptureExceptionOptions extends CaptureOptions {
  /** `handled: false` marks the error as an unhandled crash, which drives
   *  Sentry's `is:unhandled` filter and its issue-priority heuristic.
   *  Default true (we caught it deliberately). */
  handled?: boolean;
}

export interface CheckInArgs {
  monitorSlug: string;
  status: 'in_progress' | 'ok' | 'error';
  checkInId?: string;
  config?: Parameters<typeof Sentry.captureCheckIn>[1];
}

export interface Reporter {
  enabled: boolean;
  captureException(err: unknown, o?: CaptureExceptionOptions): void;
  captureMessage(message: string, o?: CaptureOptions): void;
  /** Cron Monitor check-in. Open with status "in_progress", then close with the
   *  returned id and "ok"/"error". Returns the check-in id, or undefined. */
  captureCheckIn(args: CheckInArgs): string | undefined;
  flush(timeout?: number): Promise<void>;
}

const NOOP: Reporter = {
  enabled: false,
  captureException() {},
  captureMessage() {},
  captureCheckIn() {
    return undefined;
  },
  async flush() {},
};

/** Standardised release sourcing. Every service previously invented its own
 *  precedence; this is the union, most-specific first. Pass the result as
 *  `release` (or let initSentry apply it by default). */
export function releaseFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.SENTRY_RELEASE || env.SOURCE_COMMIT || env.COOLIFY_GIT_COMMIT_SHA || 'dev';
}

export interface InitSentryOptions {
  /** Sentry DSN. Falsy => fully inert reporter. */
  dsn?: string;
  /** Release identifier. Default: releaseFromEnv(). */
  release?: string;
  /** Sentry environment. Default "production". */
  environment?: string;
  /** server_name tag on every event. */
  serverName?: string;
  /** Sampling for tracing. Default 0 (Spans not on the plan). */
  tracesSampleRate?: number;
  /** beforeSend hook. Tests pass one that records the event and returns null,
   *  which keeps a whole suite offline. */
  beforeSend?: NonNullable<Parameters<typeof Sentry.init>[0]>['beforeSend'];
}

/** Initialise the process-wide Sentry SDK and return the reporter facade.
 *
 *  CALL ONCE PER PROCESS: the underlying SDK is a process-global singleton, so
 *  a second init re-points every previously returned reporter at the new
 *  DSN/options. Services should init at their entrypoint and pass the reporter
 *  down (or re-import it from a module-scope constant). */
export function initSentry(opts: InitSentryOptions = {}): Reporter {
  const { dsn, release, environment = 'production', serverName, tracesSampleRate = 0, beforeSend } = opts;
  if (!dsn) return NOOP;

  try {
    Sentry.init({
      dsn,
      release: release ?? releaseFromEnv(),
      environment,
      serverName,
      tracesSampleRate,
      beforeSend,
    });
  } catch {
    // A DSN the SDK rejects must not take the service down with it.
    return NOOP;
  }

  return {
    enabled: true,

    captureException(err, { tags, extra, user, level, handled = true } = {}) {
      try {
        const e = err instanceof Error ? err : new Error(String(err));
        Sentry.withScope((scope) => {
          if (tags) scope.setTags(tags);
          if (extra) scope.setExtras(extra);
          if (user) scope.setUser(user);
          if (level) scope.setLevel(level);
          Sentry.captureException(e, { mechanism: { type: 'generic', handled } });
        });
      } catch {
        /* reporter must never throw */
      }
    },

    captureMessage(message, { tags, extra, user, level = 'info' } = {}) {
      try {
        Sentry.withScope((scope) => {
          if (tags) scope.setTags(tags);
          if (extra) scope.setExtras(extra);
          if (user) scope.setUser(user);
          scope.setLevel(level);
          Sentry.captureMessage(message);
        });
      } catch {
        /* reporter must never throw */
      }
    },

    captureCheckIn({ monitorSlug, status, checkInId, config }) {
      try {
        // The SDK types check-ins as a union: closing statuses require the id.
        const checkIn = (checkInId !== undefined
          ? { monitorSlug, status, checkInId }
          : { monitorSlug, status }) as Parameters<typeof Sentry.captureCheckIn>[0];
        return Sentry.captureCheckIn(checkIn, config);
      } catch {
        return undefined; // reporter must never throw
      }
    },

    async flush(timeout = FLUSH_TIMEOUT_MS) {
      try {
        await Sentry.flush(timeout);
      } catch {
        /* reporter must never throw */
      }
    },
  };
}
