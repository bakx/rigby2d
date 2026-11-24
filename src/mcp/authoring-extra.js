// SPDX-License-Identifier: MIT OR Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as author from '../core/authoring.js';
import { cutout } from '../core/cutout.js';
import { uniqueName } from '../core/model.js';
import { alphaOf, decodePng, encodePng } from './png.js';
import { EDIT, OUTPUT, OVERWRITE, edit } from './edits.js';
import { PATH } from './tools.js';
import { ToolError } from './protocol.js';

const str = { type: 'string' }, num = { type: 'number' };
const names = { type: 'array', items: str };
const mesh = { slot: str, attachment: str, skin: str };

const int = (minimum) => ({ type: 'integer', minimum });
/** The cutout options (see cutout_image), as tool arguments. */
export const CUTOUT = {
  type: 'object',
  description: 'Remove a flat background first, as cutout_image does: background auto | white | #rrggbb, tolerance, mode flood | global, holes, defringe, ink, despeckle, crop none | bounds, mask_polygons.',
  properties: {
    background: { type: 'string', description: "auto (the most common border colour, default), white or #rrggbb." },
    tolerance: { ...num, minimum: 0, maximum: 255, description: 'Max-channel distance to the background colour that still counts as background (default 8).' },
    mode: { type: 'string', enum: ['flood', 'global'], description: 'flood (default): only background connected to the border; global: every matching pixel.' },
    holes: int(0),
    defringe: int(0),
    ink: { type: 'string', description: 'Outline colour #rrggbb for the alpha estimate (default: the darkest pixels of the band).' },
    despeckle: int(0),
    crop: { type: 'string', enum: ['none', 'bounds'] },
    mask_polygons: { type: 'array', items: { type: 'object', properties: { points: { type: 'array', minItems: 3, items: { type: 'array', items: num, minItems: 2, maxItems: 2 } }, mode: { type: 'string', enum: ['keep', 'erase'] }, feather: { ...num, minimum: 0 } }, required: ['points'], additionalProperties: false } },
  },
  additionalProperties: false,
};
/** cutout() options from tool arguments. */
export function cutoutArgs(a) {
  const o = {};
  for (const k of ['background', 'tolerance', 'mode', 'holes', 'defringe', 'ink', 'despeckle', 'crop']) if (a[k] !== undefined) o[k] = a[k];
  if (a.mask_polygons) o.maskPolygons = a.mask_polygons;
  return o;
}

/** Decodes a PNG, JPG or WebP file (WebP through FFmpeg) to { width, height, data }. */
export async function readImageFile(source) {
  const ext = path.extname(source).toLowerCase();
  if (!['.png', '.webp', '.jpg', '.jpeg'].includes(ext)) throw new ToolError('Images must be PNG, JPG or WebP.');
  let bytes = await fs.readFile(source);
  if (ext === '.jpg' || ext === '.jpeg') {
    const { default: jpeg } = await import('jpeg-js');
    let j;
    try { j = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 }); } catch (e) { throw new ToolError(`Cannot decode the JPG: ${e.message}`); }
    return { width: j.width, height: j.height, data: j.data };
  }
  if (ext === '.webp') {
    try {
      const r = await promisify(execFile)('ffmpeg', ['-v', 'error', '-i', source, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
      bytes = r.stdout;
    } catch (e) { throw new ToolError(`WebP import needs FFmpeg on PATH: ${e.message}`); }
  }
  return decodePng(bytes);
}

/**
 * Images are converted to the work-file PNG format, after the optional `cut` (cutout options).
 * Importing never changes another attachment's shared image.
 */
export async function importImage(ws, p, file, cut) {
  if (p.format !== 'rigby') throw new ToolError('Adding images needs a .rigby work file.');
  const source = await ws.existing(file);
  let pixels = await readImageFile(source);
  if (cut) pixels = cutout(pixels, cutoutArgs(cut)).image;
  const base = path.basename(source, path.extname(source)).replace(/[\\/:*?"<>|]/g, '_');
  const name = uniqueName(base, (n) => p.doc.images.some((i) => i.name === n) || p.entries.has(`images/${n}.png`));
  p.entries.set(`images/${name}.png`, encodePng(pixels));
  p.doc.images.push({ name, path: null, width: pixels.width, height: pixels.height });
  return name;
}

export function createAuthoringTools(ws) {
  const make = (name, description, properties, required, apply) => ({
    name, title: name.replaceAll('_', ' '), description,
    inputSchema: { type: 'object', properties: { path: PATH, ...properties, output: OUTPUT, overwrite: OVERWRITE }, required: ['path', ...required], additionalProperties: false },
    annotations: EDIT,
    apply: async (doc, args, p) => { try { return await apply(doc, args, p); } catch (e) { throw new ToolError(e.message); } },
    handler(args) { return edit(ws, args, (doc, p) => this.apply(doc, args, p)); },
  });
  const tools = [
    make('add_attachment', 'Add a PNG/JPG/WebP region to a slot, optionally in a named skin, with an optional cutout of its flat background. Coordinates default to bone local space; world uses the setup pose. Does not change slot visibility.', { slot: str, name: str, image_file: str, x: num, y: num, rotation: num, skin: str, space: { type: 'string', enum: ['local', 'world'] }, cutout: CUTOUT }, ['slot', 'name', 'image_file'], async (doc, args, p) => author.addAttachment(doc, { ...args, image: await importImage(ws, p, args.image_file, args.cutout) })),
    make('replace_image', 'Replace the pixels of an attachment with a PNG/JPG/WebP (optionally cut out of its flat background; keep crop none so the geometry still fits), preserving its region geometry or mesh and weights.', { ...mesh, image_file: str, cutout: CUTOUT }, ['slot', 'attachment', 'image_file'], async (doc, args, p) => {
      const { att } = author.attachmentOf(doc, args);
      att.image = await importImage(ws, p, args.image_file, args.cutout);
      return { slot: args.slot, attachment: att.name, image: att.image };
    }),
    make('set_skin_attachment', 'Copy a default attachment into a skin under the same key, optionally substituting a PNG/WebP image.', { skin: str, slot: str, attachment: str, image_file: str }, ['skin', 'slot', 'attachment'], async (doc, args, p) => author.setSkinAttachment(doc, { ...args, ...(args.image_file ? { image: await importImage(ws, p, args.image_file) } : {}) })),
    make('merge_parts', 'Join region slots (e.g. upper arm and forearm) into one new outline mesh slot, composited from their setup-pose images and weighted to their bones, so the joint bends without a corner. The new slot draws where the topmost source did; the sources are kept, hidden in the setup pose.', { slots: { ...names, minItems: 2 }, into: str, falloff: { ...num, exclusiveMinimum: 0 } }, ['slots', 'into'], (doc, args, p) => {
      if (p.format !== 'rigby') throw new Error('merge_parts needs a .rigby work file with its images.');
      return author.mergeParts(doc, args, {
        pixelsOf: (name) => { const bytes = p.entries.get(`images/${name}.png`); return bytes ? decodePng(bytes) : null; },
        store: (name, rgba) => p.entries.set(`images/${name}.png`, encodePng(rgba)),
      });
    }),
    make('add_event', 'Add an event definition with default values.', { name: str, int: { type: 'integer' }, float: num, string: str }, ['name'], author.addEvent),
  ];
  // Bind handlers: callers often extract them from the table.
  for (const t of tools) t.handler = (args) => edit(ws, args, (doc, p) => t.apply(doc, args, p));
  return tools;
}
