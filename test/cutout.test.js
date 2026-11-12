// SPDX-License-Identifier: MIT OR Apache-2.0
// Background cutout: the core function, the cutout_image and build_psd tools, and cutout on import.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import jpeg from 'jpeg-js';
import { cutout } from '../src/core/cutout.js';
import { transform } from '../src/core/math.js';
import { Skeleton, makeAttachment, makeBone, makeSlot } from '../src/core/model.js';
import { createEditTools, save } from '../src/mcp/edits.js';
import { decodePng, encodePng } from '../src/mcp/png.js';
import { createRiggingTools, importPsd } from '../src/mcp/rigging.js';
import { Workspace, createTools, loadProject } from '../src/mcp/tools.js';

const WHITE = [255, 255, 255], INK = [42, 32, 32], FILL = [240, 240, 240], DARK_BG = [0x14, 0x10, 0x18];
const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
const px = ({ width, data }, x, y) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));

/**
 * A 120x120 test picture on white: a disc of radius 40 at (60, 60) with a 6px dark outline,
 * a near-white fill and a pure-white highlight inside, anti-aliased by 4x4 supersampling.
 * `speck` adds a 3x3 dark speck; `enclosed` makes the fill pure white (a background-coloured pocket).
 */
function disc({ speck = false, enclosed = false } = {}) {
  const width = 120, height = 120, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const X = x + (sx + 0.5) / 4, Y = y + (sy + 0.5) / 4, r = Math.hypot(X - 60, Y - 60);
      const c = r > 40 ? WHITE : r >= 34 ? INK : Math.hypot(X - 50, Y - 50) < 6 || enclosed ? WHITE : FILL;
      for (let k = 0; k < 3; k++) sum[k] += c[k];
    }
    const i = (y * width + x) * 4;
    for (let k = 0; k < 3; k++) data[i + k] = Math.round(sum[k] / 16);
    data[i + 3] = 255;
    if (speck && x >= 100 && x < 103 && y >= 10 && y < 13) data.set(INK, i);
  }
  return { width, height, data };
}

test('cutout: the white outside goes transparent, the inside highlight stays, and the fringe un-mixes to the outline colour', () => {
  const src = disc({ speck: true });
  const r = cutout(src);
  assert.equal(r.background, '#ffffff'); assert.equal(r.uniform, 1); assert.deepEqual(r.warnings, []);
  assert.equal(px(r.image, 5, 5)[3], 0); assert.equal(px(r.image, 60, 5)[3], 0);
  assert.deepEqual(px(r.image, 50, 50), [255, 255, 255, 255], 'highlight kept with holes off');
  assert.deepEqual(px(r.image, 60, 60), [...FILL, 255]);
  assert.equal(px(r.image, 101, 11)[3], 0, 'the 3x3 speck is dropped');
  assert.ok(r.removed > 120 * 120 - Math.PI * 41 * 41 && r.removed < 120 * 120 - Math.PI * 39 * 39, `removed ${r.removed}`);
  assert.deepEqual(r.bounds, [20, 20, 100, 100]);
  const ink = r.ink.match(/[0-9a-f]{2}/g).map((h) => parseInt(h, 16));
  assert.ok(Math.max(...ink.map((v, k) => Math.abs(v - INK[k]))) <= 6, r.ink);
  // Composited over a dark background, no edge pixel is lighter than the outline: the light halo is gone.
  let edges = 0;
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
    const [R, G, B, A] = px(r.image, x, y);
    if (A === 0 || A === 255) continue;
    edges++;
    const a = A / 255, out = [R, G, B].map((v, k) => v * a + DARK_BG[k] * (1 - a));
    assert.ok(lum(out) <= lum(INK) + 2, `edge (${x}, ${y}) composites to ${out.map(Math.round)}`);
  }
  assert.ok(edges > 100, `anti-aliased edge pixels: ${edges}`);
  const raw = cutout(src, { defringe: 0, despeckle: 0 });
  assert.equal(px(raw.image, 101, 11)[3], 255, 'despeckle off keeps the speck');
  const halo = [];
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) { const p = px(raw.image, x, y); if (p[3] === 255 && lum(p) > lum(INK) + 40 && Math.abs(Math.hypot(x + 0.5 - 60, y + 0.5 - 60) - 40.5) < 0.7) halo.push(p); }
  assert.ok(halo.length > 50, 'without defringe the anti-aliased edge keeps its light mix');
});

test('cutout: enclosed pockets, global mode, polygon masks and cropping', () => {
  const pocket = disc({ enclosed: true });
  assert.equal(px(cutout(pocket).image, 60, 60)[3], 255, 'pockets stay by default');
  assert.equal(px(cutout(pocket, { holes: 100 }).image, 60, 60)[3], 0, 'holes removes a large pocket');
  assert.equal(px(cutout(pocket, { holes: 100000 }).image, 60, 60)[3], 255, 'smaller than the minimum stays');
  assert.equal(px(cutout(disc(), { mode: 'global' }).image, 50, 50)[3], 0, 'global removes the highlight too');
  const left = cutout(disc(), { maskPolygons: [{ points: [[0, 0], [60, 0], [60, 120], [0, 120]], mode: 'keep' }] });
  assert.equal(px(left.image, 40, 60)[3], 255); assert.equal(px(left.image, 80, 60)[3], 0);
  const erased = cutout(disc(), { maskPolygons: [{ points: [[55, 55], [65, 55], [65, 65], [55, 65]], mode: 'erase', feather: 2 }] });
  assert.equal(px(erased.image, 60, 60)[3], 0); assert.equal(px(erased.image, 40, 60)[3], 255);
  assert.ok(px(erased.image, 54, 60)[3] > 0 && px(erased.image, 54, 60)[3] < 255, 'feathered edge');
  const cropped = cutout(disc(), { crop: 'bounds' });
  assert.deepEqual(cropped.offset, [20, 20]); assert.deepEqual([cropped.image.width, cropped.image.height], [80, 80]);
  assert.throws(() => cutout(disc(), { background: 'blue' }), /Bad colour/);
  const tinted = cutout(disc(), { background: '#fffffe', tolerance: 1 });
  assert.equal(tinted.background, '#fffffe'); assert.equal(px(tinted.image, 5, 5)[3], 0);
});

async function box(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-cutout-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const ws = await Workspace.open([tmp]);
  const tools = Object.fromEntries([...createTools(ws), ...createEditTools(ws), ...createRiggingTools(ws)].map((x) => [x.name, x.handler]));
  return { tmp, ws, tools };
}

test('cutout_image reads PNG and JPG, writes a PNG with alpha and reports; build_psd stacks the layers', async (t) => {
  const { tmp, tools } = await box(t);
  const src = disc();
  await fs.writeFile(path.join(tmp, 'disc.png'), encodePng(src));
  await fs.writeFile(path.join(tmp, 'disc.jpg'), jpeg.encode({ width: src.width, height: src.height, data: src.data }, 95).data);
  const r = await tools.cutout_image({ image_file: 'disc.png', output: 'disc_cut.png' });
  assert.equal(r.background, '#ffffff'); assert.ok(r.removed > 9000); assert.deepEqual(r.bounds, [20, 20, 100, 100]);
  const cut = decodePng(await fs.readFile(r.file));
  assert.equal(px(cut, 5, 5)[3], 0); assert.equal(px(cut, 60, 60)[3], 255);
  await assert.rejects(tools.cutout_image({ image_file: 'disc.png', output: 'disc_cut.png' }), /already exists/);
  const j = await tools.cutout_image({ image_file: 'disc.jpg', output: 'jpg_cut.png', tolerance: 24 });
  const jcut = decodePng(await fs.readFile(j.file));
  assert.deepEqual([jcut.width, jcut.height], [120, 120]);
  assert.equal(px(jcut, 5, 5)[3], 0); assert.equal(px(jcut, 60, 60)[3], 255); assert.equal(px(jcut, 50, 50)[3], 255);
  await assert.rejects(tools.cutout_image({ image_file: 'disc.png', output: 'x.gif' }), /must end in .png/);

  await fs.writeFile(path.join(tmp, 'small.png'), encodePng({ width: 8, height: 6, data: new Uint8Array(8 * 6 * 4).fill(200) }));
  const psd = await tools.build_psd({ output: 'parts.psd', layers: [{ name: 'body', image_file: 'disc_cut.png' }, { name: 'badge', image_file: 'small.png', x: 30, y: 40 }] });
  assert.deepEqual([psd.width, psd.height, psd.layers], [120, 120, ['body', 'badge']]);
  const imported = await importPsd(psd.file);
  assert.deepEqual([...imported.pixels.keys()].sort(), ['badge', 'body']);
  assert.deepEqual([imported.pixels.get('badge').width, imported.pixels.get('badge').height], [8, 6]);
  assert.deepEqual(imported.doc.extra.rigbyArt, { width: 120, height: 120 });
});

test('add_attachment and replace_image cut the background out on import', async (t) => {
  const { tmp, ws, tools } = await box(t);
  const doc = new Skeleton();
  doc.bones.push(makeBone('root', null, transform(0, 0, 0), 10));
  doc.images.push({ name: 'arm', path: null, width: 8, height: 6 });
  doc.slots.push(makeSlot('arm', 0, makeAttachment('arm', 'arm', transform(0, 0), 8, 6)));
  await save(ws, { doc, entries: new Map([['images/arm.png', encodePng({ width: 8, height: 6, data: new Uint8Array(8 * 6 * 4).fill(200) })]]), file: path.join(tmp, 'a.rigby'), format: 'rigby' }, {});
  await fs.writeFile(path.join(tmp, 'disc.png'), encodePng(disc()));
  await tools.add_attachment({ path: 'a.rigby', slot: 'arm', name: 'disc', image_file: 'disc.png', cutout: { background: 'white' } });
  await tools.replace_image({ path: 'a.rigby', slot: 'arm', attachment: 'arm', image_file: 'disc.png', cutout: { crop: 'bounds' } });
  const p = await loadProject(path.join(tmp, 'a.rigby'));
  const added = decodePng(p.entries.get('images/disc.png'));
  assert.equal(px(added, 5, 5)[3], 0); assert.equal(px(added, 60, 60)[3], 255);
  const replaced = p.doc.slots[0].attachments.find((a) => a.name === 'arm');
  const bytes = p.entries.get(`images/${replaced.image}.png`);
  assert.deepEqual([decodePng(bytes).width, decodePng(bytes).height], [80, 80]);
});
