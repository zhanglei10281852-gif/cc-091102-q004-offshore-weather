// 海上风电气象窗口领域逻辑（无 IO，可单测）。
// 所有时间在内部一律用 Date（绝对时刻）表达，输入的 ISO 字符串带时区偏移即可。

export const requestStates = ['submitted', 'window-held', 'approved', 'weather-review', 'cancelled'];

// 值班台直接看到的作业分类：受阻 / 待复核 / 继续执行 / 排队 / 已取消
export const requestCategories = ['blocked', 'review', 'proceed', 'queued', 'cancelled'];

export class ValidationError extends Error {}

const SCHEMA_VERSION = 1;

export function toInstant(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} 不是有效时间`);
  return date;
}

export function createState() {
  return { schemaVersion: SCHEMA_VERSION, forecasts: new Map(), requests: [] };
}

function normalizeForecast(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('预报必须是对象');
  const forecastId = String(raw.forecastId ?? '').trim();
  if (!forecastId) throw new ValidationError('forecastId 必填');
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    throw new ValidationError('version 必须是正整数');
  }
  const validFrom = toInstant(raw.validFrom, 'validFrom');
  const validUntil = toInstant(raw.validUntil, 'validUntil');
  if (validUntil <= validFrom) throw new ValidationError('validUntil 必须晚于 validFrom');
  const hazard = String(raw.hazard ?? '').trim();
  if (!hazard) throw new ValidationError('hazard 必填');
  return { forecastId, version: raw.version, validFrom, validUntil, hazard, revoked: Boolean(raw.revoked) };
}

function sameForecastPayload(a, b) {
  return a.version === b.version
    && a.validFrom.getTime() === b.validFrom.getTime()
    && a.validUntil.getTime() === b.validUntil.getTime()
    && a.hazard === b.hazard
    && a.revoked === b.revoked;
}

// 端点相接（a.end === b.start）也算连续，合并为同一段保护区，午夜不再有缝隙。
export function mergeIntervals(intervals) {
  const sorted = intervals
    .map(([start, end]) => [start.getTime(), end.getTime()])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged.map(([start, end]) => [new Date(start), new Date(end)]);
}

// 当前生效的连续禁航保护段（已撤销的同来源预报不参与）。
export function protectionTimeline(state) {
  const intervals = [...state.forecasts.values()]
    .filter((forecast) => !forecast.revoked)
    .map((forecast) => [forecast.validFrom, forecast.validUntil]);
  return mergeIntervals(intervals);
}

// 半开区间相交：端点相接（作业 end === 保护 start）不算冲突。
export function overlappingSegments(timeline, start, end) {
  const s = start.getTime();
  const e = end.getTime();
  return timeline.filter(([pStart, pEnd]) => s < pEnd.getTime() && e > pStart.getTime());
}

// 预报到达后重新评估全部申请：
// - 已开始且进入危险区间的作业 -> weather-review（人工复核，系统不自动改回）
// - 尚未开始且进入危险区间的已持窗口/已批准申请 -> 释放回 submitted 队列
// - 确认安全的相邻时段一律保持原状
function reconcileRequests(state, now) {
  const timeline = protectionTimeline(state);
  for (const request of state.requests) {
    if (request.status === 'cancelled' || request.status === 'weather-review') continue;
    if (request.end <= now) continue; // 作业已结束，不再翻动
    const blocked = overlappingSegments(timeline, request.start, request.end).length > 0;
    if (!blocked) continue;
    const inProgress = request.start <= now;
    if (inProgress) {
      request.status = 'weather-review';
    } else if (request.status === 'window-held' || request.status === 'approved') {
      request.status = 'submitted';
    }
  }
}

export function forecastView(forecast) {
  return {
    forecastId: forecast.forecastId,
    version: forecast.version,
    validFrom: forecast.validFrom.toISOString(),
    validUntil: forecast.validUntil.toISOString(),
    hazard: forecast.hazard,
    revoked: forecast.revoked,
    receivedAt: forecast.receivedAt.toISOString(),
  };
}

// 接入一条预报。返回 outcome：
// inserted 新版入库 / replaced 替换同来源旧版 / revoked 撤销同来源旧版
// duplicate 同版本同内容幂等忽略 / ignored-stale 旧版本迟到忽略
export function applyForecast(state, rawIncoming, now = new Date()) {
  const incoming = normalizeForecast(rawIncoming);
  const existing = state.forecasts.get(incoming.forecastId);

  if (existing && existing.version > incoming.version) {
    return { outcome: 'ignored-stale', forecast: forecastView(existing) };
  }
  if (existing && existing.version === incoming.version) {
    if (sameForecastPayload(existing, incoming)) {
      return { outcome: 'duplicate', forecast: forecastView(existing) };
    }
    // 同版本唯一允许的变化是撤销标记（撤销消息只带版本号 + revoked:true）
    const onlyRevoked = !existing.revoked && incoming.revoked
      && existing.validFrom.getTime() === incoming.validFrom.getTime()
      && existing.validUntil.getTime() === incoming.validUntil.getTime()
      && existing.hazard === incoming.hazard;
    if (!onlyRevoked) {
      throw new ValidationError(`来源 ${incoming.forecastId} 的版本 ${incoming.version} 内容与已收预报冲突`);
    }
  }

  const stored = { ...incoming, receivedAt: now };
  state.forecasts.set(incoming.forecastId, stored);
  reconcileRequests(state, now);
  const outcome = incoming.revoked
    ? (existing ? 'revoked' : 'inserted')
    : (existing ? 'replaced' : 'inserted');
  return { outcome, forecast: forecastView(stored) };
}

function getRequest(state, id) {
  const request = state.requests.find((item) => item.id === id);
  if (!request) throw new ValidationError(`申请 ${id} 不存在`);
  return request;
}

export function addRequest(state, input, now = new Date()) {
  if (!input || typeof input !== 'object') throw new ValidationError('申请必须是对象');
  const id = input.id ? String(input.id) : `REQ-${Math.random().toString(36).slice(2, 10)}`;
  if (state.requests.some((item) => item.id === id)) throw new ValidationError(`申请 ${id} 已存在`);
  const start = toInstant(input.start, 'start');
  const end = toInstant(input.end, 'end');
  if (end <= start) throw new ValidationError('end 必须晚于 start');
  const vessel = input.vessel === undefined ? null : String(input.vessel);
  const request = { id, vessel, start, end, status: 'submitted', createdAt: now };
  state.requests.push(request);
  return request;
}

const TRANSITIONS = {
  submitted: new Set(['window-held', 'cancelled']),
  'window-held': new Set(['approved', 'submitted', 'cancelled']),
  approved: new Set(['cancelled']),
  'weather-review': new Set(),
  cancelled: new Set(),
};

// 排班动作：占窗口（window-held）/ 批准（approved）/ 释放 / 取消。
// 占用或批准的窗口必须当前安全，否则拒绝。
export function transitionRequest(state, id, nextStatus, now = new Date()) {
  if (!requestStates.includes(nextStatus)) throw new ValidationError(`未知状态 ${nextStatus}`);
  const request = getRequest(state, id);
  if (!TRANSITIONS[request.status].has(nextStatus)) {
    throw new ValidationError(`申请 ${id} 不能从 ${request.status} 转为 ${nextStatus}`);
  }
  if (nextStatus === 'window-held' || nextStatus === 'approved') {
    if (request.start <= now) throw new ValidationError(`申请 ${id} 已开始，不能再占用/批准窗口`);
    const blocking = overlappingSegments(protectionTimeline(state), request.start, request.end);
    if (blocking.length > 0) throw new ValidationError(`申请 ${id} 的窗口与禁航保护段冲突`);
  }
  request.status = nextStatus;
  return request;
}

// 已开始作业进入危险区间后的人工复核结论：继续 -> 批准，取消 -> 取消。
export function reviewRequest(state, id, decision, now = new Date()) {
  const request = getRequest(state, id);
  if (request.status !== 'weather-review') {
    throw new ValidationError(`申请 ${id} 当前为 ${request.status}，不在待复核状态`);
  }
  const next = { proceed: 'approved', cancel: 'cancelled' }[decision];
  if (!next) throw new ValidationError('decision 必须是 proceed 或 cancel');
  request.status = next;
  request.reviewedAt = now;
  return request;
}

function categoryOf(request, blocking, now) {
  if (request.status === 'weather-review') return 'review';
  if (request.status === 'cancelled') return 'cancelled';
  const active = request.status === 'approved' || request.status === 'window-held';
  if (request.end > now && blocking.length > 0) return 'blocked';
  if (active) return 'proceed';
  return 'queued';
}

function buildRequestView(request, blocking, now) {
  return {
    id: request.id,
    vessel: request.vessel,
    start: request.start.toISOString(),
    end: request.end.toISOString(),
    status: request.status,
    category: categoryOf(request, blocking, now),
    blocking: blocking.map(([start, end]) => ({ start: start.toISOString(), end: end.toISOString() })),
  };
}

export function getRequestView(state, id, now = new Date()) {
  const request = getRequest(state, id);
  const blocking = overlappingSegments(protectionTimeline(state), request.start, request.end);
  return buildRequestView(request, blocking, now);
}

// 值班台视图：每个申请直接带三分类（外加排队/取消）与命中的保护段。
export function listRequestViews(state, now = new Date()) {
  const timeline = protectionTimeline(state);
  return state.requests.map((request) =>
    buildRequestView(request, overlappingSegments(timeline, request.start, request.end), now));
}

// ---- 保存与恢复：落盘 JSON 中所有时刻序列化为 ISO 字符串 ----

export function serializeState(state) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    forecasts: [...state.forecasts.values()].map(forecastView),
    requests: state.requests.map((request) => ({
      ...requestViewShape(request),
      createdAt: request.createdAt.toISOString(),
      ...(request.reviewedAt ? { reviewedAt: request.reviewedAt.toISOString() } : {}),
    })),
  }, null, 2);
}

function requestViewShape(request) {
  return {
    id: request.id,
    vessel: request.vessel,
    start: request.start.toISOString(),
    end: request.end.toISOString(),
    status: request.status,
  };
}

function reviveInstant(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`存档时间无法解析: ${value}`);
  return date;
}

export function deserializeState(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`存档不是合法 JSON: ${error.message}`);
  }
  if (!data || data.schemaVersion !== SCHEMA_VERSION) {
    throw new ValidationError(`不支持的存档版本: ${data?.schemaVersion}`);
  }
  const state = createState();
  for (const raw of data.forecasts ?? []) {
    state.forecasts.set(raw.forecastId, {
      forecastId: raw.forecastId,
      version: raw.version,
      validFrom: reviveInstant(raw.validFrom),
      validUntil: reviveInstant(raw.validUntil),
      hazard: raw.hazard,
      revoked: Boolean(raw.revoked),
      receivedAt: reviveInstant(raw.receivedAt),
    });
  }
  for (const raw of data.requests ?? []) {
    if (!requestStates.includes(raw.status)) throw new ValidationError(`存档中申请状态非法: ${raw.status}`);
    state.requests.push({
      id: raw.id,
      vessel: raw.vessel ?? null,
      start: reviveInstant(raw.start),
      end: reviveInstant(raw.end),
      status: raw.status,
      createdAt: reviveInstant(raw.createdAt),
      ...(raw.reviewedAt ? { reviewedAt: reviveInstant(raw.reviewedAt) } : {}),
    });
  }
  return state;
}
