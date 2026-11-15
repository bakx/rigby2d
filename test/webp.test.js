// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodePng } from '../src/mcp/png.js';
import { createTools, loadProject, projectImages, Workspace } from '../src/mcp/tools.js';

test('Node project tools unpack and render WebP atlas pages', async t => {
  const check = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
  if (check.error?.code === 'ENOENT') { t.skip('FFmpeg is not installed'); return; }
  assert.equal(check.status, 0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-webp-test-'));
  try {
    // A generated, solid-color lossless WebP image.
    const webp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvD8ADAAdQlCKXp/+BiOh/AAA=', 'base64');
    await fs.writeFile(path.join(dir, 'page.webp'), webp);
    await fs.writeFile(path.join(dir, 'model.atlas'), 'page.webp\nsize: 16,16\nfilter: Linear,Linear\nrepeat: none\nbody\n  bounds: 0,0,16,16\n');
    const model = { skeleton: { spine: '4.2.0' }, bones: [{ name: 'root' }], slots: [{ name: 'slot', bone: 'root', attachment: 'body' }], skins: [{ name: 'default', attachments: { slot: { body: { width: 16, height: 16 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 20 }] } } } } };
    const file = path.join(dir, 'model.json');
    await fs.writeFile(file, JSON.stringify(model));
    const images = await projectImages(await loadProject(file), new Set(['body']));
    assert.ok(images.get('body').rgba[0] > 180);
    const tool = createTools(await Workspace.open([dir])).find(x => x.name === 'export_sprite_sheet');
    await tool.handler({ input: file, output_folder: dir, name: 'sheet', fps: 2 });
    const sheet = decodePng(await fs.readFile(path.join(dir, 'sheet.png')));
    assert.ok(sheet.data.some((v, i) => i % 4 === 3 && v > 0));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
