import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';

test('MCP bundle contains a valid manifest and its referenced server and icon', () => {
  execFileSync(process.execPath, ['mcpb/build.mjs'], { stdio: 'pipe' });
  const entries = unzipSync(readFileSync('dist-mcpb/Rigby2D-AI.mcpb'));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.equal(manifest.manifest_version, '0.3');
  assert.ok(entries[manifest.icon]);
  assert.ok(entries[manifest.server.entry_point]);
  assert.ok(entries['server/node_modules/pyodide/pyodide.mjs']);
  assert.ok(manifest.tools.length > 0);
  assert.ok(Object.keys(entries).every(name => !name.includes('\\') && !name.startsWith('/')));
});
