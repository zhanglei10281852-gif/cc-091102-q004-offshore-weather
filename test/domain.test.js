import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createState, applyForecast, addRequest, transitionRequest, reviewRequest,
  protectionTimeline, listRequestViews, mergeIntervals, ValidationError,
} from '../src/domain.js';

// 样例雷暴：2026-09-28 23:30 → 09-29 05:00（+08:00），横跨午夜
const SEA92_V4 = {
  forecastId: 'SEA-92', version: 4, hazard: 'thunderstorm', revoked: false,
  validFrom: '2026-09-28T23:30:00+08:00',
  validUntil: '2026-09-29T05:00:00+08:00',
};
const T_FROM = Date.parse('2026-09-28T15:30:00Z');
const T_UNTIL = Date.parse('2026-09-28T21:00:00Z');
// 作业进行中的决策时刻：当地 09-29 00:00（旧实现的“缝隙”内）
const NOW_MIDNIGHT = new Date('2026-09-28T16:00:00Z');
const NOW_BEFORE = new Date('2026-09-28T14:00:00Z');
// 前一天的排班时刻：所有作业尚未开始
const NOW_PLAN = new Date('2026-09-28T10:00:00Z');

test('预报样例有明确有效期', async () => {
  const item = JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url)));
  assert.ok(item.version > 0);
  assert.ok(Date.parse(item.validUntil) > Date.parse(item.validFrom));
});

test('有效期展开为单段连续保护区，午夜无缝隙', () => {
  const state = createState();
  applyForecast(state, SEA92_V4, NOW_BEFORE);
  const timeline = protectionTimeline(state);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0][0].getTime(), T_FROM);
  assert.equal(timeline[0][1].getTime(), T_UNTIL);
});

test('重叠与端点相接的保护区合并', () => {
  const merged = mergeIntervals([
    [new Date('2026-09-28T15:30:00Z'), new Date('2026-09-28T18:00:00Z')],
    [new Date('2026-09-28T18:00:00Z'), new Date('2026-09-28T21:00:00Z')], // 端点相接
  ]);
  assert.equal(merged.length, 1);
  const gapped = mergeIntervals([
    [new Date('2026-09-28T15:30:00Z'), new Date('2026-09-28T17:00:00Z')],
    [new Date('2026-09-28T18:00:00Z'), new Date('2026-09-28T21:00:00Z')],
  ]);
  assert.equal(gapped.length, 2); // 真缝隙保留
});

test('较新版本替换同来源旧版，撤销只作用于同来源', () => {
  const state = createState();
  applyForecast(state, SEA92_V4, NOW_BEFORE);
  const v5 = { ...SEA92_V4, version: 5, validUntil: '2026-09-29T06:00:00+08:00' };
  const result = applyForecast(state, v5, NOW_BEFORE);
  assert.equal(result.outcome, 'replaced');
  assert.equal(protectionTimeline(state)[0][1].getTime(), Date.parse('2026-09-28T22:00:00Z'));

  // 另一个来源不受影响、与新区间留有缝隙时保持独立
  applyForecast(state, {
    forecastId: 'SEA-93', version: 1, hazard: 'gale', revoked: false,
    validFrom: '2026-09-29T06:30:00+08:00', validUntil: '2026-09-29T08:00:00+08:00',
  }, NOW_BEFORE);
  assert.equal(protectionTimeline(state).length, 2);

  applyForecast(state, { ...v5, revoked: true }, NOW_BEFORE);
  const remaining = protectionTimeline(state);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0][0].getTime(), Date.parse('2026-09-28T22:30:00Z')); // 只剩 SEA-93
});

test('迟到旧版本忽略，同版本重复投递幂等，同版本内容冲突报错', () => {
  const state = createState();
  applyForecast(state, { ...SEA92_V4, version: 5 }, NOW_BEFORE);
  const stale = applyForecast(state, SEA92_V4, NOW_BEFORE);
  assert.equal(stale.outcome, 'ignored-stale');
  assert.equal(protectionTimeline(state)[0][1].getTime(), T_UNTIL); // v5 内容与 v4 相同，区间不变
  const dup = applyForecast(state, { ...SEA92_V4, version: 5 }, NOW_BEFORE);
  assert.equal(dup.outcome, 'duplicate');
  assert.throws(
    () => applyForecast(state, { ...SEA92_V4, version: 5, hazard: 'gale' }, NOW_BEFORE),
    ValidationError,
  );
});

test('尚未开始且进入危险区间的已持窗口释放回队列；已开始作业转人工复核；安全相邻时段照常', () => {
  const state = createState();
  // 三条作业：未来受阻、进行中受阻、安全相邻
  addRequest(state, { id: 'R-FUTURE', start: '2026-09-29T01:00:00+08:00', end: '2026-09-29T03:00:00+08:00' }, NOW_BEFORE);
  addRequest(state, { id: 'R-LIVE', start: '2026-09-28T22:00:00+08:00', end: '2026-09-29T02:00:00+08:00' }, NOW_BEFORE);
  addRequest(state, { id: 'R-SAFE', start: '2026-09-29T06:00:00+08:00', end: '2026-09-29T08:00:00+08:00' }, NOW_BEFORE);
  transitionRequest(state, 'R-FUTURE', 'window-held', NOW_PLAN);
  transitionRequest(state, 'R-LIVE', 'window-held', NOW_PLAN);
  transitionRequest(state, 'R-SAFE', 'window-held', NOW_PLAN);
  transitionRequest(state, 'R-SAFE', 'approved', NOW_PLAN);

  applyForecast(state, SEA92_V4, NOW_MIDNIGHT);

  const views = Object.fromEntries(listRequestViews(state, NOW_MIDNIGHT).map((v) => [v.id, v]));
  assert.equal(views['R-FUTURE'].status, 'submitted');
  assert.equal(views['R-FUTURE'].category, 'blocked');
  assert.equal(views['R-LIVE'].status, 'weather-review');
  assert.equal(views['R-LIVE'].category, 'review');
  assert.equal(views['R-SAFE'].status, 'approved');
  assert.equal(views['R-SAFE'].category, 'proceed');
  assert.equal(views['R-SAFE'].blocking.length, 0);
  // 阻塞申请直接带上命中的保护段，无需人工拼接午夜两侧记录
  assert.equal(views['R-FUTURE'].blocking[0].start, '2026-09-28T15:30:00.000Z');
  assert.equal(views['R-FUTURE'].blocking[0].end, '2026-09-28T21:00:00.000Z');
});

test('危险区间内不能占用窗口', () => {
  const state = createState();
  applyForecast(state, SEA92_V4, NOW_BEFORE);
  addRequest(state, { id: 'R1', start: '2026-09-29T01:00:00+08:00', end: '2026-09-29T03:00:00+08:00' }, NOW_BEFORE);
  assert.throws(() => transitionRequest(state, 'R1', 'window-held', NOW_BEFORE), ValidationError);
});

test('进行中作业被雷暴命中转人工复核，复核后可继续或取消', () => {
  const state = createState();
  addRequest(state, { id: 'R2', start: '2026-09-28T22:00:00+08:00', end: '2026-09-29T02:00:00+08:00' }, NOW_PLAN);
  transitionRequest(state, 'R2', 'window-held', NOW_PLAN);
  applyForecast(state, SEA92_V4, NOW_MIDNIGHT);
  const view = listRequestViews(state, NOW_MIDNIGHT).find((v) => v.id === 'R2');
  assert.equal(view.category, 'review');
  reviewRequest(state, 'R2', 'proceed', NOW_MIDNIGHT);
  assert.equal(listRequestViews(state, NOW_MIDNIGHT).find((v) => v.id === 'R2').status, 'approved');
});

test('同一批预报无论先后到达形成相同日历', () => {
  const messages = [
    SEA92_V4,
    { ...SEA92_V4, version: 5, validUntil: '2026-09-29T06:00:00+08:00' },
    { forecastId: 'SEA-93', version: 1, hazard: 'gale', revoked: false,
      validFrom: '2026-09-29T05:30:00+08:00', validUntil: '2026-09-29T08:00:00+08:00' },
    { ...SEA92_V4, version: 3, validUntil: '2026-09-29T04:00:00+08:00' }, // 迟到旧版
    SEA92_V4, // 重复
  ];
  const calendarFor = (order) => {
    const state = createState();
    addRequest(state, { id: 'R1', start: '2026-09-29T01:00:00+08:00', end: '2026-09-29T03:00:00+08:00' }, NOW_BEFORE);
    transitionRequest(state, 'R1', 'window-held', NOW_BEFORE);
    for (const message of order) applyForecast(state, message, NOW_MIDNIGHT);
    return {
      timeline: protectionTimeline(state).map(([s, e]) => [s.toISOString(), e.toISOString()]),
      requests: listRequestViews(state, NOW_MIDNIGHT),
    };
  };
  const a = calendarFor(messages);
  const b = calendarFor([...messages].reverse());
  const c = calendarFor([messages[2], messages[4], messages[1], messages[3], messages[0]]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  // v5 与 SEA-93 在 06:00 当地相接（v5 至 06:00 +08，SEA-93 从 05:30 +08 重叠）-> 合并成一段
  assert.equal(a.timeline.length, 1);
  assert.equal(a.requests[0].status, 'submitted');
});

test('非法预报被拒绝', () => {
  const state = createState();
  assert.throws(() => applyForecast(state, { ...SEA92_V4, version: 0 }, NOW_BEFORE), ValidationError);
  assert.throws(() => applyForecast(state, { ...SEA92_V4, validUntil: '2026-09-28T23:00:00+08:00' }, NOW_BEFORE), ValidationError);
  assert.throws(() => applyForecast(state, { ...SEA92_V4, validFrom: 'not-a-date' }, NOW_BEFORE), ValidationError);
});
