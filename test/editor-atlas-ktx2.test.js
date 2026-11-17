// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openProject } from '../src/editor/io.js';

test('editor imports a same-name compressed page when the atlas PNG is missing', async () => {
  const old = { document: globalThis.document, ImageData: globalThis.ImageData, Worker: globalThis.Worker };
  const rgba = new Uint8Array(8 * 8 * 4).fill(255);
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {}, translate() {}, rotate() {}, drawImage() {} }) }) };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.Worker = class { postMessage({ id }) { queueMicrotask(() => this.onmessage({ data: { id, result: { width: 8, height: 8, data: rgba } } })); } };
  try {
    const ktx = new Uint8Array(100);
    ktx.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    const model = JSON.stringify({ skeleton: { spine: '4.0.31' }, bones: [{ name: 'root' }], slots: [{ name: 'slot', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { slot: { art: { width: 8, height: 8 } } } }] });
    const atlas = 'page.png\nsize: 8,8\nfilter: Linear,Linear\nart\n  bounds: 0,0,8,8\n';
    const reads = [];
    const fs = {
      readText: async p => { if (p === 'proj/model.json') return model; if (p === 'proj/model.atlas') return atlas; throw Error('missing'); },
      readFile: async p => { reads.push(p); if (p === 'proj/page.ktx2') return ktx; throw Error('missing'); },
      list: async () => [],
    };
    const found = new Map(), images = { clear: () => found.clear(), insert: (name, image) => found.set(name, image) };
    const { doc, warnings } = await openProject('proj/model.json', fs, images);
    assert.deepEqual(reads.slice(0, 2), ['proj/page.png', 'proj/page.ktx2']);
    assert.ok(found.has('art'));
    assert.equal(doc.images.length, 1);
    assert.ok(warnings.some(w => /page\.png.*using page\.ktx2/.test(w)));
    assert.ok(!warnings.some(w => /image 'art' not found/.test(w)));
  } finally { Object.assign(globalThis, old); }
});
