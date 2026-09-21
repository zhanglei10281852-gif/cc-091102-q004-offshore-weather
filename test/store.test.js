import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptForecast, protectionCalendar } from '../src/domain.js';
import { loadState, saveState } from '../src/store.js';

const incident = JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url)));

test('状态保存后可完整恢复，日历一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-store-'));
  try {
    const file = join(dir, 'state.json');
    const state = { forecasts: {}, requests: [] };
    acceptForecast(state, incident);
    acceptForecast(state, { ...incident, version: 5, validUntil: '2026-09-29T06:00:00+08:00' });
    await saveState(file, state);
    const restored = await loadState(file);
    assert.deepEqual(restored, state);
    assert.deepEqual(protectionCalendar(restored), protectionCalendar(state));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('状态文件缺失时恢复为空状态', async () => {
  const state = await loadState(join(tmpdir(), 'no-such-dir-weather', 'state.json'));
  assert.deepEqual(state, { forecasts: {}, requests: [] });
});
