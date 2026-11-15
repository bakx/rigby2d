// SPDX-License-Identifier: MIT OR Apache-2.0
import { decodeKtx2, encodeKtx2 } from '../core/ktx2.js';

let basisPromise;
function basisModule() {
  if (!basisPromise) basisPromise = (async () => {
    const base = import.meta.env?.BASE_URL ?? '/';
    const js = new URL(`${base}basis/basis_encoder.js`, self.location.href).href;
    const wasm = new URL(`${base}basis/basis_encoder.wasm`, self.location.href).href;
    const [{ default: createBasis }, response] = await Promise.all([import(/* @vite-ignore */ js), fetch(wasm)]);
    if (!response.ok) throw new Error(`Basis module unavailable (${response.status})`);
    const basis = await createBasis({ wasmBinary: await response.arrayBuffer() });
    basis.initializeBasis();
    return basis;
  })().catch(error => { basisPromise = null; throw error; });
  return basisPromise;
}
self.onmessage = async ({ data: { id, bytes, operation, image, options } }) => {
  try {
    const basis = await basisModule();
    const result = operation === 'encode' ? await encodeKtx2(image, options, basis) : await decodeKtx2(bytes, basis);
    self.postMessage({ id, result }, [operation === 'encode' ? result.buffer : result.data.buffer]);
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
