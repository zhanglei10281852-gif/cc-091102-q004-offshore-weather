export const requestStates = ['submitted', 'window-held', 'approved', 'weather-review', 'cancelled'];

const DAY_MS = 86_400_000;

// 预报自带时区偏移（如 +08:00），按作业当地日历日切分，避免依赖运行环境时区。
function offsetMinutesOf(isoString) {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(String(isoString));
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

// 把预报有效期展开为按日历日切分的连续保护段：跨日时段在午夜首尾相接，不留缝隙。
export function splitProtection(forecast) {
  const start = new Date(forecast.validFrom);
  const end = new Date(forecast.validUntil);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new TypeError('forecast validFrom/validUntil must be ISO 8601 datetimes');
  }
  if (end <= start) throw new RangeError('validUntil must be after validFrom');
  const offsetMs = offsetMinutesOf(forecast.validFrom) * 60_000;
  const segments = [];
  let cursor = start.getTime();
  while (cursor < end.getTime()) {
    const localDayEnd = Math.floor((cursor + offsetMs) / DAY_MS) * DAY_MS + DAY_MS - offsetMs;
    const segmentEnd = Math.min(localDayEnd, end.getTime());
    segments.push([new Date(cursor), new Date(segmentEnd)]);
    cursor = segmentEnd;
  }
  return segments;
}

// 重叠或首尾相接的区间合并为一条连续保护区。
export function mergeIntervals(intervals) {
  const sorted = intervals
    .map(([s, e]) => [new Date(s), new Date(e)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function validateForecast(forecast) {
  if (!forecast || typeof forecast.forecastId !== 'string' || !forecast.forecastId) {
    throw new TypeError('forecastId is required');
  }
  if (!Number.isInteger(forecast.version) || forecast.version <= 0) {
    throw new TypeError('version must be a positive integer');
  }
  const start = Date.parse(forecast.validFrom);
  const end = Date.parse(forecast.validUntil);
  if (!(end > start)) throw new RangeError('validUntil must be after validFrom');
}

// 气象接入：同一来源只保留最高版本，较新版本替换或撤销旧版。
// 低版本或重复版本后到达时被忽略，因此同一批预报无论先后到达都形成相同日历。
export function acceptForecast(state, incoming) {
  validateForecast(incoming);
  state.forecasts ??= {};
  const current = state.forecasts[incoming.forecastId];
  if (!current || incoming.version > current.version) {
    state.forecasts[incoming.forecastId] = { ...incoming };
  }
  return protectionCalendar(state);
}

// 禁航日历：所有未撤销来源的有效期合并为连续保护区，跨午夜不再断开。
export function protectionCalendar(state) {
  const active = Object.values(state.forecasts ?? {}).filter((f) => !f.revoked);
  return mergeIntervals(active.map((f) => [new Date(f.validFrom), new Date(f.validUntil)]));
}

function overlaps(calendar, windowStartMs, windowEndMs) {
  return calendar.some(([s, e]) => windowStartMs < e.getTime() && windowEndMs > s.getTime());
}

// 窗口决策：与保护区重叠且已开始的转人工复核，尚未开始的释放回队列，
// 落在保护区外（含相邻时段）的确认安全照常开放。状态由当前日历纯推导，可重放。
export function evaluateRequests(state, now = new Date()) {
  const calendar = protectionCalendar(state);
  const nowMs = now.getTime();
  state.requests = (state.requests ?? []).map((request) => {
    if (request.status === 'cancelled') return request;
    const startMs = Date.parse(request.windowStart);
    const endMs = Date.parse(request.windowEnd);
    let status = 'approved';
    if (overlaps(calendar, startMs, endMs)) {
      status = startMs <= nowMs ? 'weather-review' : 'window-held';
    }
    return { ...request, status };
  });
  return state.requests;
}

export function registerRequest(state, request, now = new Date()) {
  if (!request || typeof request.id !== 'string' || !request.id) {
    throw new TypeError('request id is required');
  }
  const startMs = Date.parse(request.windowStart);
  const endMs = Date.parse(request.windowEnd);
  if (!(endMs > startMs)) throw new RangeError('windowEnd must be after windowStart');
  state.requests ??= [];
  const index = state.requests.findIndex((r) => r.id === request.id);
  if (index >= 0 && state.requests[index].status === 'cancelled') return state.requests[index];
  const record = {
    id: request.id,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    status: 'submitted',
  };
  if (index >= 0) state.requests[index] = record;
  else state.requests.push(record);
  evaluateRequests(state, now);
  return state.requests.find((r) => r.id === request.id);
}

// 值班台视图：直接区分受阻、待复核与继续执行，无需人工拼接午夜两侧记录。
export function deskView(state, now = new Date()) {
  const requests = evaluateRequests(state, now);
  return {
    blocked: requests.filter((r) => r.status === 'window-held'),
    review: requests.filter((r) => r.status === 'weather-review'),
    proceed: requests.filter((r) => r.status === 'approved'),
  };
}
