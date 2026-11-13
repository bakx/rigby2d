// SPDX-License-Identifier: MIT OR Apache-2.0
// KTX2 texture pages (Basis Universal: ETC1S or UASTC, optionally zstd supercompressed), read and
// written through the Basis Universal WebAssembly module. The module itself is not imported here: the
// host hands it in with `useBasis` (the MCP server and the editor use ktx2-encoder's build, which holds
// the encoder and the transcoder; game runtimes pass the smaller transcoder-only build), so this file
// runs anywhere and the 1-3 MB of WebAssembly loads only when a .ktx2 file is actually touched.

/** Basis `transcoder_texture_format` values: the GPU formats a runtime can ask for, and plain RGBA. */
export const TRANSCODE = { etc2: 1, bc7: 6, astc: 10, rgba: 13 };

const KTX2_SIGNATURE = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether the bytes start with the KTX 2.0 file identifier. */
export function isKtx2(bytes) {
  return bytes.length > 80 && KTX2_SIGNATURE.every((b, i) => bytes[i] === b);
}

let loader = null;
let modulePromise = null;

/**
 * Names the function that loads (and resolves to) the Basis Universal module: the host's
 * `BASIS()` factory result from basis_transcoder.js or basis_encoder.js. Loading is deferred and
 * cached; a failed load is reported once and retried next time.
 */
export function useBasis(load) {
  loader = load;
  modulePromise = null;
}

export function basisModule() {
  if (!modulePromise) {
    if (!loader) return Promise.reject(new Error('KTX2 textures need the Basis Universal transcoder, and none is configured (useBasis).'));
    modulePromise = Promise.resolve()
      .then(loader)
      .then((m) => {
        if (typeof m?.KTX2File !== 'function') throw new Error('the module has no KTX2File class');
        m.initializeBasis?.();
        return m;
      })
      .catch((e) => {
        modulePromise = null;
        throw new Error(`The Basis Universal transcoder did not load: ${e.message}`);
      });
  }
  return modulePromise;
}

/**
 * Transcodes the first mip level of a .ktx2 file to `format` (a TRANSCODE value). Returns
 * { width, height, data, format, hasAlpha, pma }: `pma` is the file's own premultiplied-alpha flag
 * (the atlas `pma` line is authoritative where there is one).
 */
export async function transcodeKtx2(bytes, format = TRANSCODE.rgba) {
  const basis = await basisModule();
  const file = new basis.KTX2File(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  try {
    if (!file.isValid()) throw new Error('not a valid KTX2 texture (the file must be ETC1S or UASTC, written by Basis Universal or toktx)');
    const width = file.getWidth(), height = file.getHeight();
    if (!file.startTranscoding()) throw new Error('the KTX2 texture cannot be transcoded (unsupported supercompression or format)');
    const data = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, format));
    if (!file.transcodeImage(data, 0, 0, 0, format, 0, -1, -1)) throw new Error('transcoding the KTX2 texture failed');
    // KHR_DF_FLAG_ALPHA_PREMULTIPLIED is bit 0 of the data format descriptor's flags.
    return { width, height, data, format, hasAlpha: !!file.getHasAlpha(), pma: (file.getDFDFlags() & 1) === 1 };
  } finally {
    file.close();
    file.delete();
  }
}

/** Decodes a .ktx2 file to straight RGBA { width, height, data, pma } (its first mip level). */
export const decodeKtx2 = (bytes) => transcodeKtx2(bytes, TRANSCODE.rgba);

export const KTX2_DEFAULTS = { codec: 'etc1s', quality: 128, mipmaps: false, zstd: true };

/**
 * Encodes RGBA pixels as a KTX2 file. `codec` is 'etc1s' (smallest, lossy) or 'uastc' (near
 * lossless, larger); `quality` 1-255 (ETC1S quality, or the UASTC effort when scaled to 0-4);
 * `mipmaps` adds the mip chain; `zstd` supercompresses UASTC (ETC1S has its own); `pma` marks the
 * pixels as premultiplied in the file (the pixels themselves are written as given).
 */
export async function encodeKtx2({ width, height, data }, { codec = KTX2_DEFAULTS.codec, quality = KTX2_DEFAULTS.quality, mipmaps = KTX2_DEFAULTS.mipmaps, zstd = KTX2_DEFAULTS.zstd, pma = false } = {}) {
  const basis = await basisModule();
  if (typeof basis.BasisEncoder !== 'function') throw new Error('Writing KTX2 textures needs the Basis Universal encoder build (ktx2-encoder); only the transcoder is loaded.');
  if (codec !== 'etc1s' && codec !== 'uastc') throw new Error(`KTX2 codec must be etc1s or uastc, not '${codec}'.`);
  quality = Math.max(1, Math.min(255, Math.round(quality)));
  const encoder = new basis.BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    encoder.setUASTC(codec === 'uastc');
    encoder.setMipGen(!!mipmaps);
    encoder.setKTX2UASTCSupercompression(!!zstd);
    encoder.setQualityLevel(quality);
    encoder.setPackUASTCFlags(Math.round((quality / 255) * 4));
    // Game atlases are sampled as plain colour values: no sRGB transfer, so runtimes can upload the
    // transcoded blocks as the non-sRGB GPU formats every WebGL has.
    (encoder.setKTX2AndBasisSRGBTransferFunc ?? encoder.setKTX2SRGBTransferFunc).call(encoder, false);
    if (!encoder.setSliceSourceImage(0, data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height, 0)) throw new Error(`the encoder rejected a ${width}×${height} image`);
    let out = new Uint8Array(width * height * 4 * (mipmaps ? 1.4 : 1.05) + 65536);
    let n = encoder.encode(out);
    if (!n) {
      out = new Uint8Array(out.length * 2);
      n = encoder.encode(out);
    }
    if (!n) throw new Error('the Basis Universal encoder failed (image too large, or more than 16384 px a side)');
    const file = out.slice(0, n);
    // Flags byte of the first data format descriptor block: 4 bytes block size, then the
    // 12-byte block header whose last byte holds the flags. The DFD's offset is at byte 48 of the file header.
    if (pma) file[new DataView(file.buffer).getUint32(48, true) + 15] |= 1;
    return file;
  } finally {
    encoder.delete();
  }
}
