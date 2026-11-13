// SPDX-License-Identifier: MIT OR Apache-2.0
// Texture atlas packing, shared by the editor's export and the MCP tools (convert_project).

import { writeAtlas } from './atlas.js';
import { alphaBounds, crop, premultiply, resample } from './rgba.js';
import { sequenceFrameName } from './sequence.js';

export function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Every image referenced by an attachment in any skin. */
export function usedImages(doc) {
  const names = new Set();
  const visit = (a) => {
    if (a.type === 'region' || a.type === 'mesh' || a.type === 'linkedmesh' || a.type === undefined) {
      if (a.sequence) for (let i = 0; i < (a.sequence.count ?? 1); i++) names.add(sequenceFrameName(a, i));
      else names.add(a.image);
    }
  };
  for (const s of doc.slots) s.attachments.forEach(visit);
  for (const skin of doc.skins) for (const e of skin.slots) e.attachments.forEach(visit);
  return [...names].sort();
}

/**
 * Shelf-packs `items` ({ name, width, height }) into pages of at most `maxSize` pixels a side,
 * `padding` pixels apart; a new page starts when one overflows. Returns [{ width, height, regions }]
 * with regions ({ name, x, y, width, height }) sorted by name.
 */
export function pack(items, { padding = 2, maxSize = 8192, powerOfTwo = true } = {}) {
  const fit = (n) => (powerOfTwo ? nextPowerOfTwo(n) : n);
  const widest = items.reduce((m, it) => Math.max(m, it.width + padding * 2), 1);
  if (widest > maxSize || items.some((it) => it.height + padding * 2 > maxSize)) throw new Error(`an image does not fit in a ${maxSize}px atlas`);
  let rest = items.map((_, i) => i).sort((a, b) => items[b].height - items[a].height);
  const pages = [];
  while (rest.length) {
    let width = Math.min(maxSize, fit(Math.max(powerOfTwo ? 256 : 1, widest)));
    for (;;) {
      let x = padding, y = padding, shelf = 0;
      const placed = [], left = [];
      for (const i of rest) {
        const { width: w, height: h } = items[i];
        if (x + w + padding > width) { x = padding; y += shelf + padding; shelf = 0; }
        if (y + h + padding > maxSize) { left.push(i); continue; }
        placed.push({ i, x, y });
        x += w + padding;
        shelf = Math.max(shelf, h);
      }
      const height = Math.min(maxSize, fit(y + shelf + padding));
      if ((height <= width * 2 && !left.length) || width >= maxSize) {
        const regions = placed.map(({ i, x, y }) => ({ name: items[i].name, x, y, width: items[i].width, height: items[i].height }));
        regions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        pages.push({ width, height, regions });
        rest = left;
        break;
      }
      width = Math.min(maxSize, width * 2);
    }
  }
  return pages;
}

/**
 * Packs the images `doc` uses into atlas pages. `pixels(name)` returns { width, height, data } (RGBA,
 * straight alpha) or null for a missing image. Region names are the image names, which skeleton JSON
 * writes as the attachment `path`. Returns { pages: [{ name, width, height, data, regions }], atlas (the
 * .atlas text), missing (image names) }. Pages are `<name>.<ext>`, `<name>_2.<ext>`, … `scale` resamples
 * the images and writes the atlas `scale` line, so the skeleton itself is unchanged; `trim` crops each
 * region to its alpha bounds and writes offsets, so placement does not change; `pma` premultiplies.
 */
export function packAtlas(doc, pixels, { name, filter = ['Linear', 'Linear'], padding = 2, maxSize = 4096, powerOfTwo = false, pma = false, trim = false, scale = 1, ext = 'png' } = {}) {
  const missing = [], items = [];
  for (const image of usedImages(doc)) {
    let img = pixels(image);
    if (!img) { missing.push(image); continue; }
    if (scale !== 1) img = resample(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
    const original = { width: img.width, height: img.height };
    let offset = [0, 0];
    if (trim) {
      const b = alphaBounds(img);
      // Atlas offsets count from the bottom left. An empty image keeps one transparent pixel.
      if (b) { offset = [b[0], img.height - b[3]]; img = crop(img, b); } else img = { width: 1, height: 1, data: new Uint8Array(4) };
    }
    items.push({ name: image, width: img.width, height: img.height, data: img.data, offset, original });
  }
  const pages = pack(items, { padding, maxSize, powerOfTwo }).map((page, i) => {
    const data = new Uint8Array(page.width * page.height * 4);
    const regions = page.regions.map((r) => {
      const it = items.find((x) => x.name === r.name);
      for (let row = 0; row < r.height; row++) data.set(it.data.subarray(row * r.width * 4, (row + 1) * r.width * 4), ((r.y + row) * page.width + r.x) * 4);
      return { ...r, rotate: 0, index: -1, offsetX: it.offset[0], offsetY: it.offset[1], originalWidth: it.original.width, originalHeight: it.original.height };
    });
    if (pma) premultiply(data);
    return { name: i ? `${name}_${i + 1}.${ext}` : `${name}.${ext}`, width: page.width, height: page.height, data, regions };
  });
  const atlas = writeAtlas(pages.map((p) => ({ name: p.name, width: p.width, height: p.height, filter, pma, scale: scale !== 1 ? scale : undefined, regions: p.regions })));
  return { pages, atlas, missing };
}
