// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import http from 'node:http';
import { createServer as createViteServer } from 'vite';
import { NodeBasisEncoder } from 'ktx2-encoder';
import { decodeKtx2, encodeKtx2, isKtx2, TRANSCODE, transcodeKtx2 } from '../src/core/ktx2.js';
import { createTools, loadProject, projectImages, Workspace } from '../src/mcp/tools.js';
import { decodePng } from '../src/mcp/png.js';
import { exportWithAtlas } from '../src/cli/project.js';
import { main } from '../src/cli/main.js';
import { WebGLRenderer } from '../src/webgl/renderer.js';
import { ktx2Target } from '../src/webgl/ktx2.js';

async function encoded(basis, uastc, pixel = [220, 30, 40, 255]) {
  const width = 16, height = 16;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(pixel, i);
  const encoder = new basis.BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    encoder.setUASTC(uastc);
    encoder.setKTX2UASTCSupercompression(true);
    encoder.setQualityLevel(200);
    assert.ok(encoder.setSliceSourceImage(0, rgba, width, height, 0));
    const out = new Uint8Array(65536);
    const size = encoder.encode(out);
    assert.ok(size > 0);
    return out.slice(0, size);
  } finally { encoder.delete(); }
}

test('KTX2 decoder reads ETC1S and UASTC images and rejects invalid data', async () => {
  const basis = await new NodeBasisEncoder().init();
  for (const uastc of [false, true]) {
    const bytes = await encoded(basis, uastc);
    assert.equal(isKtx2(bytes), true);
    const image = await decodeKtx2(bytes, basis);
    assert.equal(image.width, 16);
    assert.equal(image.height, 16);
    assert.equal(image.pma, false);
    assert.ok(image.data[0] > 180 && image.data[1] < 70 && image.data[3] > 240);
    const flagged = bytes.slice();
    const dfd = new DataView(flagged.buffer, flagged.byteOffset, flagged.byteLength).getUint32(48, true);
    flagged[dfd + 15] |= 1;
    assert.equal((await decodeKtx2(flagged, basis)).pma, true);
  }
  assert.equal(isKtx2(new Uint8Array(100)), false);
  await assert.rejects(decodeKtx2(new Uint8Array(100), basis), /Invalid|KTX2/);
});

test('Node project tools unpack KTX2 atlas regions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-ktx-test-'));
  try {
    const basis = await new NodeBasisEncoder().init();
    const texture = await encoded(basis, true, [100, 15, 20, 128]);
    const dfd = new DataView(texture.buffer, texture.byteOffset, texture.byteLength).getUint32(48, true);
    texture[dfd + 15] |= 1;
    await fs.writeFile(path.join(dir, 'page.ktx2'), texture);
    await fs.writeFile(path.join(dir, 'model.atlas'), 'page.ktx2\nsize: 16,16\nfilter: Linear,Linear\nrepeat: none\nbody\n  bounds: 0,0,16,16\n');
    const model = { skeleton: { spine: '4.2.0' }, bones: [{ name: 'root' }], slots: [{ name: 'slot', bone: 'root', attachment: 'body' }], skins: [{ name: 'default', attachments: { slot: { body: { width: 16, height: 16 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 20 }] } } } } };
    const file = path.join(dir, 'model.json');
    await fs.writeFile(file, JSON.stringify(model));
    const images = await projectImages(await loadProject(file), new Set(['body']));
    const image = images.get('body');
    assert.equal(image.width, 16);
    assert.equal(image.height, 16);
    assert.ok(image.rgba[0] > 180 && image.rgba[1] < 70 && image.rgba[3] > 110 && image.rgba[3] < 145);
    const tools = createTools(await Workspace.open([dir]));
    assert.equal((await tools.find(t => t.name === 'validate_project').handler({ path: file })).valid, true);
    const tool = tools.find(t => t.name === 'export_sprite_sheet');
    await tool.handler({ input: file, output_folder: dir, name: 'sheet', fps: 2 });
    const sheet = decodePng(await fs.readFile(path.join(dir, 'sheet.png')));
    assert.ok(sheet.data.some((v, i) => i % 4 === 3 && v > 0));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('editor loads and renders a KTX2 atlas', async t => {
  try { await fs.access(chromium.executablePath()); } catch { t.skip('Playwright Chromium is not installed'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-ktx-test-'));
  const input = path.join(dir, 'input');
  try {
    await fs.mkdir(input);
    const basis = await new NodeBasisEncoder().init();
    await fs.writeFile(path.join(input, 'page.ktx2'), await encoded(basis, true));
    await fs.writeFile(path.join(input, 'model.atlas'), 'page.ktx2\nsize: 16,16\nfilter: Linear,Linear\nrepeat: none\nbody\n  bounds: 0,0,16,16\n');
    const model = { skeleton: { spine: '4.2.0' }, bones: [{ name: 'root' }], slots: [{ name: 'slot', bone: 'root', attachment: 'body' }], skins: [{ name: 'default', attachments: { slot: { body: { width: 16, height: 16 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 20 }] } } } } };
    await fs.writeFile(path.join(input, 'model.json'), JSON.stringify(model));
    const report = path.join(dir, 'report.json');
    await promisify(execFile)(process.execPath, ['scripts/compatibility.mjs', input, report], { timeout: 60000 }).catch(e => { if (e.code !== 1) throw e; });
    const result = JSON.parse(await fs.readFile(report, 'utf8')).results[0];
    assert.equal(result.result, 'UNVERIFIED', JSON.stringify(result));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.stages.images.loaded, 1);
    assert.equal(result.stages.render.nonempty, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test('KTX2 encoding round trips both codecs and preserves alpha metadata', async () => {
  const basis = await new NodeBasisEncoder().init();
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([80, 25, 10, 128], i);
  for (const codec of ['etc1s', 'uastc']) {
    const bytes = await encodeKtx2({ width: 16, height: 16, data }, { codec, mipmaps: true, pma: true }, basis);
    assert.ok(isKtx2(bytes));
    const image = await decodeKtx2(bytes, basis);
    assert.equal(image.pma, true);
    assert.equal(image.width, 16);
    assert.ok(image.data[0] > 55 && image.data[3] > 110 && image.data[3] < 145);
    const compressed = await transcodeKtx2(bytes, TRANSCODE.etc2, basis);
    assert.ok(compressed.data.length > 0);
  }
  await assert.rejects(encodeKtx2({ width: 16, height: 16, data }, { codec: 'bad' }, basis), /codec/);
  await assert.rejects(encodeKtx2({ width: 16, height: 16, data: data.subarray(1) }, {}, basis), /RGBA/);
});

test('KTX2 GPU target selects supported compressed formats or RGBA', () => {
  assert.deepEqual(ktx2Target({ getExtension: name => name === 'WEBGL_compressed_texture_astc' }), { format: TRANSCODE.astc, glFormat: 0x93b0 });
  assert.deepEqual(ktx2Target({ getExtension: () => false }), { format: TRANSCODE.rgba, glFormat: null });
});

test('packed KTX2 export writes a loadable atlas and PNG fallback and rejects missing artwork', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-ktx-export-'));
  try {
    const basis = await new NodeBasisEncoder().init();
    await fs.writeFile(path.join(dir, 'source.ktx2'), await encoded(basis, false));
    await fs.writeFile(path.join(dir, 'source.atlas'), 'source.ktx2\nsize: 16,16\nfilter: Linear,Linear\nrepeat: none\nbody\n  bounds: 0,0,16,16\n');
    const model = { skeleton: { spine: '4.2.0' }, bones: [{ name: 'root' }], slots: [{ name: 'slot', bone: 'root', attachment: 'body' }], skins: [{ name: 'default', attachments: { slot: { body: { width: 16, height: 16 } } } }] };
    const input = path.join(dir, 'source.json');
    await fs.writeFile(input, JSON.stringify(model));
    const output = path.join(dir, 'result.json');
    let errors = '';
    const code = await main(['export', input, '--out', output, '--texture', 'ktx2', '--codec', 'uastc', '--fallback'], { stdout: () => {}, stderr: text => { errors += text; } });
    assert.equal(code, 0, errors);
    assert.match(await fs.readFile(path.join(dir, 'result.atlas'), 'utf8'), /result\.ktx2/);
    assert.ok(isKtx2(await fs.readFile(path.join(dir, 'result.ktx2'))));
    assert.ok((await projectImages(await loadProject(output), new Set(['body']))).has('body'));
    assert.ok(decodePng(await fs.readFile(path.join(dir, 'result.png'))).width > 0);
    await fs.unlink(path.join(dir, 'source.ktx2'));
    await assert.rejects(exportWithAtlas(input, path.join(dir, 'missing.json'), { texture: 'ktx2' }), /ENOENT|missing/);
    await assert.rejects(fs.access(path.join(dir, 'missing.json')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});



test('editor worker encodes a KTX2 page that its loader can decode', async t => {
  try { await fs.access(chromium.executablePath()); } catch { t.skip('Playwright Chromium is not installed'); return; }
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.end('<!doctype html>'); return; }
    vite.middlewares(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => {
      const { encodeKtx2, decodeKtx2 } = await import('/src/editor/ktx2.js');
      const data = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([200, 20, 30, 255], i);
      const bytes = await encodeKtx2({ width: 16, height: 16, data }, { codec: 'uastc' });
      const image = await decodeKtx2(bytes);
      return { width: image.width, red: image.data[0], alpha: image.data[3] };
    });
    assert.equal(result.width, 16);
    assert.ok(result.red > 170 && result.alpha > 240);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await vite.close(); }
});


test('WebGL uploads compressed KTX2 blocks and restores unpack state', () => {
  const uploads = [], states = [];
  const gl = { TEXTURE_2D: 1, UNPACK_FLIP_Y_WEBGL: 2, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 3,
    LINEAR: 4, TEXTURE_MAG_FILTER: 5, TEXTURE_MIN_FILTER: 6, TEXTURE_WRAP_S: 7, TEXTURE_WRAP_T: 8, CLAMP_TO_EDGE: 9,
    createTexture: () => ({}), bindTexture: () => {}, getParameter: () => true,
    pixelStorei: (...args) => states.push(args), compressedTexImage2D: (...args) => uploads.push(args), texParameteri: () => {},
    generateMipmap: () => assert.fail('compressed mip levels were not uploaded') };
  const data = new Uint8Array(16);
  const texture = WebGLRenderer.prototype.createTexture.call({ gl }, { width: 4, height: 4, data, glFormat: 0x9278 }, { mipmaps: true });
  assert.equal(uploads[0][2], 0x9278);
  assert.equal(uploads[0][6], data);
  assert.deepEqual(states, [[2, false], [3, false], [2, true], [3, true]]);
  assert.equal(texture.width, 4);
});
