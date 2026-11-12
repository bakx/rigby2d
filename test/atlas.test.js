// SPDX-License-Identifier: MIT OR Apache-2.0
// convert_project with atlas: true packs the used images into .atlas + .png pages next to the skeleton.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseAtlas } from '../src/core/atlas.js';
import { transform } from '../src/core/math.js';
import { Skeleton, makeAttachment, makeBone, makeSlot } from '../src/core/model.js';
import { pack, usedImages } from '../src/core/pack.js';
import { premultiply } from '../src/core/rgba.js';
import { unpackAtlas } from '../src/editor/defold.js';
import { save } from '../src/mcp/edits.js';
import { decodePng, encodePng } from '../src/mcp/png.js';
import { Workspace, createTools, loadProject } from '../src/mcp/tools.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIGBY = path.join(REPO, 'branding/rigbytron/rigbytron.rigby');

async function box(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-atlas-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const ws = await Workspace.open([REPO, tmp]);
  return { tmp, ws, tools: Object.fromEntries(createTools(ws).map((x) => [x.name, x.handler])) };
}

/** A solid picture, or one with an opaque `rect` [x, y, w, h] on a transparent canvas. */
function picture(width, height, color, rect) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rect && (x < rect[0] || y < rect[1] || x >= rect[0] + rect[2] || y >= rect[1] + rect[3])) continue;
    data.set(color, (y * width + x) * 4);
  }
  return { width, height, data };
}

/** A one-bone project whose slots show `images` ([{ name, attachment?, picture }]), saved as a .rigby file. */
async function project(ws, file, images) {
  const doc = new Skeleton();
  doc.bones.push(makeBone('root', null, transform(0, 0, 0), 10));
  const entries = new Map();
  for (const im of images) {
    doc.images.push({ name: im.name, path: null, width: im.picture.width, height: im.picture.height });
    entries.set(`images/${im.name}.png`, encodePng(im.picture));
    doc.slots.push(makeSlot(`slot_${im.attachment ?? im.name}`, 0, makeAttachment(im.attachment ?? im.name, im.name, transform(0, 0), im.picture.width, im.picture.height)));
  }
  await save(ws, { doc, entries, file, format: 'rigby' }, {});
  return { doc, entries };
}

/** The written atlas next to a skeleton file, and its images unpacked to their original size. */
async function unpacked(skeletonFile) {
  const dir = path.dirname(skeletonFile);
  const atlas = parseAtlas(await fs.readFile(skeletonFile.replace(/\.(json|skel)$/, '.atlas'), 'utf8'));
  const pages = new Map();
  for (const page of atlas.pages) pages.set(page.name, decodePng(await fs.readFile(path.join(dir, page.name))));
  return { atlas, images: unpackAtlas(atlas, pages) };
}

const same = (got, expected, what) => {
  assert.equal(got.width, expected.width, what); assert.equal(got.height, expected.height, what);
  assert.deepEqual(Buffer.from(got.rgba ?? got.data), Buffer.from(expected.data), what);
};

test('atlas export: the work-file images round-trip through the atlas, straight and premultiplied, and validate', async (t) => {
  const { tmp, tools } = await box(t);
  const work = await loadProject(RIGBY);
  for (const pma of [false, true]) {
    const out = path.join(tmp, pma ? 'pma' : 'straight', 'r.json');
    await fs.mkdir(path.dirname(out), { recursive: true });
    const res = await tools.convert_project({ input: RIGBY, output: out, atlas: true, pma });
    assert.equal(res.atlas.pages.length, 1); assert.deepEqual(res.atlas.missingImages, []);
    const report = await tools.validate_project({ path: out });
    assert.equal(report.valid, true, JSON.stringify(report.errors)); assert.equal(report.checks.images, 'ok');
    const { atlas, images } = await unpacked(out);
    assert.equal(atlas.pages[0].pma, pma);
    assert.deepEqual(atlas.pages[0].filter, ['Linear', 'Linear']);
    const reopened = await loadProject(out);
    for (const slot of reopened.doc.slots) for (const a of slot.attachments) assert.ok(images.has(a.image), a.image);
    for (const name of usedImages(work.doc)) {
      const expected = decodePng(work.entries.get(`images/${name}.png`));
      if (pma) premultiply(expected.data);
      same(images.get(name), expected, name);
    }
  }
  await assert.rejects(tools.convert_project({ input: RIGBY, output: path.join(tmp, 'straight', 'r.json'), atlas: true }), /already exists/);
  const skel = path.join(tmp, 'r.skel');
  await tools.convert_project({ input: RIGBY, output: skel, atlas: true, filter: 'Nearest' });
  assert.equal((await tools.validate_project({ path: skel })).checks.images, 'ok');
  assert.match(await fs.readFile(path.join(tmp, 'r.atlas'), 'utf8'), /^filter: Nearest, Nearest$/m);
});

test('atlas export: pages overflow into <name>_2.png, region names are attachment paths, trim keeps placement, scale is written', async (t) => {
  const { tmp, ws, tools } = await box(t);
  const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255], [0, 255, 255, 255], [255, 0, 255, 255]];
  const images = colors.map((c, i) => ({ name: `part${i}`, picture: picture(40, 40, c) }));
  images[5].attachment = 'eyes_closed'; images[5].name = 'eyes_closed_crop';
  images.push({ name: 'trimmed', picture: picture(40, 40, [10, 200, 30, 255], [5, 7, 10, 10]) });
  const { entries } = await project(ws, path.join(tmp, 'p.rigby'), images);

  const out = path.join(tmp, 'r.json');
  const res = await tools.convert_project({ input: path.join(tmp, 'p.rigby'), output: out, atlas: true, max_size: 90, trim: true });
  assert.deepEqual(res.atlas.pages.map((p) => path.basename(p.file)), ['r.png', 'r_2.png']);
  const text = await fs.readFile(path.join(tmp, 'r.atlas'), 'utf8');
  assert.match(text, /^eyes_closed_crop$/m);
  assert.match(text, /^trimmed\nbounds: \d+, \d+, 10, 10\noffsets: 5, 23, 40, 40$/m);
  assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).skins[0].attachments.slot_eyes_closed.eyes_closed.path, 'eyes_closed_crop');
  const reopened = await loadProject(out);
  assert.ok(reopened.images.includes('eyes_closed_crop'));
  assert.equal((await tools.validate_project({ path: out })).checks.images, 'ok');
  const { atlas, images: got } = await unpacked(out);
  assert.equal(atlas.pages.length, 2);
  for (const im of images) same(got.get(im.name), decodePng(entries.get(`images/${im.name}.png`)), im.name);

  const half = path.join(tmp, 'half.json');
  await tools.convert_project({ input: path.join(tmp, 'p.rigby'), output: half, atlas: true, scale: 0.5, power_of_two: true });
  const halfAtlas = parseAtlas(await fs.readFile(path.join(tmp, 'half.atlas'), 'utf8'));
  assert.equal(halfAtlas.pages[0].scale, 0.5);
  assert.equal(halfAtlas.pages[0].width & (halfAtlas.pages[0].width - 1), 0);
  assert.deepEqual([halfAtlas.pages[0].regions[0].width, halfAtlas.pages[0].regions[0].height], [20, 20]);
  assert.equal((await tools.validate_project({ path: half })).checks.images, 'ok');
});

test('pack: shelves fill power-of-two pages and refuse an image larger than a page', () => {
  const pages = pack([{ name: 'a', width: 100, height: 50 }, { name: 'b', width: 100, height: 60 }], { padding: 2, maxSize: 4096 });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].width & (pages[0].width - 1), 0);
  assert.deepEqual(pages[0].regions.map((r) => r.name), ['a', 'b']);
  assert.throws(() => pack([{ name: 'big', width: 200, height: 10 }], { maxSize: 128 }), /does not fit/);
});
