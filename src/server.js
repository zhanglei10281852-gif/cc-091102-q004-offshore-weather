import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  acceptForecast,
  deskView,
  evaluateRequests,
  protectionCalendar,
  registerRequest,
} from './domain.js';
import { loadState, saveState } from './store.js';

function send(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const calendarJson = (state) =>
  protectionCalendar(state).map(([start, end]) => ({
    from: start.toISOString(),
    until: end.toISOString(),
  }));

export function buildServer(state, { onChange } = {}) {
  const changed = async () => {
    evaluateRequests(state);
    if (onChange) await onChange(state);
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
        return send(response, 200, {
          service: 'offshore-weather',
          status: 'running',
          forecasts: Object.keys(state.forecasts ?? {}).length,
          requests: (state.requests ?? []).length,
        });
      }
      if (request.method === 'POST' && url.pathname === '/forecasts') {
        const body = await readBody(request);
        const batch = Array.isArray(body) ? body : [body];
        for (const forecast of batch) acceptForecast(state, forecast);
        await changed();
        return send(response, 200, { calendar: calendarJson(state), requests: state.requests });
      }
      if (request.method === 'GET' && url.pathname === '/calendar') {
        return send(response, 200, { calendar: calendarJson(state) });
      }
      if (request.method === 'POST' && url.pathname === '/requests') {
        const record = registerRequest(state, await readBody(request));
        await changed();
        return send(response, 201, record);
      }
      if (request.method === 'GET' && url.pathname === '/requests') {
        return send(response, 200, { requests: evaluateRequests(state) });
      }
      if (request.method === 'GET' && url.pathname === '/desk') {
        return send(response, 200, deskView(state));
      }
      send(response, 404, { error: 'not found' });
    } catch (err) {
      send(response, 400, { error: err.message });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const stateFile = process.env.STATE_FILE || 'data/state.json';
  const state = await loadState(stateFile);
  const server = buildServer(state, { onChange: (s) => saveState(stateFile, s) });
  server.listen(Number(process.env.PORT || 8080));
}
