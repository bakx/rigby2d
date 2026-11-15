// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { NodeBasisEncoder } from 'ktx2-encoder';
import { decodeKtx2, isKtx2 } from '../src/core/ktx2.js';

async function encoded(basis, uastc) {
  const width = 16, height = 16;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([220, 30, 40, 255], i);
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
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.errors.filter(message => !message.includes('WebSocket closed without opened')), []);
    assert.equal(result.stages.images.loaded, 1);
    assert.equal(result.stages.render.nonempty, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
