// SPDX-License-Identifier: MIT OR Apache-2.0
// Project files for the `rigby` CLI under Node: work files from skeleton exports, PSD imports, and
// skeleton exports with a packed atlas (as the editor's File > Export writes them).

import fs from 'node:fs/promises';
import path from 'node:path';

import { atlasFilter } from '../core/atlas.js';
import { encodeKtx2 } from '../core/ktx2.js';
import { writeSkeletonBinary } from '../core/binary.js';
import { writeSkeletonJson } from '../core/interop.js';
import { packAtlas, usedImages } from '../core/pack.js';
import { zip } from '../editor/zip.js';
import { decodePng, encodePng } from '../mcp/png.js';
import { ToolError } from '../mcp/protocol.js';
import { importPsd } from '../mcp/rigging.js';
import { loadProject, projectImages } from '../mcp/tools.js';

export const exists = (file) => fs.stat(file).then(() => true, () => false);

/** Refuses to replace existing files unless `force`. */
export async function checkTargets(files, force) {
  if (force) return;
  for (const f of files) if (await exists(f)) throw new ToolError(`${f} already exists. Pass --force to replace it.`);
}

/** Writes through a temporary file, so a failure never leaves a half-written file. */
export async function writeAtomic(file, bytes) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, bytes);
  try {
    await fs.rename(temp, file);
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
}

/** A picture from projectImages as { width, height, data (RGBA) }. */
function rgbaOf(picture) {
  if (picture.bytes) return decodePng(picture.bytes);
  return { width: picture.width, height: picture.height, data: picture.rgba };
}

/** The work file (ZIP) bytes of a document and its images (Map name -> PNG bytes). */
export function workfileBytes(doc, pngs) {
  const enc = new TextEncoder();
  return zip([{ path: 'project.json', bytes: enc.encode(doc.toJson()) }, ...[...pngs].map(([name, bytes]) => ({ path: `images/${name}.png`, bytes }))]);
}

/**
 * A skeleton export (.json / .skel with its atlas or images folder) as a .rigby work file, as the
 * editor opens and saves it. Returns { output, images, missingImages }.
 */
export async function toWorkfile(input, output, { force = false } = {}) {
  const p = await loadProject(input);
  if (p.format === 'rigby') throw new ToolError(`${input} is already a .rigby work file.`);
  await checkTargets([output], force);
  const used = new Set(usedImages(p.doc));
  const found = await projectImages(p, used);
  const pngs = new Map();
  p.doc.images = [];
  for (const [name, picture] of found) {
    const rgba = rgbaOf(picture);
    pngs.set(name, picture.bytes ?? encodePng(rgba));
    p.doc.images.push({ name, path: null, width: rgba.width, height: rgba.height });
  }
  await writeAtomic(output, workfileBytes(p.doc, pngs));
  return { input: p.file, output, format: 'rigby', images: pngs.size, missingImages: [...used].filter((n) => !pngs.has(n)), warnings: p.warnings };
}

/** A PSD as a new work file: one slot per pixel layer, laid out as drawn. Returns { output, slots, images }. */
export async function psdToWorkfile(input, output, { force = false } = {}) {
  await checkTargets([output], force);
  const { doc, entries } = await importPsd(input);
  const pngs = new Map([...entries].map(([k, bytes]) => [k.slice('images/'.length, -'.png'.length), bytes]));
  await writeAtomic(output, workfileBytes(doc, pngs));
  return { input, output, slots: doc.slots.length, images: pngs.size, layers: doc.slots.map((s) => s.name) };
}

/**
 * Exports skeleton JSON (`version` 3.8 / 4.2 / 4.3) or binary .skel (by the output extension) with
 * every image the skeleton uses packed into `<name>.atlas` and `<name>.png` next to it (and
 * `<name>_2.png`, ... when the images need more than one 8192px page).
 * `pageSize` (the largest page, 8192 by default) is for tests.
 * Returns { output, format, version, files, atlasSize, atlasPages, regions, missingImages, warnings }.
 */
export async function exportWithAtlas(input, output, { version = '4.3', force = false, pageSize = 8192, texture = 'png', codec = 'etc1s', quality = 128, mipmaps = false, zstd = true, fallback = false } = {}) {
  if (!['png', 'ktx2'].includes(texture)) throw new ToolError('Texture must be png or ktx2.');
  const ext = path.extname(output).toLowerCase();
  if (ext !== '.json' && ext !== '.skel') throw new ToolError('The output must end in .json or .skel.');
  if (ext === '.skel' && version !== '4.3') throw new ToolError('Binary .skel files are written as format 4.3.');
  const p = await loadProject(input);
  if (p.doc.scene) throw new ToolError('Scenes are exported from the editor (File > Export scene).');
  const base = output.slice(0, -ext.length);
  const atlasPath = `${base}.atlas`;
  if (path.resolve(output) === path.resolve(p.file)) throw new ToolError('The output must be a different file than the input.');
  await checkTargets([output, atlasPath], force);

  const used = usedImages(p.doc);
  const found = await projectImages(p, new Set(used));
  const missing = used.filter((n) => !found.has(n));
  if (missing.length) throw new ToolError(`Cannot export: ${missing.length} required image(s) are missing: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}.`);
  let written;
  try {
    written = ext === '.skel' ? writeSkeletonJson(p.doc, { version: '4.3', binary: true }) : writeSkeletonJson(p.doc, { version });
  } catch (e) {
    throw new ToolError(`Export failed: ${e.message}`);
  }
  const files = [];
  let size = null;
  let pageCount = 0;
  if (used.length) {
    let packed;
    try {
      packed = packAtlas(p.doc, (name) => rgbaOf(found.get(name)), {
        name: path.basename(base), filter: atlasFilter(p.doc.textureFilter), maxSize: pageSize, powerOfTwo: true, ext: texture,
      });
    } catch (e) {
      throw new ToolError(`Packing the atlas failed: ${e.message}`);
    }
    const targets = packed.pages.map((page) => path.join(path.dirname(output), page.name));
    const fallbackTargets = texture === 'ktx2' && fallback ? targets.map((file) => file.replace(/\.ktx2$/, '.png')) : [];
    await checkTargets([...targets, ...fallbackTargets], force);
    for (const [i, page] of packed.pages.entries()) {
      const bytes = texture === 'ktx2' ? await encodeKtx2(page, { codec, quality, mipmaps, zstd }) : encodePng(page);
      await writeAtomic(targets[i], bytes);
      if (fallbackTargets.length) await writeAtomic(fallbackTargets[i], encodePng(page));
    }
    await writeAtomic(atlasPath, packed.atlas);
    files.push(atlasPath, ...targets, ...fallbackTargets);
    size = [packed.pages[0].width, packed.pages[0].height];
    pageCount = packed.pages.length;
  }
  const bytes = ext === '.skel' ? writeSkeletonBinary(written.json) : new TextEncoder().encode(JSON.stringify(written.json, null, 2));
  await writeAtomic(output, bytes);
  return {
    input: p.file,
    output,
    format: ext.slice(1),
    version: ext === '.skel' ? '4.3' : version,
    files: [output, ...files],
    atlasSize: size,
    atlasPages: pageCount,
    regions: used.length,
    missingImages: missing,
    warnings: written.warnings,
  };
}
