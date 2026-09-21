import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildServer } from '../src/server.js';

const incident = JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url)));

async function withServer(state, run) {
  const server = buildServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('状态接口保持可用', async () => {
  await withServer({ forecasts: {}, requests: [] }, async (base) => {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, 'offshore-weather');
    assert.equal(body.status, 'running');
  });
});

test('接入预报后日历连续，值班台直接给出分类', async () => {
  await withServer({ forecasts: {}, requests: [] }, async (base) => {
    const forecastRes = await post(base, '/forecasts', incident);
    assert.equal(forecastRes.status, 200);
    const { calendar } = await forecastRes.json();
    assert.equal(calendar.length, 1); // 跨午夜合并为一条连续保护区
    assert.equal(calendar[0].from, '2026-09-28T15:30:00.000Z');
    assert.equal(calendar[0].until, '2026-09-28T21:00:00.000Z');

    await post(base, '/requests', { id: 'W1', windowStart: '2026-09-29T00:00:00+08:00', windowEnd: '2026-09-29T02:00:00+08:00' });
    await post(base, '/requests', { id: 'W2', windowStart: '2026-09-29T10:00:00+08:00', windowEnd: '2026-09-29T11:00:00+08:00' });

    const desk = await (await fetch(`${base}/desk`)).json();
    assert.deepEqual(desk.blocked.map((r) => r.id), ['W1']);
    assert.deepEqual(desk.review, []);
    assert.deepEqual(desk.proceed.map((r) => r.id), ['W2']);
  });
});

test('批量预报乱序提交与顺序提交得到相同日历', async () => {
  const batch = [
    { ...incident, version: 3 },
    { ...incident, version: 5, revoked: true },
    { ...incident, version: 4 },
    { ...incident, version: 6, validUntil: '2026-09-29T07:00:00+08:00' },
  ];
  const calendars = [];
  for (const batchToSend of [batch, [...batch].reverse()]) {
    await withServer({ forecasts: {}, requests: [] }, async (base) => {
      const res = await post(base, '/forecasts', batchToSend);
      calendars.push((await res.json()).calendar);
    });
  }
  assert.deepEqual(calendars[0], calendars[1]);
});

test('非法预报被拒绝且不影响已有状态', async () => {
  await withServer({ forecasts: {}, requests: [] }, async (base) => {
    await post(base, '/forecasts', incident);
    const bad = await post(base, '/forecasts', { forecastId: 'SEA-92', version: 9, validFrom: '2026-09-29T05:00:00+08:00', validUntil: '2026-09-28T23:30:00+08:00' });
    assert.equal(bad.status, 400);
    const { calendar } = await (await fetch(`${base}/calendar`)).json();
    assert.equal(calendar.length, 1);
    assert.equal(calendar[0].until, '2026-09-28T21:00:00.000Z');
  });
});
