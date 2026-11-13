// SPDX-License-Identifier: MIT OR Apache-2.0
// KTX2 pages are decoded and encoded here, off the interface thread. The Basis Universal module
// (ktx2-encoder's build) is embind code that creates its call wrappers with `new Function`, which the
// desktop window's Content Security Policy forbids; a worker loaded from the app's own files carries
// no such policy (Tauri attaches it to HTML only), like the Pyodide scripting worker.
import { decodeKtx2, encodeKtx2, useBasis } from '../core/ktx2.js';

useBasis(async () => {
  const { BrowserBasisEncoder } = await import('ktx2-encoder');
  return new BrowserBasisEncoder().init({ wasmUrl: new URL(`${import.meta.env.BASE_URL}basis/basis_encoder.wasm`, self.location.href).href });
});

self.onmessage = async ({ data: { id, op, bytes, image, options } }) => {
  try {
    const result = op === 'decode' ? await decodeKtx2(bytes) : await encodeKtx2(image, options);
    self.postMessage({ id, result }, [op === 'decode' ? result.data.buffer : result.buffer]);
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};
