// SPDX-License-Identifier: MIT OR Apache-2.0
// Keep Basis Universal initialization and transcoding off the editor thread.
let worker;
let next = 0;
const pending = new Map();
export function decodeKtx2(bytes) {
  if (!worker) {
    worker = new Worker(new URL('./ktx2.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
    };
    worker.onerror = event => {
      for (const p of pending.values()) p.reject(new Error(`KTX2 worker failed: ${event.message}`));
      pending.clear(); worker.terminate(); worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, bytes });
  });
}
