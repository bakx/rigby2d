// SPDX-License-Identifier: MIT OR Apache-2.0
// MCP tools for Rigby AutoRig (layered artwork to an editable rig) and animation retargeting
// (an animation made for one character, played by another).

import fs from 'node:fs/promises';
import path from 'node:path';

import { PART_ROLES, autoRig, findParts } from '../core/autorig.js';
import { makeAttachment, makeSlot, Skeleton, uniqueName } from '../core/model.js';
import { transform, toAffine } from '../core/math.js';
import { Pose } from '../core/pose.js';
import { mapBones, retarget } from '../core/retarget.js';
import { EDIT, OUTPUT, OVERWRITE, edit, save } from './edits.js';
import { alphaOf as alphaChannel, decodePng, encodePng } from './png.js';
import { ToolError } from './protocol.js';
import { PATH, READ_ONLY, loadProject } from './tools.js';
import { CUTOUT, cutoutArgs, readImageFile } from './authoring.js';
import { cutout } from '../core/cutout.js';

const PSD = { type: 'string', description: 'Layered artwork (.psd) inside the workspace, one layer per body part. Instead of path.' };
const ROLES = { type: 'object', additionalProperties: { type: 'string', enum: [...PART_ROLES, 'none'] }, description: "Override detected roles: { layerName: role }. 'none' leaves a layer unrigged." };
const SIDES = { type: 'object', additionalProperties: { type: ['string', 'null'], enum: ['l', 'r', null] }, description: "Override sides: { layerName: 'l' | 'r' }. The character's left (l) is on the image's right when it faces the viewer." };
const MAPPING = { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Override bone matches: { sourceBone: targetBone }, or null to leave a source bone out.' };
const JOINTS = { type: 'object', additionalProperties: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'Joint positions in PSD canvas pixels, origin top left: shoulder_l, elbow_l, wrist_l, hip_l, knee_l, ankle_l, or bone names. Also reads PSD layers named joint:<name> or @<name> (their centre), and <PSD basename>.joints.json; arguments win.' };

/** Pixel layers of a PSD, bottom-most first (the draw order), with their hidden state. */
function pixelLayers(children, parentHidden = false, out = []) {
  for (const layer of children ?? []) {
    const hidden = parentHidden || !!layer.hidden;
    if (layer.children) pixelLayers(layer.children, hidden, out);
    else if (layer.imageData) out.push({ layer, hidden });
  }
  return out;
}

/**
 * Imports a PSD like the editor's File > Import PSD: every pixel layer becomes an image and a slot
 * on the root bone, keeping the layout (the canvas' bottom center is the origin).
 * Returns { doc, entries (images/<name>.png), pixels (name -> RGBA) }.
 */
export async function importPsd(file) {
  let readPsd;
  try {
    let initializeCanvas;
    ({ readPsd, initializeCanvas } = await import('ag-psd'));
    // Node.js has no canvas: layers are read as plain pixel data.
    initializeCanvas(
      () => {
        throw new Error('this PSD needs a canvas to decode (for example JPEG-compressed data)');
      },
      (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    );
  } catch {
    throw new ToolError('Reading PSD files needs the ag-psd package: run npm install in the Rigby2D folder.');
  }
  const bytes = await fs.readFile(file);
  let psd;
  try {
    psd = readPsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  } catch (e) {
    throw new ToolError(`Cannot read the PSD: ${e.message}`);
  }
  const doc = new Skeleton();
  doc.extra.rigbyArt = { width: psd.width, height: psd.height };
  doc.name = path.basename(file, path.extname(file));
  const entries = new Map();
  const pixels = new Map();
  for (const { layer, hidden } of pixelLayers(psd.children)) {
    const src = layer.imageData;
    // Artist joint hints: a layer named "joint:shoulder_l" or "@shoulder_l" marks a joint at its centre.
    const hint = /^\s*(?:joint\s*:|@)\s*(\S.*?)\s*$/i.exec(layer.name ?? '');
    if (hint) {
      doc.extra.rigbyArt.joints ??= {};
      doc.extra.rigbyArt.joints[hint[1]] = [(layer.left ?? 0) + src.width / 2, (layer.top ?? 0) + src.height / 2];
      continue;
    }
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const l = Math.max(0, left);
    const t = Math.max(0, top);
    const r = Math.min(psd.width, left + src.width);
    const b = Math.min(psd.height, top + src.height);
    if (r <= l || b <= t) continue;
    const w = r - l;
    const h = b - t;
    const data = new Uint8Array(w * h * 4);
    const opacity = layer.opacity ?? 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((y + t - top) * src.width + (x + l - left)) * 4;
        const d = (y * w + x) * 4;
        data.set(src.data.subarray(s, s + 3), d);
        data[d + 3] = Math.round(src.data[s + 3] * opacity);
      }
    }
    const name = uniqueName((layer.name ?? 'layer').trim() || 'layer', (n) => doc.images.some((i) => i.name === n));
    const rgba = { width: w, height: h, data };
    pixels.set(name, rgba);
    entries.set(`images/${name}.png`, encodePng(rgba));
    doc.images.push({ name, path: null, width: w, height: h });
    const att = makeAttachment(name, name, transform((l + r) / 2 - psd.width / 2, psd.height - (t + b) / 2, 0), w, h);
    const slot = makeSlot(doc.uniqueSlotName(name), 0, att);
    if (hidden) slot.attachment = null;
    doc.slots.push(slot);
  }
  if (!doc.slots.length) throw new ToolError('The PSD has no pixel layers.');
  return { doc, entries, pixels };
}

/** Alpha of a work file's images, decoded when first asked for. */
function alphaFromEntries(entries) {
  const cache = new Map();
  return (name) => {
    if (!cache.has(name)) {
      const bytes = entries.get(`images/${name}.png`);
      let alpha = null;
      if (bytes) {
        try {
          alpha = alphaChannel(decodePng(bytes));
        } catch {
          alpha = null;
        }
      }
      cache.set(name, alpha);
    }
    return cache.get(name);
  };
}

/** Artwork to rig: a PSD (imported) or an unrigged .rigby work file. */
async function artwork(ws, args) {
  if ((args.path === undefined) === (args.psd_file === undefined)) throw new ToolError("Give either 'path' (a .rigby work file) or 'psd_file'.");
  if (args.psd_file) {
    const { doc, entries } = await importPsd(await ws.existing(args.psd_file));
    return { doc, entries, alphaOf: alphaFromEntries(entries), joints: await jointHints(ws, doc, args) };
  }
  const p = await loadProject(await ws.existing(args.path));
  if (p.format !== 'rigby') throw new ToolError('AutoRig needs artwork with its images: a .rigby work file, or a PSD (psd_file).');
  return { doc: p.doc, entries: p.entries, alphaOf: alphaFromEntries(p.entries), project: p, joints: await jointHints(ws, p.doc, args) };
}

/** Joint hints in canvas pixels: PSD joint layers, then <PSD basename>.joints.json, then arguments. */
async function jointHints(ws, doc, args) {
  let hints = { ...doc.extra.rigbyArt?.joints };
  if (args.psd_file) {
    const source = await ws.existing(args.psd_file);
    const sidecar = source.slice(0, -path.extname(source).length) + '.joints.json';
    if (await fs.stat(sidecar).then(() => true, () => false)) {
      const json = JSON.parse(await fs.readFile(await ws.existing(sidecar), 'utf8'));
      hints = { ...hints, ...(json.joints ?? json) };
    }
  }
  hints = { ...hints, ...args.joints };
  if (!Object.keys(hints).length) return {};
  const canvas = doc.extra.rigbyArt;
  if (!canvas) throw new ToolError('Canvas-pixel joint hints need a PSD import with canvas dimensions; use psd_file.');
  return Object.fromEntries(Object.entries(hints).map(([name, point]) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw new ToolError(`Joint '${name}' must be [x, y].`);
    return [name, [point[0] - canvas.width / 2, canvas.height - point[1]]];
  }));
}

const partSummary = (p) => ({
  name: p.name,
  role: p.role,
  side: p.side,
  found: p.from ?? 'unknown',
  center: p.g.c.map((v) => Math.round(v * 10) / 10),
  size: [Math.round(p.g.box.x1 - p.g.box.x0), Math.round(p.g.box.y1 - p.g.box.y0)],
});

function wrapError(e) {
  if (e instanceof ToolError) return e;
  return new ToolError(e.message);
}

function updateArt(doc, project, art, mode) {
  if (project.format !== 'rigby') throw new ToolError('update_art needs a .rigby work file.');
  const pose = new Pose(doc);
  const layers = new Map(art.doc.slots.map((s) => [s.name, s.attachments[0]]));
  const matched = new Set(), slotsMatched = new Set(), changed = [];
  const lists = doc.slots.map((s, slot) => ({ slot, attachments: s.attachments }));
  for (const skin of doc.skins) lists.push(...skin.slots);
  const imported = new Map();
  const imageFor = (layer) => {
    if (imported.has(layer.image)) return imported.get(layer.image);
    // A fresh image name avoids changing an unrelated skin that shares the old image.
    const name = uniqueName(layer.image, (n) => doc.images.some((i) => i.name === n));
    doc.images.push({ name, path: null, width: layer.width, height: layer.height });
    project.entries.set(`images/${name}.png`, art.entries.get(`images/${layer.image}.png`));
    imported.set(layer.image, name);
    return name;
  };
  for (const { slot: si, attachments } of lists) {
    const slot = doc.slots[si];
    for (const att of attachments) {
      const key = [att.name, att.image, ...(attachments.length === 1 ? [slot.name] : [])].find((n) => layers.has(n));
      if (!key) continue;
      const layer = layers.get(key);
      if (!['region', 'mesh'].includes(att.type)) continue;
      matched.add(key); slotsMatched.add(si);
      if (att.type === 'region') {
        att.offset = pose.world[slot.bone].inverse().mul(toAffine(layer.offset)).decompose();
      } else {
        const imageWorld = toAffine(layer.offset);
        const points = Array.from({ length: att.uvs.length / 2 }, (_, i) => imageWorld.apply([(att.uvs[2 * i] - 0.5) * layer.width, (0.5 - att.uvs[2 * i + 1]) * layer.height]));
        if (att.weights) att.weights.forEach((list, i) => list.forEach((w) => { [w.x, w.y] = pose.world[w.bone].inverse().apply(points[i]); }));
        else att.vertices = points.flatMap((p) => pose.world[slot.bone].inverse().apply(p));
      }
      att.width = layer.width; att.height = layer.height; att.image = imageFor(layer);
      changed.push({ slot: slot.name, attachment: att.name, layer: key });
    }
  }
  const unmatchedLayers = [...layers.keys()].filter((n) => !matched.has(n));
  const slotsWithoutLayer = doc.slots.filter((_, i) => !slotsMatched.has(i)).map((s) => s.name);
  const added = [];
  if (mode === 'add_missing' && unmatchedLayers.length) {
    const fresh = art.doc.clone();
    autoRig(fresh, alphaFromEntries(art.entries), { meshes: 'none' });
    for (const name of unmatchedLayers) {
      const layer = layers.get(name);
      let bi = fresh.slots.find((s) => s.name === name).bone;
      while (bi !== null && doc.boneIndex(fresh.bones[bi].name) === null) bi = fresh.bones[bi].parent;
      const parent = bi === null ? 0 : doc.boneIndex(fresh.bones[bi].name);
      const copy = structuredClone(layer);
      copy.image = imageFor(layer);
      copy.offset = pose.world[parent].inverse().mul(toAffine(layer.offset)).decompose();
      const slot = makeSlot(doc.uniqueSlotName(name), parent, copy);
      if (art.doc.slots.find((s) => s.name === name).attachment === null) slot.attachment = null;
      doc.slots.push(slot); added.push(slot.name);
    }
  }
  doc.extra.rigbyArt = { ...art.doc.extra.rigbyArt };
  return { matched: changed, added, unmatchedLayers, slotsWithoutLayer };
}

/** A new output file inside the workspace with extension `ext`; refuses an existing one unless `overwrite`. */
async function outputFile(ws, output, ext, overwrite) {
  if (path.extname(output).toLowerCase() !== ext) throw new ToolError(`The output must end in ${ext}.`);
  const target = await ws.writable(output);
  if (!overwrite && (await fs.stat(target).then(() => true, () => false))) throw new ToolError(`${output} already exists. Pass overwrite: true to replace it.`);
  return target;
}

export function createRiggingTools(ws) {
  return [
    {
      name: 'detect_parts',
      title: 'Detect body parts',
      description:
        "Preview Rigby AutoRig on layered artwork: which body part each layer is (head, torso, upperarm, forearm, hand, arm, thigh, shin, foot, leg, eye, mouth, hair, tail, ...), its side and whether that came from the layer name or its position. Nothing is saved. Use the roles and sides arguments of autorig to correct it.",
      inputSchema: { type: 'object', properties: { path: PATH, psd_file: PSD, roles: ROLES, sides: SIDES, joints: JOINTS }, additionalProperties: false },
      annotations: READ_ONLY,
      handler: async (args) => {
        const { doc, alphaOf, joints } = await artwork(ws, args);
        let parts;
        try {
          parts = findParts(doc, alphaOf, args);
        } catch (e) {
          throw wrapError(e);
        }
        const preview = Object.keys(joints).length ? autoRig(doc.clone(), alphaOf, { ...args, joints, meshes: 'none' }) : null;
        return { parts: parts.map(partSummary), unidentified: parts.filter((p) => !p.from || p.role === 'extra').map((p) => p.name), ...(preview ? { joints, hinted: preview.joints } : {}) };
      },
    },
    {
      name: 'autorig',
      title: 'AutoRig artwork',
      description:
        "Rigby AutoRig: rig layered artwork in one step. Identifies body parts from layer names (or positions), places joints where parts meet, builds the skeleton (hip, chest, neck, head, arms, legs, face, hair, ears, tail, wings), attaches every layer to its bone, turns parts that bend across bones into weighted meshes (a single arm layer gets an elbow) and adds IK for arms and legs. From psd_file it writes a new .rigby work file to 'output'; from path it rigs an unrigged .rigby work file. The result is ordinary, editable rig data.",
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH,
          psd_file: PSD,
          meshes: { type: 'string', enum: ['deforming', 'all', 'none'], description: "'deforming' (default): meshes for parts that bend across bones; 'all': every part; 'none'." },
          ik: { type: 'boolean', description: 'IK for two-bone arms and legs (default true).' },
          roles: ROLES,
          sides: SIDES,
          joints: JOINTS,
          output: { ...OUTPUT, description: 'Where to save. Required with psd_file (a new .rigby file).' },
          overwrite: OVERWRITE,
        },
        additionalProperties: false,
      },
      annotations: EDIT,
      handler: async (args) => {
        const rig = (doc, alphaOf, joints) => {
          try {
            return autoRig(doc, alphaOf, { ...args, joints });
          } catch (e) {
            throw wrapError(e);
          }
        };
        if (args.psd_file !== undefined) {
          if (args.path !== undefined) throw new ToolError("Give either 'path' or 'psd_file'.");
          if (!args.output || path.extname(args.output).toLowerCase() !== '.rigby') throw new ToolError("With psd_file, give 'output': the new .rigby work file.");
          const { doc, entries, alphaOf, joints } = await artwork(ws, args);
          const report = rig(doc, alphaOf, joints);
          const target = await ws.writable(args.output);
          if (!args.overwrite && (await fs.stat(target).then(() => true, () => false))) throw new ToolError(`${args.output} already exists. Pass overwrite: true to replace it.`);
          const file = await save(ws, { file: target, format: 'rigby', doc, entries }, {});
          return { file, ...report };
        }
        return edit(ws, args, async (doc, p) => {
          if (p.format !== 'rigby') throw new ToolError('AutoRig needs artwork with its images: a .rigby work file, or a PSD (psd_file).');
          return rig(doc, alphaFromEntries(p.entries), await jointHints(ws, doc, args));
        });
      },
    },
    {
      name: 'update_art', title: 'Update artwork',
      description: 'Re-import PSD pixels and placement by layer/attachment name, preserving bones, slots, constraints, skins and animations. Existing meshes keep topology, UVs and weights, rebound to the new image rectangle. add_missing also creates slots for new layers, parented to matching AutoRig bones.',
      inputSchema: { type: 'object', properties: { path: PATH, psd_file: PSD, mode: { type: 'string', enum: ['images', 'add_missing'] }, output: OUTPUT, overwrite: OVERWRITE }, required: ['path', 'psd_file'], additionalProperties: false }, annotations: EDIT,
      handler: async (args) => {
        const art = await importPsd(await ws.existing(args.psd_file));
        return edit(ws, args, (doc, p) => updateArt(doc, p, art, args.mode ?? 'images'));
      },
    },
    {
      name: 'map_bones',
      title: 'Map bones',
      description: 'Preview how retarget_animation matches the bones of a source character to a target character: by name, similar name ("L_Arm" and "arm.l"), body part ("UpperArm_Left" and "upperarm_l") or your mapping. Lists unmatched bones.',
      inputSchema: { type: 'object', properties: { source: { ...PATH, description: 'Character the animation comes from.' }, path: { ...PATH, description: 'Character to retarget to.' }, mapping: MAPPING }, required: ['source', 'path'], additionalProperties: false },
      annotations: READ_ONLY,
      handler: async (args) => {
        const s = await loadProject(await ws.existing(args.source));
        const t = await loadProject(await ws.existing(args.path));
        let m;
        try {
          m = mapBones(s.doc, t.doc, args.mapping ?? {});
        } catch (e) {
          throw wrapError(e);
        }
        return {
          mapped: m.pairs.map((p) => ({ source: s.doc.bones[p.source].name, target: t.doc.bones[p.target].name, how: p.how })),
          unmatched: m.unmapped.map((i) => s.doc.bones[i].name),
          targetUnused: t.doc.bones.filter((_, i) => !m.pairs.some((p) => p.target === i)).map((b) => b.name),
        };
      },
    },
    {
      name: 'retarget_animation',
      title: 'Retarget animation',
      description:
        "Copy animations from one character to another (any format): bones are matched automatically (see map_bones; override with mapping), movement is scaled to the target's size (scale 'auto') and rotated into its bones' frames, curves are kept, and slot, event and IK keys follow by name. mode 'relative' (default) keeps the target's own rest pose; 'world' makes bones point the way the source's do, compensating for different rest poses. Saves the target.",
      inputSchema: {
        type: 'object',
        properties: {
          source: { ...PATH, description: 'Character the animations come from.' },
          path: { ...PATH, description: 'Character to retarget to (saved).' },
          animation: { type: 'string', description: 'Source animation.' },
          animations: { type: 'array', items: { type: 'string' }, description: 'Several source animations, instead of animation.' },
          name: { type: 'string', description: 'Name in the target (single animation only; default: the same name).' },
          mode: { type: 'string', enum: ['relative', 'world'] },
          scale: { type: 'number', exclusiveMinimum: 0, description: "Movement scale (default: target height / source height)." },
          mapping: MAPPING,
          replace: { type: 'boolean', description: 'Replace target animations with the same name.' },
          output: OUTPUT,
          overwrite: OVERWRITE,
        },
        required: ['source', 'path'],
        additionalProperties: false,
      },
      annotations: EDIT,
      handler: async (args) => {
        const names = args.animations ?? (args.animation !== undefined ? [args.animation] : []);
        if (!names.length) throw new ToolError("Give 'animation' or 'animations'.");
        if (args.name !== undefined && names.length > 1) throw new ToolError("'name' works with a single animation.");
        const s = await loadProject(await ws.existing(args.source));
        return edit(ws, args, (doc) => {
          const results = [];
          for (const n of names) {
            try {
              results.push(retarget(s.doc, n, doc, { name: args.name, mode: args.mode, scale: args.scale, mapping: args.mapping, replace: args.replace }).report);
            } catch (e) {
              throw wrapError(e);
            }
          }
          return names.length === 1 ? results[0] : { animations: results };
        });
      },
    },
    {
      name: 'cutout_image',
      title: 'Cutout image',
      description: 'Remove the flat background of AI art (PNG, JPG or WebP inside the workspace) and the light fringe around its outline, writing a PNG with alpha. background: auto (the most common border colour), white or #rrggbb, matched within tolerance (0..255 max-channel distance). mode flood removes only background connected to the border; global every matching pixel. holes also removes enclosed background pockets of at least that many px (default off, so white highlights inside white fur stay). defringe un-mixes the band of that many px next to the removed background against the background colour, estimating alpha relative to ink, the outline colour (default: the darkest pixels of the band). despeckle drops opaque islands under that many px (default 400). mask_polygons ([{points, mode keep | erase, feather}] in canvas px) cut parts out of one flat image. crop none (default) keeps the canvas so registered layers stay registered; bounds crops and returns the offset. Returns the bounds, removed pixel count, background colour used and a warning when the background was not uniform.',
      inputSchema: { type: 'object', properties: { image_file: { type: 'string', description: 'PNG, JPG or WebP (WebP needs FFmpeg on PATH).' }, output: { type: 'string', description: 'PNG to write, inside the workspace.' }, ...CUTOUT.properties, overwrite: OVERWRITE }, required: ['image_file', 'output'], additionalProperties: false },
      annotations: { ...EDIT, destructiveHint: false },
      handler: async (args) => {
        const target = await outputFile(ws, args.output, '.png', args.overwrite);
        let result;
        try { result = cutout(await readImageFile(await ws.existing(args.image_file)), cutoutArgs(args)); } catch (e) { throw new ToolError(e.message); }
        await fs.writeFile(target, encodePng(result.image));
        const { image, ...info } = result;
        return { file: target, width: image.width, height: image.height, ...info };
      },
    },
    {
      name: 'build_psd',
      title: 'Build PSD',
      description: 'Build a layered PSD from image files (PNG, JPG or WebP inside the workspace): one layer per file, named and ordered as given (the first is the bottom layer), each placed at x, y on the canvas (default 0, 0, so cutouts made with crop none keep their registration). The canvas defaults to the extent of the layers. Feed the PSD to detect_parts and autorig.',
      inputSchema: { type: 'object', properties: { output: { type: 'string', description: 'PSD to write, inside the workspace.' }, layers: { type: 'array', minItems: 1, items: { type: 'object', properties: { name: { type: 'string' }, image_file: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['name', 'image_file'], additionalProperties: false } }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, overwrite: OVERWRITE }, required: ['output', 'layers'], additionalProperties: false },
      annotations: { ...EDIT, destructiveHint: false },
      handler: async (args) => {
        const target = await outputFile(ws, args.output, '.psd', args.overwrite);
        let writePsd;
        try { ({ writePsd } = await import('ag-psd')); } catch { throw new ToolError('Writing PSD files needs the ag-psd package: run npm install in the Rigby2D folder.'); }
        const children = [];
        for (const l of args.layers) {
          const img = await readImageFile(await ws.existing(l.image_file));
          children.push({ name: l.name, left: l.x ?? 0, top: l.y ?? 0, imageData: { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length) } });
        }
        const width = args.width ?? Math.max(...children.map((c) => c.left + c.imageData.width));
        const height = args.height ?? Math.max(...children.map((c) => c.top + c.imageData.height));
        await fs.writeFile(target, new Uint8Array(writePsd({ width, height, children }, { noBackground: true, generateThumbnail: false })));
        return { file: target, width, height, layers: children.map((c) => c.name) };
      },
    },
  ];
}
