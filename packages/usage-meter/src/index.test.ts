import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcDay, stepUsage, classifyUsage, buildUsageReport } from './index.js';

test('utcDay formats YYYY-MM-DD in UTC', () => {
  assert.equal(utcDay(new Date('2026-07-27T23:59:59Z')), '2026-07-27');
  assert.equal(utcDay(new Date('2026-07-28T00:00:01Z')), '2026-07-28');
});

test('stepUsage accumulates within a day', () => {
  const s1 = stepUsage(null, '2026-07-27', 5);
  assert.deepEqual(s1, { usage: { date: '2026-07-27', count: 5 }, emit: null });
  const s2 = stepUsage(s1.usage, '2026-07-27', 3);
  assert.deepEqual(s2, { usage: { date: '2026-07-27', count: 8 }, emit: null });
});

test('stepUsage emits the completed prior day exactly once on rollover', () => {
  const prev = { date: '2026-07-27', count: 3159 };
  const s = stepUsage(prev, '2026-07-28', 2);
  assert.deepEqual(s.usage, { date: '2026-07-28', count: 2 });
  assert.deepEqual(s.emit, prev);
  // A zero-usage prior day is not emitted.
  assert.equal(stepUsage({ date: '2026-07-27', count: 0 }, '2026-07-28', 1).emit, null);
});

test('a backward date (clock correction / stale caller) folds into the newer bucket, no emit', () => {
  const prev = { date: '2026-07-28', count: 100 };
  const s = stepUsage(prev, '2026-07-27', 5);
  assert.deepEqual(s, { usage: { date: '2026-07-28', count: 105 }, emit: null });
});

test('classifyUsage thresholds', () => {
  assert.deepEqual(classifyUsage(2500, 5000), { pct: 50, nearCap: false });
  assert.deepEqual(classifyUsage(4000, 5000), { pct: 80, nearCap: true });
  assert.deepEqual(classifyUsage(3999, 5000), { pct: 80, nearCap: false });
  assert.deepEqual(classifyUsage(100, 100, 50), { pct: 100, nearCap: true });
});

test('authoritative report matches the crm-haverford sync tag contract', () => {
  const r = buildUsageReport({ date: '2026-07-26', count: 2087 }, { consumer: 'sync' });
  assert.equal(r.message, 'cin7 daily usage');
  assert.equal(r.level, 'info');
  assert.deepEqual(r.tags, {
    consumer: 'sync',
    cin7_day: '2026-07-26',
    cin7_usage: '2087',
    cin7_usage_pct: '42',
    cin7_near_cap: 'false',
  });
  assert.equal(r.extra.cap, 5000);
});

test('near-cap day gets its own message (separate Sentry fingerprint) at warning level', () => {
  const r = buildUsageReport({ date: '2026-07-27', count: 4200 }, { consumer: 'sync' });
  assert.equal(r.message, 'cin7 daily usage near cap');
  assert.equal(r.level, 'warning');
  assert.equal(r.tags.cin7_near_cap, 'true');
});

test('segment report matches the koenig-sales tag contract: no cap judgement', () => {
  const r = buildUsageReport({ date: '2026-07-27', count: 786 }, { consumer: 'app', segment: true }, 'rollover');
  assert.equal(r.message, 'cin7 daily usage');
  assert.equal(r.level, 'info');
  assert.deepEqual(r.tags, {
    consumer: 'app',
    cin7_day: '2026-07-27',
    cin7_usage: '786',
    cin7_emit_reason: 'rollover',
    cin7_segment: 'true',
  });
  assert.equal('cin7_near_cap' in r.tags, false);
});

test('platform prefix is configurable', () => {
  const r = buildUsageReport({ date: '2026-07-27', count: 10 }, { consumer: 'sync', platform: 'twenty', dailyCap: 720_000 });
  assert.equal(r.message, 'twenty daily usage');
  assert.equal(r.tags.twenty_day, '2026-07-27');
  assert.equal(r.tags.twenty_usage, '10');
});
