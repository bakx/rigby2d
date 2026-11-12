// SPDX-License-Identifier: MIT OR Apache-2.0
// Background cutout for flat AI art: pure functions over RGBA pictures { width, height, data }.
// Removes a flat background colour, un-mixes the light fringe next to it against that colour,
// drops specks, and cuts parts out with polygons.

import { alphaBounds, crop } from './rgba.js';

export const CUTOUT_DEFAULTS = { background: 'auto', tolerance: 8, mode: 'flood', holes: 0, defringe: 3, ink: null, despeckle: 400, crop: 'none', maskPolygons: [] };

/** [r, g, b] for 'white', '#rrggbb' or an array. */
export function parseColor(c) {
  if (Array.isArray(c)) return c.slice(0, 3);
  if (c === 'white') return [255, 255, 255];
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c));
  if (!m) throw new Error(`Bad colour '${c}': use 'auto', 'white' or #rrggbb.`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const distance = (data, p, c) => Math.max(Math.abs(data[p] - c[0]), Math.abs(data[p + 1] - c[1]), Math.abs(data[p + 2] - c[2]));

/** The most common colour along the border, and the share of border pixels within `tolerance` of it. */
export function borderColor({ width: w, height: h, data }, tolerance = 8) {
  const counts = new Map(), border = [];
  const add = (i) => { border.push(i); const k = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]; counts.set(k, (counts.get(k) ?? 0) + 1); };
  for (let x = 0; x < w; x++) { add(x); if (h > 1) add((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { add(y * w); if (w > 1) add(y * w + w - 1); }
  let best = 0, n = -1;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  const color = [(best >> 16) & 255, (best >> 8) & 255, best & 255];
  return { color, uniform: border.filter((i) => distance(data, i * 4, color) <= tolerance).length / border.length };
}

/** Grows `seeds` over `allowed` pixels not yet in `seen` (4- or 8-connected). Marks and returns every pixel reached. */
function fill(seeds, allowed, seen, w, h, eight = false) {
  const out = [];
  for (const s of seeds) if (!seen[s]) { seen[s] = 1; out.push(s); }
  for (let n = 0; n < out.length; n++) {
    const i = out[n], x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || (!eight && dx !== 0 && dy !== 0)) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (allowed[j] && !seen[j]) { seen[j] = 1; out.push(j); }
      }
    }
  }
  return out;
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToEdges(x, y, pts) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

/** Multiplies alpha by the polygon's coverage (`keep`) or its complement (`erase`), with a `feather` px soft edge centred on the outline. */
function applyPolygon(data, w, h, { points, mode = 'keep', feather = 0 }) {
  const keep = mode === 'keep';
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = keep ? 0 : Math.max(0, Math.floor(Math.min(...xs) - feather)), x1 = keep ? w : Math.min(w, Math.ceil(Math.max(...xs) + feather));
  const y0 = keep ? 0 : Math.max(0, Math.floor(Math.min(...ys) - feather)), y1 = keep ? h : Math.min(h, Math.ceil(Math.max(...ys) + feather));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;
      if (!data[p + 3]) continue;
      const inside = pointInPolygon(x + 0.5, y + 0.5, points);
      let cov = inside ? 1 : 0;
      if (feather > 0) { const d = distanceToEdges(x + 0.5, y + 0.5, points); cov = inside ? Math.min(1, 0.5 + d / feather) : Math.max(0, 0.5 - d / feather); }
      const f = keep ? cov : 1 - cov;
      if (f < 1) data[p + 3] = Math.round(data[p + 3] * f);
    }
  }
}

/**
 * Cuts the background out of a picture. Options (see CUTOUT_DEFAULTS): `background` 'auto' (the most
 * common border colour), 'white' or '#rrggbb'; `tolerance` on the 0..255 max-channel distance; `mode`
 * 'flood' (background connected to the border) or 'global' (every matching pixel); `holes` removes
 * enclosed background pockets of at least that many pixels (0: keep them, so white highlights stay);
 * `defringe` un-mixes the pixels within that many px of the removed background against the background
 * colour, estimating alpha from their distance to it relative to `ink` (the outline colour, default the
 * darkest 2% of the band); `despeckle` drops opaque islands under that many px; `maskPolygons`
 * [{ points, mode: 'keep' | 'erase', feather }] in canvas px; `crop` 'none' keeps the canvas, 'bounds'
 * crops to the alpha bounds and returns the offset. Returns { image, bounds, offset, removed,
 * background, uniform, ink, warnings }.
 */
export function cutout(img, options = {}) {
  const o = { ...CUTOUT_DEFAULTS, ...options };
  const { width: w, height: h } = img, n = w * h;
  const data = new Uint8ClampedArray(img.data);
  const auto = o.background === 'auto' ? borderColor(img, o.tolerance) : null;
  const bg = auto ? auto.color : parseColor(o.background);
  const warnings = [];
  if (auto && auto.uniform < 0.9) warnings.push(`The background is not uniform: only ${Math.round(auto.uniform * 100)}% of the border is within ${o.tolerance} of ${hex(bg)}.`);
  const match = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] === 0 || distance(data, i * 4, bg) <= o.tolerance) match[i] = 1;
  let back = match;
  if (o.mode !== 'global') {
    back = new Uint8Array(n);
    const seeds = [];
    for (let x = 0; x < w; x++) seeds.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) seeds.push(y * w, y * w + w - 1);
    fill(seeds.filter((i) => match[i]), match, back, w, h);
    if (o.holes > 0) {
      const seen = new Uint8Array(back);
      for (let i = 0; i < n; i++) if (match[i] && !seen[i]) { const pocket = fill([i], match, seen, w, h); if (pocket.length >= o.holes) for (const j of pocket) back[j] = 1; }
    }
  }
  for (let i = 0; i < n; i++) if (back[i]) data[i * 4 + 3] = 0;
  let ink = o.ink ? parseColor(o.ink) : null;
  if (o.defringe > 0) {
    // The band: foreground pixels within `defringe` px (8-connected steps) of the background.
    const dist = new Uint8Array(n), band = [];
    let frontier = [];
    for (let i = 0; i < n; i++) if (back[i]) { dist[i] = 1; frontier.push(i); }
    for (let d = 0; d < o.defringe && frontier.length; d++) {
      const next = [];
      for (const i of frontier) {
        const x = i % w, y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!dist[j]) { dist[j] = 1; next.push(j); band.push(j); }
        }
      }
      frontier = next;
    }
    if (!ink && band.length) {
      const lum = (i) => data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
      const darkest = band.slice().sort((a, b) => lum(a) - lum(b)).slice(0, Math.max(1, Math.ceil(band.length * 0.02)));
      ink = [0, 1, 2].map((k) => Math.round(darkest.reduce((s, i) => s + data[i * 4 + k], 0) / darkest.length));
    }
    const range = ink ? Math.max(...ink.map((v, k) => Math.abs(v - bg[k]))) : 0;
    // c = a * fg + (1 - a) * bg: alpha from the pixel's distance to the background relative to the ink's, then un-mix.
    if (range > 0) for (const i of band) {
      const p = i * 4, a = Math.min(1, distance(data, p, bg) / range);
      if (a <= 0) { data[p + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) data[p + k] = (data[p + k] - (1 - a) * bg[k]) / a;
      data[p + 3] = Math.round(a * data[p + 3]);
    }
  }
  if (o.despeckle > 0) {
    const opaque = new Uint8Array(n), seen = new Uint8Array(n);
    for (let i = 0; i < n; i++) opaque[i] = data[i * 4 + 3] ? 1 : 0;
    for (let i = 0; i < n; i++) if (opaque[i] && !seen[i]) { const island = fill([i], opaque, seen, w, h, true); if (island.length < o.despeckle) for (const j of island) data[j * 4 + 3] = 0; }
  }
  for (const poly of o.maskPolygons) applyPolygon(data, w, h, poly);
  let removed = 0;
  for (let i = 0; i < n; i++) if (img.data[i * 4 + 3] && !data[i * 4 + 3]) removed++;
  let image = { width: w, height: h, data }, offset = [0, 0];
  const bounds = alphaBounds(image);
  if (o.crop === 'bounds' && bounds) { image = crop(image, bounds); offset = [bounds[0], bounds[1]]; }
  return { image, bounds, offset, removed, background: hex(bg), uniform: auto ? auto.uniform : 1, ink: ink ? hex(ink) : null, warnings };
}
