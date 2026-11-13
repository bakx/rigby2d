// SPDX-License-Identifier: MIT OR Apache-2.0
// KTX2 (Basis Universal) atlas pages: encoded from generated images, read back, and written by
// convert_project with texture_format: 'ktx2'. No third-party textures are used as fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseAtlas } from '../src/core/atlas.js';
import { TRANSCODE, decodeKtx2, encodeKtx2, isKtx2, transcodeKtx2 } from '../src/core/ktx2.js';
import { transform } from '../src/core/math.js';
import { Animation } from '../src/core/animation.js';
import { Skeleton, makeAttachment, makeBone, makeSlot } from '../src/core/model.js';
import { save } from '../src/mcp/edits.js';
import { encodePng } from '../src/mcp/png.js';
import { Workspace, createTools, loadProject, projectImages, readPage } from '../src/mcp/tools.js';
import { ktx2Target } from '../src/webgl/ktx2.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A smooth gradient with a transparent band: colour and alpha both vary, so codec errors show. */
function gradient(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = Math.round((x / (width - 1)) * 255);
    data[i + 1] = Math.round((y / (height - 1)) * 255);
    data[i + 2] = 96;
    data[i + 3] = x >= width / 2 && x < (3 * width) / 4 ? 0 : 160 + Math.round((y / (height - 1)) * 95);
  }
  return { width, height, data };
}

/** Mean and largest per-channel difference between two RGBA buffers, transparent pixels' colour ignored. */
function difference(a, b) {
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const channels = a[i + 3] === 0 && b[i + 3] === 0 ? [3] : [0, 1, 2, 3];
    for (const c of channels) { const d = Math.abs(a[i + c] - b[i + c]); sum += d; max = Math.max(max, d); n++; }
  }
  return { mean: sum / n, max };
}

test('ktx2: ETC1S and UASTC pages encode and decode within tolerance, with mip and zstd options and the pma flag', async () => {
  const image = gradient(48, 40);
  for (const codec of ['etc1s', 'uastc']) {
    for (const [mipmaps, zstd] of [[false, true], [true, false], [true, true]]) {
      const file = await encodeKtx2(image, { codec, mipmaps, zstd, quality: 200 });
      assert.ok(isKtx2(file), `${codec} signature`);
      const back = await decodeKtx2(file);
      assert.equal(back.width, 48); assert.equal(back.height, 40); assert.equal(back.pma, false); assert.equal(back.hasAlpha, true);
      const { mean, max } = difference(back.data, image.data);
      const limit = codec === 'uastc' ? { mean: 1.5, max: 12 } : { mean: 6, max: 48 };
      assert.ok(mean < limit.mean && max < limit.max, `${codec} mipmaps=${mipmaps} zstd=${zstd}: mean ${mean.toFixed(2)} max ${max}`);
    }
  }
  const flagged = await encodeKtx2(image, { codec: 'uastc', pma: true });
  assert.equal((await decodeKtx2(flagged)).pma, true);
  assert.ok(!isKtx2(encodePng(image)));
  await assert.rejects(encodeKtx2(image, { codec: 'bc7' }), /etc1s or uastc/);
  await assert.rejects(decodeKtx2(new Uint8Array(100)), /Basis|KTX2/);
});

test('ktx2: GPU formats transcode (block sizes) and the WebGL target follows the extensions at hand', async () => {
  const file = await encodeKtx2(gradient(40, 24), { codec: 'etc1s' });
  for (const [format, bytesPerBlock] of [[TRANSCODE.astc, 16], [TRANSCODE.bc7, 16], [TRANSCODE.etc2, 16]]) {
    const t = await transcodeKtx2(file, format);
    assert.equal(t.data.length, Math.ceil(40 / 4) * Math.ceil(24 / 4) * bytesPerBlock, `format ${format}`);
  }
  const gl = (exts) => ({ getExtension: (n) => (exts.includes(n) ? {} : null) });
  assert.equal(ktx2Target(gl(['WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc'])).format, TRANSCODE.astc);
  assert.equal(ktx2Target(gl(['EXT_texture_compression_bptc', 'WEBGL_compressed_texture_etc'])).format, TRANSCODE.bc7);
  assert.equal(ktx2Target(gl(['WEBGL_compressed_texture_etc'])).format, TRANSCODE.etc2);
  assert.deepEqual(ktx2Target(gl([])), { format: TRANSCODE.rgba, glFormat: null });
});

async function box(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-ktx2-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const ws = await Workspace.open([REPO, tmp]);
  return { tmp, ws, tools: Object.fromEntries(createTools(ws).map((x) => [x.name, x.handler])) };
}

test('convert_project: KTX2 pages with a PNG fallback, read back by every page reader, inspected and validated', async (t) => {
  const { tmp, ws, tools } = await box(t);
  const doc = new Skeleton();
  doc.bones.push(makeBone('root', null, transform(0, 0, 0), 10));
  const pictures = { body: gradient(64, 48), head: gradient(32, 32) };
  const entries = new Map();
  for (const [name, picture] of Object.entries(pictures)) {
    doc.images.push({ name, path: null, width: picture.width, height: picture.height });
    entries.set(`images/${name}.png`, encodePng(picture));
    doc.slots.push(makeSlot(name, 0, makeAttachment(name, name, transform(0, 0), picture.width, picture.height)));
  }
  doc.animations.push(new Animation('idle', 1));
  const work = path.join(tmp, 'p.rigby');
  await save(ws, { doc, entries, file: work, format: 'rigby' }, {});

  const out = path.join(tmp, 'k.json');
  const res = await tools.convert_project({ input: work, output: out, atlas: true, pma: true, texture_format: 'ktx2', codec: 'uastc', fallback: 'png' });
  assert.equal(res.atlas.textureFormat, 'ktx2');
  assert.deepEqual(res.atlas.ktx2, { codec: 'uastc', quality: 128, mipmaps: false, zstd: true });
  assert.deepEqual(res.atlas.pages.map((p) => path.basename(p.file)), ['k.ktx2']);
  assert.deepEqual(res.atlas.fallback.files.map((f) => path.basename(f)), ['k.png']);
  const atlas = parseAtlas(await fs.readFile(path.join(tmp, 'k.atlas'), 'utf8'));
  assert.equal(atlas.pages[0].name, 'k.ktx2'); assert.equal(atlas.pages[0].pma, true);

  // The page itself: premultiplied pixels, flagged as such, matching the PNG fallback.
  const page = await readPage(path.join(tmp, 'k.ktx2'));
  assert.equal(page.pma, true);
  const fallback = await readPage(path.join(tmp, 'k.png'));
  assert.equal(fallback.pma, undefined);
  assert.ok(difference(page.data, fallback.data).mean < 1.5);

  // Readers: the project's images come out straight again, close to the originals.
  const p = await loadProject(out);
  const images = await projectImages(p, new Set(Object.keys(pictures)));
  for (const [name, picture] of Object.entries(pictures)) {
    const got = images.get(name);
    assert.equal(got.width, picture.width);
    const { mean } = difference(got.rgba, picture.data);
    assert.ok(mean < 4, `${name}: mean ${mean.toFixed(2)} after premultiply + UASTC + unpremultiply`);
  }
  const info = await tools.inspect_project({ path: out });
  assert.equal(info.images, 'atlas k.atlas');
  assert.deepEqual(info.atlasPages.map((pg) => [pg.file, pg.format, pg.pma]), [['k.ktx2', 'ktx2', true]]);
  const report = await tools.validate_project({ path: out });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.checks.pages, 'ok');
  const preview = await tools.render_preview({ path: out, animation: 'idle', output: path.join(tmp, 'preview.png'), times: [0] });
  assert.ok(preview);

  // Converting the KTX2 project back to PNG pages goes through the transcoder too.
  await fs.mkdir(path.join(tmp, 'png'));
  const back = await tools.convert_project({ input: out, output: path.join(tmp, 'png', 'b.json'), atlas: true });
  assert.equal(back.atlas.textureFormat, 'png');

  // A page that is not the size its atlas claims fails validation.
  const text = (await fs.readFile(path.join(tmp, 'k.atlas'), 'utf8')).replace(/^size: \d+, \d+$/m, 'size: 7, 7');
  await fs.writeFile(path.join(tmp, 'k.atlas'), text);
  const bad = await tools.validate_project({ path: out });
  assert.equal(bad.checks.pages, 'failed');
  assert.match(bad.errors.join('\n'), /Atlas page k\.ktx2: is \d+×\d+, the atlas says 7×7/);
});
