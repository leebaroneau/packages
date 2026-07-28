// Daily API-quota accounting, unified from two proven in-service meters:
// crm-haverford sync/src/budget.ts (authoritative full-day totals, near-cap
// judgement) and koenig-sales lib/cin7-usage-meter.js (in-process SEGMENT
// subtotals flushed on rollover/shutdown, no cap judgement).
//
// The tag NAMES are a deliberate cross-service Sentry contract - one Explore
// query lines every consumer up side by side:
//
//   sentry explore <org>/<project> --dataset errors \
//     --field cin7_day --field consumer --field cin7_usage --query 'cin7_usage:*'
//
// Numbers go in TAGS, never only in `extra`: Sentry does not index extra, and
// both original meters shipped a write-only version of this signal before that
// lesson was learned (the 2026-07-23 quota outage arrived unannounced).
//
// Pure functions, zero dependencies, zero I/O - callers own persistence (a
// durable cache file for authoritative totals, process memory for segments)
// and the Sentry emit itself.

export interface DailyUsage {
  /** UTC calendar day, YYYY-MM-DD. This is a REPORTING bucket only - it does
   *  not claim to match the platform's (often unverified) quota-reset tz. */
  date: string;
  /** Requests counted for that day so far. */
  count: number;
}

export interface UsageStep {
  /** The bucket after folding in `delta`. */
  usage: DailyUsage;
  /** The just-completed prior day when the UTC day rolled over (and it had
   *  usage), so the caller can report it exactly once; else null. */
  emit: DailyUsage | null;
}

/** UTC calendar day (YYYY-MM-DD) for a given instant. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Fold `delta` newly-made requests into the daily bucket, keyed to `todayUTC`.
 *
 *  Delta-based and re-entrant: safe to call at every checkpoint and on both
 *  success and failure. On rollover the WHOLE delta lands on the new day - the
 *  function has no timestamps to split an aggregate, so checkpoint often
 *  (ideally per request or per pass); a coarse delta spanning midnight is
 *  attributed to the new day, never lost.
 *
 *  A `todayUTC` OLDER than the stored bucket (clock correction, stale caller,
 *  future-dated persisted state) is NOT treated as a rollover: the delta folds
 *  into the existing newer bucket so counts are never emitted twice or lost
 *  backwards. */
export function stepUsage(prev: DailyUsage | null | undefined, todayUTC: string, delta: number): UsageStep {
  if (prev && prev.date !== todayUTC) {
    // ISO YYYY-MM-DD compares correctly as a string.
    if (todayUTC < prev.date) {
      return { usage: { date: prev.date, count: prev.count + delta }, emit: null };
    }
    return { usage: { date: todayUTC, count: delta }, emit: prev.count > 0 ? prev : null };
  }
  const base = prev && prev.date === todayUTC ? prev.count : 0;
  return { usage: { date: todayUTC, count: base + delta }, emit: null };
}

export interface UsageVerdict {
  /** Whole-percent share of the daily cap this count represents. */
  pct: number;
  /** True once the count reaches ceil(cap * warnPct / 100). */
  nearCap: boolean;
}

/** Classify a completed day's request count against a daily cap. */
export function classifyUsage(count: number, dailyCap: number, warnPct = 80): UsageVerdict {
  const cap = Math.max(1, dailyCap);
  const warnAt = Math.ceil((cap * Math.min(100, Math.max(1, warnPct))) / 100);
  return {
    pct: Math.round((count / cap) * 100),
    nearCap: count >= warnAt,
  };
}

export interface MeterConfig {
  /** Who is spending: 'sync', 'app', 'webhooks', ... (indexed `consumer` tag). */
  consumer: string;
  /** Platform slug used as message text + tag prefix. Default 'cin7'. */
  platform?: string;
  /** Daily request cap. Default 5000 (Cin7's documented ceiling). */
  dailyCap?: number;
  /** Percent of cap at which a day reports as near-cap. Default 80. */
  warnPct?: number;
  /** True when this meter emits in-process SEGMENT subtotals (resets on
   *  redeploy) rather than authoritative full-day totals. Segments carry a
   *  `<platform>_segment:true` tag and NO near-cap judgement - a segment is
   *  not a day total and must not be compared to the cap. */
  segment?: boolean;
}

export interface UsageReport {
  message: string;
  level: 'info' | 'warning';
  /** Indexed Sentry tags - searchable, groupable in Explore, alertable. */
  tags: Record<string, string>;
  /** Unindexed context. Human detail only; never put a number you need to query here. */
  extra: Record<string, string | number>;
}

/** Build the Sentry event shape for one completed day (or segment).
 *
 *  Near-cap days get a DIFFERENT message string on purpose: message drives the
 *  Sentry fingerprint, so "near cap" becomes its own issue that can be alerted
 *  on and resolved, while routine days stay a low-noise info event.
 *
 *  @param reason what triggered the emit (e.g. 'rollover', 'shutdown') -
 *                recorded as `<platform>_emit_reason` when provided. */
export function buildUsageReport(day: DailyUsage, cfg: MeterConfig, reason?: string): UsageReport {
  const platform = cfg.platform ?? 'cin7';
  const dailyCap = cfg.dailyCap ?? 5000;
  const warnPct = cfg.warnPct ?? 80;

  const tags: Record<string, string> = {
    consumer: cfg.consumer,
    [`${platform}_day`]: day.date,
    [`${platform}_usage`]: String(day.count),
  };
  if (reason) tags[`${platform}_emit_reason`] = reason;

  if (cfg.segment) {
    tags[`${platform}_segment`] = 'true';
    return {
      message: `${platform} daily usage`,
      level: 'info',
      tags,
      extra: { date: day.date, count: day.count, segment: 'true' },
    };
  }

  const { pct, nearCap } = classifyUsage(day.count, dailyCap, warnPct);
  tags[`${platform}_usage_pct`] = String(pct);
  tags[`${platform}_near_cap`] = String(nearCap);
  return {
    message: nearCap ? `${platform} daily usage near cap` : `${platform} daily usage`,
    level: nearCap ? 'warning' : 'info',
    tags,
    extra: { date: day.date, count: day.count, cap: dailyCap, warnPct },
  };
}
