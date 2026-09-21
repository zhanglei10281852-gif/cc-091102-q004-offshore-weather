import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createState, applyForecast, addRequest, transitionRequest,
  protectionTimeline, listRequestViews,
} from '../src/domain.js';
import { loadState, saveState } from '../src/store.js';

const SEA92_V4 = {
  forecastId: 'SEA-92', version: 4, hazard: 'thunderstorm', revoked: false,
  validFrom: '2026-09-28T23:30:00+08:00',
  validUntil: '2026-09-29T05:00:00+08:00',
};
const NOW_BEFORE = new Date('2026-09-28T14:00:00Z');
const NOW_MIDNIGHT = new Date('2026-09-28T16:00:00Z');
const NOW_PLAN = new Date('2026-09-28T10:00:00Z');

async function withStateFile(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'weather-state-'));
  const file = join(dir, 'state.json');
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('状态落盘后恢复，日历完全一致', async () => {
  await withStateFile(async (file) => {
    const state = createState();
    addRequest(state, { id: 'R-FUTURE', start: '2026-09-29T01:00:00+08:00', end: '2026-09-29T03:00:00+08:00' }, NOW_PLAN);
    addRequest(state, { id: 'R-LIVE', start: '2026-09-28T22:00:00+08:00', end: '2026-09-29T02:00:00+08:00' }, NOW_PLAN);
    addRequest(state, { id: 'R-SAFE', start: '2026-09-29T06:00:00+08:00', end: '2026-09-29T08:00:00+08:00' }, NOW_PLAN);
    transitionRequest(state, 'R-FUTURE', 'window-held', NOW_PLAN);
    transitionRequest(state, 'R-LIVE', 'window-held', NOW_PLAN);
    transitionRequest(state, 'R-SAFE', 'window-held', NOW_PLAN);
    transitionRequest(state, 'R-SAFE', 'approved', NOW_PLAN);
    // 雷暴预报在作业进行中的午夜时刻到达，触发释放与复核
    applyForecast(state, SEA92_V4, NOW_MIDNIGHT);

    const before = {
      timeline: protectionTimeline(state),
      views: listRequestViews(state, NOW_MIDNIGHT),
    };
    await saveState(state, file);

    const restored = await loadState(file);
    assert.deepEqual(
      protectionTimeline(restored).map(([s, e]) => [s.getTime(), e.getTime()]),
      before.timeline.map(([s, e]) => [s.getTime(), e.getTime()]),
    );
    assert.deepEqual(listRequestViews(restored, NOW_MIDNIGHT), before.views);

    // 恢复后继续接受新版本：v5 替换 v4，判定随之更新
    applyForecast(restored, { ...SEA92_V4, version: 5, validUntil: '2026-09-29T03:00:00+08:00' }, NOW_MIDNIGHT);
    const live = listRequestViews(restored, NOW_MIDNIGHT).find((v) => v.id === 'R-LIVE');
    assert.equal(live.category, 'review'); // 进行中作业仍在新区间内
  });
});

test('存档不存在时返回空状态', async () => {
  await withStateFile(async (file) => {
    const state = await loadState(file);
    assert.deepEqual(protectionTimeline(state), []);
  });
});
