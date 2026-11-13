// SPDX-License-Identifier: MIT OR Apache-2.0
// The editor's KTX2 coding: core/ktx2.js's decodeKtx2 and encodeKtx2, run in ktx2.worker.js.
let worker = null;
let next = 0;
const pending = new Map();

function start() {
  const w = new Worker(new URL('./ktx2.worker.js', import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (!p) return;
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.result);
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`The KTX2 worker failed: ${e.message ?? e}`));
    pending.clear();
    w.terminate();
    worker = null;
  };
  return w;
}

function call(op, payload) {
  worker ??= start();
  return new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...payload });
  });
}

/** Decodes a .ktx2 file to straight RGBA { width, height, data, pma }. */
export const decodeKtx2 = (bytes) => call('decode', { bytes });

/** Encodes RGBA { width, height, data } as a KTX2 file (options as core/ktx2.js's encodeKtx2). */
export const encodeKtx2 = (image, options) => call('encode', { image, options });
