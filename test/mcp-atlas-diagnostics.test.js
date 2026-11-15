// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Workspace, createTools } from '../src/mcp/tools.js';
import { encodePng } from '../src/mcp/png.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-atlas-diagnostics-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const model = { skeleton: { spine: '4.2.0' }, bones: [{ name: 'root' }], slots: [{ name: 'slot', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { slot: { art: { width: 8, height: 8 } } } }] };
  await fs.writeFile(path.join(dir, 'model.json'), JSON.stringify(model));
  const image = encodePng({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) });
  await fs.writeFile(path.join(dir, 'page.png'), image);
  await fs.writeFile(path.join(dir, 'extra.png'), image);
  const atlas = (width = 8) => `page.png\nsize: ${width},8\nfilter: Linear,Linear\nart\n  bounds: 0,0,8,8\n\nextra.png\nsize: 8,8\nfilter: Linear,Linear\nunused\n  bounds: 0,0,8,8\n`;
  await fs.writeFile(path.join(dir, 'model.atlas'), atlas());
  const ws = await Workspace.open([dir]);
  const tools = Object.fromEntries(createTools(ws).map(tool => [tool.name, args => tool.handler({ path: 'model.json', ...args })]));
  return { dir, tools, atlas };
}

test('MCP reports atlas page metadata and validates every image and its dimensions', async t => {
  const { dir, tools, atlas } = await fixture(t);
  const info = await tools.inspect_project({});
  assert.deepEqual(info.atlasPages.map(p => [p.file, p.width, p.height, p.regions]), [['page.png', 8, 8, 1], ['extra.png', 8, 8, 1]]);
  let result = await tools.validate_project({});
  assert.equal(result.valid, true);
  assert.equal(result.checks.atlasPages, 'ok');
  await fs.writeFile(path.join(dir, 'model.atlas'), atlas(9));
  result = await tools.validate_project({});
  assert.equal(result.valid, false);
  assert.equal(result.checks.atlasPages, 'failed');
  assert.ok(result.errors.some(e => /declares 9×8/.test(e)));
  await fs.writeFile(path.join(dir, 'model.atlas'), atlas());
  await fs.unlink(path.join(dir, 'extra.png'));
  result = await tools.validate_project({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /extra\.png.*missing/.test(e)));
  await fs.writeFile(path.join(dir, 'extra.png'), 'invalid image');
  result = await tools.validate_project({});
  assert.equal(result.valid, false);
  assert.equal(result.checks.atlasPages, 'failed');
});
