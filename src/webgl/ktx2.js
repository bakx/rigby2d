// SPDX-License-Identifier: MIT OR Apache-2.0
// KTX2 atlas pages for WebGL: transcoded to the best compressed format the context supports (ASTC,
// BC7, ETC2) and uploaded as such by WebGLRenderer.createTexture; plain RGBA where there is none.
// The host names the Basis Universal transcoder first: `useBasis(() => BASIS())` with
// basis_transcoder.js from https://github.com/BinomialLLC/basis_universal (Apache-2.0).

import { TRANSCODE, transcodeKtx2 } from '../core/ktx2.js';

export { useBasis } from '../core/ktx2.js';

// GL internal formats (the extension constants, so no extension object is needed later).
const GPU_FORMATS = [
  ['WEBGL_compressed_texture_astc', TRANSCODE.astc, 0x93b0], // COMPRESSED_RGBA_ASTC_4x4_KHR
  ['EXT_texture_compression_bptc', TRANSCODE.bc7, 0x8e8c], // COMPRESSED_RGBA_BPTC_UNORM_EXT
  ['WEBGL_compressed_texture_etc', TRANSCODE.etc2, 0x9278], // COMPRESSED_RGBA8_ETC2_EAC
];

/** The transcode target for a context: { format (TRANSCODE), glFormat (internal format, or null for RGBA) }. */
export function ktx2Target(gl) {
  for (const [ext, format, glFormat] of GPU_FORMATS) if (gl.getExtension(ext)) return { format, glFormat };
  return { format: TRANSCODE.rgba, glFormat: null };
}

/**
 * A .ktx2 page as an image for `createTexture`/`atlasTextures`: { width, height, data, glFormat, pma }.
 * Compressed where the GPU allows, RGBA otherwise.
 */
export async function ktx2Image(gl, bytes) {
  const target = ktx2Target(gl);
  return { ...(await transcodeKtx2(bytes, target.format)), glFormat: target.glFormat };
}
