// 状态持久化：JSON 文件 + 临时文件原子替换。目录默认 ./data，可用 WEATHER_DATA_DIR 覆盖。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createState, deserializeState, serializeState } from './domain.js';

export const DEFAULT_STATE_FILE = join(process.cwd(), 'data', 'state.json');

export function stateFilePath() {
  return process.env.WEATHER_STATE_FILE
    || join(process.env.WEATHER_DATA_DIR || join(process.cwd(), 'data'), 'state.json');
}

export async function saveState(state, file = stateFilePath()) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, serializeState(state), 'utf8');
  await rename(tmp, file);
}

export async function loadState(file = stateFilePath()) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return createState();
    throw error;
  }
  return deserializeState(text);
}
