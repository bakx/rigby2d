import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { createToolRegistry } from '../src/mcp/registry.js';
import { Workspace } from '../src/mcp/tools.js';

test('MCP bundle contains a valid manifest and its referenced server and icon', async () => {
  execFileSync(process.execPath, ['mcpb/build.mjs'], { stdio: 'pipe' });
  const entries = unzipSync(readFileSync('dist-mcpb/Rigby2D-AI.mcpb'));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.equal(manifest.manifest_version, '0.3');
  assert.ok(entries[manifest.icon]);
  assert.ok(entries[manifest.server.entry_point]);
  assert.ok(entries['server/node_modules/pyodide/pyodide.mjs']);
  const expected = createToolRegistry(await Workspace.open([process.cwd()])).map((tool) => tool.name);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), expected);
  assert.equal(manifest.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.ok(Object.keys(entries).every(name => !name.includes('\\') && !name.startsWith('/')));
});
