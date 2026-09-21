import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  acceptForecast,
  deskView,
  evaluateRequests,
  mergeIntervals,
  protectionCalendar,
  registerRequest,
  splitProtection,
} from '../src/domain.js';

const incident = JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url)));

test('跨日预报展开为连续保护段，午夜无缝', () => {
  const segments = splitProtection(incident); // 23:30+08 → 次日 05:00+08
  assert.equal(segments.length, 2);
  assert.equal(segments[0][0].toISOString(), '2026-09-28T15:30:00.000Z');
  assert.equal(segments[0][1].toISOString(), '2026-09-28T16:00:00.000Z'); // 当地 24:00
  assert.equal(segments[1][0].toISOString(), '2026-09-28T16:00:00.000Z'); // 当地 00:00
  assert.equal(segments[1][1].toISOString(), '2026-09-28T21:00:00.000Z');
  assert.equal(segments[0][1].getTime(), segments[1][0].getTime());
});

test('单日预报展开为单个保护段', () => {
  const segments = splitProtection({
    validFrom: '2026-09-28T08:00:00+08:00',
    validUntil: '2026-09-28T12:00:00+08:00',
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0][0].toISOString(), '2026-09-28T00:00:00.000Z');
  assert.equal(segments[0][1].toISOString(), '2026-09-28T04:00:00.000Z');
});

test('重叠或相接的区间合并为连续保护区', () => {
  const merged = mergeIntervals([
    [new Date('2026-09-28T15:30:00Z'), new Date('2026-09-28T16:00:00Z')],
    [new Date('2026-09-28T16:00:00Z'), new Date('2026-09-28T21:00:00Z')],
    [new Date('2026-09-28T20:00:00Z'), new Date('2026-09-28T22:00:00Z')],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0][0].toISOString(), '2026-09-28T15:30:00.000Z');
  assert.equal(merged[0][1].toISOString(), '2026-09-28T22:00:00.000Z');
});

test('较新版本替换同来源旧版，旧版后到达被忽略', () => {
  const state = { forecasts: {}, requests: [] };
  acceptForecast(state, incident); // v4
  const calendar = protectionCalendar(state);
  acceptForecast(state, { ...incident, version: 3, validUntil: '2026-09-29T02:00:00+08:00' });
  assert.deepEqual(protectionCalendar(state), calendar);
  acceptForecast(state, { ...incident, version: 5, validUntil: '2026-09-29T06:00:00+08:00' });
  const updated = protectionCalendar(state);
  assert.equal(updated.length, 1);
  assert.equal(updated[0][1].toISOString(), '2026-09-28T22:00:00.000Z');
});

test('撤销只针对同一来源，更新版本可恢复保护', () => {
  const state = { forecasts: {}, requests: [] };
  acceptForecast(state, incident);
  acceptForecast(state, {
    forecastId: 'SEA-77',
    version: 1,
    validFrom: '2026-09-30T10:00:00+08:00',
    validUntil: '2026-09-30T12:00:00+08:00',
    hazard: 'gale',
    revoked: false,
  });
  acceptForecast(state, { ...incident, version: 5, revoked: true });
  const calendar = protectionCalendar(state);
  assert.equal(calendar.length, 1); // 只剩 SEA-77
  assert.equal(calendar[0][0].toISOString(), '2026-09-30T02:00:00.000Z');
  acceptForecast(state, { ...incident, version: 6, revoked: false });
  assert.equal(protectionCalendar(state).length, 2);
});

test('同一批预报无论先后到达都形成相同日历', () => {
  const batch = [
    { ...incident, version: 3 },
    { ...incident, version: 5, revoked: true },
    incident,
    { ...incident, version: 6, validUntil: '2026-09-29T07:00:00+08:00' },
  ];
  const forward = { forecasts: {}, requests: [] };
  for (const f of batch) acceptForecast(forward, f);
  const reverse = { forecasts: {}, requests: [] };
  for (const f of [...batch].reverse()) acceptForecast(reverse, f);
  assert.deepEqual(protectionCalendar(forward), protectionCalendar(reverse));
  assert.equal(protectionCalendar(forward).length, 1);
});

test('窗口决策：未开始受阻、已开始复核、相邻安全时段照常开放', () => {
  const state = { forecasts: {}, requests: [] };
  acceptForecast(state, incident); // 当地 23:30 → 次日 05:00
  registerRequest(state, { id: 'W1', windowStart: '2026-09-29T00:00:00+08:00', windowEnd: '2026-09-29T02:00:00+08:00' }, new Date('2026-09-28T22:00:00+08:00'));
  registerRequest(state, { id: 'W2', windowStart: '2026-09-29T05:00:00+08:00', windowEnd: '2026-09-29T07:00:00+08:00' }, new Date('2026-09-28T22:00:00+08:00'));
  let requests = evaluateRequests(state, new Date('2026-09-28T22:00:00+08:00'));
  assert.equal(requests.find((r) => r.id === 'W1').status, 'window-held');
  assert.equal(requests.find((r) => r.id === 'W2').status, 'approved'); // 紧贴保护区终点，安全
  requests = evaluateRequests(state, new Date('2026-09-29T01:00:00+08:00'));
  assert.equal(requests.find((r) => r.id === 'W1').status, 'weather-review');
});

test('预报撤销后受阻窗口释放回开放状态', () => {
  const state = { forecasts: {}, requests: [] };
  acceptForecast(state, incident);
  registerRequest(state, { id: 'W1', windowStart: '2026-09-29T00:00:00+08:00', windowEnd: '2026-09-29T02:00:00+08:00' });
  assert.equal(evaluateRequests(state)[0].status, 'window-held');
  acceptForecast(state, { ...incident, version: 5, revoked: true });
  assert.equal(evaluateRequests(state)[0].status, 'approved');
});

test('值班台直接区分受阻、待复核与继续执行', () => {
  const state = { forecasts: {}, requests: [] };
  acceptForecast(state, incident);
  const now = new Date('2026-09-29T01:00:00+08:00');
  registerRequest(state, { id: 'A', windowStart: '2026-09-29T03:00:00+08:00', windowEnd: '2026-09-29T04:00:00+08:00' }, now);
  registerRequest(state, { id: 'B', windowStart: '2026-09-29T00:00:00+08:00', windowEnd: '2026-09-29T02:00:00+08:00' }, now);
  registerRequest(state, { id: 'C', windowStart: '2026-09-29T10:00:00+08:00', windowEnd: '2026-09-29T11:00:00+08:00' }, now);
  const desk = deskView(state, now);
  assert.deepEqual(desk.blocked.map((r) => r.id), ['A']);
  assert.deepEqual(desk.review.map((r) => r.id), ['B']);
  assert.deepEqual(desk.proceed.map((r) => r.id), ['C']);
});
