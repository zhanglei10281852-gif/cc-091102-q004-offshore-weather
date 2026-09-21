import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function emptyState() {
  return { forecasts: {}, requests: [] };
}

// 恢复：状态文件缺失时从空状态起步，存在则原样读回（日历由内容重新推导）。
export async function loadState(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { forecasts: raw.forecasts ?? {}, requests: raw.requests ?? [] };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

// 保存：先写临时文件再改名，避免中途崩溃留下半个状态文件。
export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}
