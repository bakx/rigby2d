// SPDX-License-Identifier: MIT OR Apache-2.0
// Decode Basis Universal KTX2 textures to RGBA through a host-supplied module.
const signature = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
export const isKtx2 = bytes => bytes.length > 80 && signature.every((b, i) => bytes[i] === b);

export async function decodeKtx2(bytes, basis) {
  const file = new basis.KTX2File(bytes);
  try {
    if (!file.isValid()) throw new Error('Invalid or unsupported KTX2 texture');
    const width = file.getWidth(), height = file.getHeight();
    if (!file.startTranscoding()) throw new Error('KTX2 transcoding could not start');
    const rgba = 13;
    const data = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, rgba));
    if (!file.transcodeImage(data, 0, 0, 0, rgba, 0, -1, -1)) throw new Error('KTX2 transcoding failed');
    return { width, height, data, pma: !!(file.getDFDFlags() & 1) };
  } finally { file.close(); file.delete(); }
}
