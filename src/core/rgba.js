// SPDX-License-Identifier: MIT OR Apache-2.0
// Small operations on RGBA pictures: { width, height, data } with straight alpha, top row first.

/** Premultiplies `data` in place and returns it. */
export function premultiply(data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 255) for (let k = 0; k < 3; k++) data[i + k] = Math.round((data[i + k] * a) / 255);
  }
  return data;
}

/** Converts premultiplied `data` to straight alpha in place and returns it. */
export function unpremultiply(data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a > 0 && a < 255) for (let k = 0; k < 3; k++) data[i + k] = Math.min(255, Math.round((data[i + k] * 255) / a));
  }
  return data;
}

/** The bounds [x0, y0, x1, y1] (x1 and y1 exclusive) of the pixels with alpha above 0, or null when there are none. */
export function alphaBounds({ width, height, data }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/** The picture inside bounds [x0, y0, x1, y1]. */
export function crop({ width, data }, [x0, y0, x1, y1]) {
  const w = x1 - x0, h = y1 - y0, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(((y + y0) * width + x0) * 4, ((y + y0) * width + x1) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/**
 * Resamples a picture to `width` x `height`, bilinear in premultiplied space so transparent pixels
 * do not bleed their colour. shortcut: bilinear sampling aliases below half size, add a box filter
 * when scaled atlases look noisy.
 */
export function resample(img, width, height) {
  const src = premultiply(new Uint8Array(img.data)), out = new Uint8Array(width * height * 4);
  const sw = img.width, sh = img.height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / height - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / width - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4, o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[p00 + k] + (src[p10 + k] - src[p00 + k]) * tx, bottom = src[p01 + k] + (src[p11 + k] - src[p01 + k]) * tx;
        out[o + k] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return { width, height, data: unpremultiply(out) };
}
