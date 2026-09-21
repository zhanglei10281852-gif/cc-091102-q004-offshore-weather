import { createServer } from 'node:http';
import {
  applyForecast,
  addRequest,
  transitionRequest,
  reviewRequest,
  listRequestViews,
  getRequestView,
  protectionTimeline,
  ValidationError,
} from './domain.js';
import { loadState, saveState, stateFilePath } from './store.js';

export function createApp(state, { persist } = {}) {
  async function mutate(fn, request, response) {
    try {
      const result = fn();
      if (persist) await persist();
      sendJson(response, 200, result);
    } catch (error) {
      sendError(response, error);
    }
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const now = new Date();
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { service: 'offshore-weather', status: 'running' });
      }
      if (request.method === 'GET' && url.pathname === '/timeline') {
        return sendJson(response, 200, {
          protection: protectionTimeline(state).map(([start, end]) => ({
            start: start.toISOString(), end: end.toISOString(),
          })),
        });
      }
      if (request.method === 'GET' && url.pathname === '/requests') {
        return sendJson(response, 200, { requests: listRequestViews(state, now) });
      }
      const requestMatch = url.pathname.match(/^\/requests\/([^/]+)$/);
      if (request.method === 'GET' && requestMatch) {
        return sendJson(response, 200, getRequestView(state, decodeURIComponent(requestMatch[1]), now));
      }
      if (request.method === 'POST' && url.pathname === '/forecasts') {
        const body = await readJson(request);
        return mutate(() => applyForecast(state, body, now), request, response);
      }
      if (request.method === 'POST' && url.pathname === '/requests') {
        const body = await readJson(request);
        return mutate(() => {
          const created = addRequest(state, body, now);
          return getRequestView(state, created.id, now);
        }, request, response);
      }
      const transitionMatch = url.pathname.match(/^\/requests\/([^/]+)\/transition$/);
      if (request.method === 'POST' && transitionMatch) {
        const body = await readJson(request);
        return mutate(() => {
          transitionRequest(state, decodeURIComponent(transitionMatch[1]), body.status, now);
          return getRequestView(state, decodeURIComponent(transitionMatch[1]), now);
        }, request, response);
      }
      const reviewMatch = url.pathname.match(/^\/requests\/([^/]+)\/review$/);
      if (request.method === 'POST' && reviewMatch) {
        const body = await readJson(request);
        return mutate(() => {
          reviewRequest(state, decodeURIComponent(reviewMatch[1]), body.decision, now);
          return getRequestView(state, decodeURIComponent(reviewMatch[1]), now);
        }, request, response);
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      sendError(response, error);
    }
  });
}

function sendJson(response, status, payload) {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.writeHead(status);
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  const status = error instanceof ValidationError ? 400 : 500;
  sendJson(response, status, { error: error.message });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new ValidationError(`请求体不是合法 JSON: ${error.message}`));
      }
    });
    request.on('error', reject);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const state = await loadState();
  const server = createApp(state, { persist: () => saveState(state) });
  server.listen(Number(process.env.PORT || 8080), () => {
    console.log(`offshore-weather 状态接口监听端口 ${process.env.PORT || 8080}，存档 ${stateFilePath()}`);
  });
}
