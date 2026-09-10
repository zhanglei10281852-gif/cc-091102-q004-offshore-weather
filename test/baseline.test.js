import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises';
test('预报样例有明确有效期', async () => { const item=JSON.parse(await readFile(new URL('../fixtures/incident.json', import.meta.url))); assert.ok(item.version>0); assert.ok(Date.parse(item.validUntil)>Date.parse(item.validFrom)); });
