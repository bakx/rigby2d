// SPDX-License-Identifier: MIT OR Apache-2.0
import { decodeKtx2 } from '../core/ktx2.js';

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
self.onmessage = async ({ data: { id, bytes } }) => {
  try {
    const result = await decodeKtx2(bytes, await basisModule());
    self.postMessage({ id, result }, [result.data.buffer]);
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
