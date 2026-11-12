// SPDX-License-Identifier: MIT OR Apache-2.0
// Shared authoring operations for MCP, Python and add-ons. No filesystem or UI dependencies.
import { setKey } from './animation.js';
import { addConstraint, addIk, listConstraints, removeConstraint, renameBoneRefs } from './constraintdata.js';
import { channelKeys, constraintChannels, keyField, setConstraintKey } from './constraintkeys.js';
import { invalidateConstraints, sampleRaw } from './constraints.js';
import { EASE_IN, EASE_OUT, EASE_IN_OUT } from './curve.js';
import { poseAt, channelValue } from './keying.js';
import { Affine, toAffine, transform } from './math.js';
import { autoWeights, normalizeWeights } from './meshgeom.js';
import { generateMesh } from './meshgen.js';
import { makeAttachment, makeSlot, uniqueName } from './model.js';
import { Pose, localFromWorld } from './pose.js';

export const indexOf = (list, name, what) => {
  const i = list.findIndex((v) => v.name === name);
  if (i < 0) throw new Error(`No ${what} '${name}'.`);
  return i;
};
export const boneOf = (doc, name) => indexOf(doc.bones, name, 'bone');
export const slotOf = (doc, name) => indexOf(doc.slots, name, 'slot');
export const animOf = (doc, name) => doc.animations[indexOf(doc.animations, name, 'animation')];
export function validName(name) {
  if (typeof name !== 'string' || !name.trim() || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Use a non-empty, non-reserved name.');
  return name;
}
export function number(value, label, min = -Infinity, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number in ${min}..${max}.`);
  return value;
}
export function curve(value = 'linear') {
  const presets = { linear: 'linear', stepped: 'stepped', easeIn: EASE_IN, easeOut: EASE_OUT, easeInOut: EASE_IN_OUT, ease_in: EASE_IN, ease_out: EASE_OUT, ease_in_out: EASE_IN_OUT };
  if (Object.hasOwn(presets, value)) return presets[value];
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[0] >= 0 && value[0] <= 1 && value[2] >= 0 && value[2] <= 1) return { bezier: value.slice() };
  throw new Error('Unknown curve; use linear, stepped, easeIn, easeOut, easeInOut or [x1,y1,x2,y2].');
}

const PHYSICS = { x: 0, y: 0, rotate: 0, scaleX: 0, shearX: 0, inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, limit: 5000, fps: 60, mix: 1 };
const FIELDS = {
  ik: 'mix softness bendPositive compress stretch uniform skinRequired',
  transform: 'rotation x y scaleX scaleY shearY mixRotate mixX mixY mixScaleX mixScaleY mixShearY local localTarget relative skin properties',
  path: 'position spacing rotation mixRotate mixX mixY positionMode spacingMode rotateMode skin',
  physics: `${Object.keys(PHYSICS).join(' ')} inertiaGlobal strengthGlobal dampingGlobal massGlobal windGlobal gravityGlobal mixGlobal skin`,
  slider: 'animation property scale offset local loop additive time mix skin',
};
const BOOLEANS = new Set('bendPositive compress stretch uniform skinRequired local localTarget relative skin loop additive'.split(' '));
const STRINGS = new Set('animation property positionMode spacingMode rotateMode'.split(' '));

function settingsFor(type, settings = {}) {
  const allowed = FIELDS[type]?.split(' ');
  if (!allowed) throw new Error(`Unknown constraint type '${type}'.`);
  for (const [k, v] of Object.entries(settings)) {
    if (!allowed.includes(k)) throw new Error(`Unknown ${type} setting '${k}'.`);
    if (BOOLEANS.has(k) || k.endsWith('Global')) {
      if (typeof v !== 'boolean') throw new Error(`${k} must be boolean.`);
    } else if (STRINGS.has(k)) {
      if (typeof v !== 'string') throw new Error(`${k} must be a string.`);
    } else if (k === 'properties') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('properties must be an object.');
    } else {
      number(v, k);
      if ((k === 'mass' || k === 'fps') && v <= 0) throw new Error(`${k} must be positive.`);
      if (['softness', 'strength', 'damping', 'limit'].includes(k) && v < 0) throw new Error(`${k} must be nonnegative.`);
    }
  }
  return structuredClone(settings);
}

export function constraintInfo(doc) {
  return listConstraints(doc).map((c) => {
    const d = c.type === 'ik' ? doc.ik[c.ik] : c.data;
    const { name, type, bone, bones, target, source, slot, ...settings } = d;
    return { name: c.name, type: c.type, order: c.order,
      bones: c.type === 'ik' ? bones.map((b) => doc.bones[b].name) : bones ?? (bone ? [bone] : []),
      target: c.type === 'ik' ? doc.bones[target]?.name : source ?? slot ?? target ?? null,
      settings: c.type === 'physics' ? { ...PHYSICS, ...settings } : settings };
  });
}
export function constraintOf(doc, name) {
  const c = listConstraints(doc).find((c) => c.name === name);
  if (!c) throw new Error(`No constraint '${name}'.`);
  return c;
}
export function createConstraint(doc, { type, name, bones = [], target, settings = {} }) {
  validName(name);
  if (listConstraints(doc).some((c) => c.name === name)) throw new Error(`Constraint '${name}' already exists.`);
  const data = settingsFor(type, settings);
  const ids = bones.map((b) => boneOf(doc, b));
  if (new Set(ids).size !== ids.length) throw new Error('Constraint bones must be distinct.');
  if (!ids.length && type !== 'slider') throw new Error('Give at least one bone.');
  if (type === 'ik') {
    if (ids.length > 2 || (ids.length === 2 && doc.bones[ids[1]].parent !== ids[0])) throw new Error('IK needs one bone or a parent/child pair.');
    const ti = boneOf(doc, target);
    for (let b = ti; b !== null; b = doc.bones[b].parent) if (ids.includes(b)) throw new Error('An IK target cannot be inside its constrained chain.');
    addIk(doc, { name, bones: ids, target: ti, ...data });
  } else if (type === 'physics') {
    // Physics is per bone in the runtime and file format. A chain creates named per-bone constraints.
    const names = bones.map((b, i) => i === 0 ? name : `${name}_${b}`);
    for (const n of names) if (listConstraints(doc).some((c) => c.name === n)) throw new Error(`Constraint '${n}' already exists.`);
    bones.forEach((b, i) => addConstraint(doc, { type, name: names[i], bone: b, ...data }));
    invalidateConstraints(doc);
    return { added: names };
  } else if (type === 'transform') {
    boneOf(doc, target);
    addConstraint(doc, { type, name, bones, source: target, ...data });
  } else if (type === 'path') {
    slotOf(doc, target);
    addConstraint(doc, { type, name, bones, slot: target, ...data });
  } else {
    if (bones.length > 1) throw new Error('A slider accepts at most one driver bone.');
    animOf(doc, data.animation);
    addConstraint(doc, { type, name, ...(bones.length ? { bone: bones[0] } : {}), ...data });
  }
  invalidateConstraints(doc);
  return { added: [name] };
}
export function changeConstraint(doc, { name, settings }) {
  const c = constraintOf(doc, name);
  const data = settingsFor(c.type, settings);
  if (data.animation) animOf(doc, data.animation);
  Object.assign(c.type === 'ik' ? doc.ik[c.ik] : c.data, data);
  invalidateConstraints(doc);
  return { constraint: name, settings: data };
}
export function deleteConstraint(doc, { name }) {
  constraintOf(doc, name);
  removeConstraint(doc, name);
  invalidateConstraints(doc);
  return { deleted: name };
}

export function keyConstraint(doc, { animation, constraint, time, values, curve: easing = 'linear' }) {
  number(time, 'time', 0);
  const c = constraintOf(doc, constraint);
  const anim = animOf(doc, animation);
  const preset = curve(easing);
  const entries = Object.entries(values ?? {});
  if (!entries.length) throw new Error('Give at least one key value.');
  if (c.type === 'ik') {
    const allowed = ['mix', 'softness', 'bendPositive', 'compress', 'stretch'];
    for (const [k] of entries) if (!allowed.includes(k)) throw new Error(`IK cannot key '${k}'.`);
    settingsFor('ik', values);
    const p = poseAt(doc, anim, time);
    let tl = anim.ik.find((t) => t.constraint === c.ik);
    if (!tl) anim.ik.push(tl = { constraint: c.ik, keys: [] });
    const i = setKey(tl.keys, time, { ...p.ik[c.ik], ...values });
    tl.keys[i].curve = preset;
  } else {
    const channels = constraintChannels(c.type);
    const allowed = channels.flatMap((ch) => ch.fields[0] === 'value' ? [ch.channel] : ch.fields);
    for (const [k, v] of entries) {
      if (!allowed.includes(k)) throw new Error(`${c.type} cannot key '${k}'.`);
      number(v, k);
    }
    for (const ch of channels) {
      const supplied = ch.fields[0] === 'value' ? (values[ch.channel] === undefined ? null : { value: values[ch.channel] }) : Object.fromEntries(entries.filter(([k]) => ch.fields.includes(k)));
      if (!supplied || !Object.keys(supplied).length) continue;
      const keys = channelKeys(anim, c.type, c.name, ch.channel, true);
      // Numeric c/c2/c3/c4 is the interoperable normalized curve representation; it also
      // preserves easing when a last key gains a successor in a later tool call.
      const defaults = Object.fromEntries(ch.fields.map((f) => [f, f === 'value' ? c.data[ch.channel] ?? PHYSICS[ch.channel] ?? ch.defaults.value : keyField(c.data, f, ch.defaults)]));
      const sampled = keys.length ? sampleRaw(keys, time, (k) => ch.fields.map((f) => keyField(k, f, ch.defaults))) : ch.fields.map((f) => defaults[f]);
      const key = setConstraintKey(anim, c.type, c.name, ch.channel, time, { ...Object.fromEntries(ch.fields.map((f, i) => [f, sampled[i]])), ...supplied });
      for (const f of ['curve', 'c2', 'c3', 'c4']) delete key[f];
      if (preset === 'stepped') key.curve = 'stepped';
      else if (preset?.bezier) [key.curve, key.c2, key.c3, key.c4] = preset.bezier;
    }
  }
  anim.duration = Math.max(anim.duration, time);
  return { animation, constraint, time, values };
}

export function worldKeyValue(doc, anim, bone, channel, time, args) {
  if (!['translate', 'rotate'].includes(channel)) throw new Error('World space supports translate and rotate keys.');
  const pose = poseAt(doc, anim, time);
  const w = pose.world[bone];
  const parent = doc.bones[bone].parent;
  if (parent !== null && Math.abs(pose.world[parent].determinant()) < 1e-10) throw new Error('Cannot convert through a parent with zero scale.');
  let want;
  if (channel === 'translate') want = new Affine(w.a, w.b, w.c, w.d, args.x ?? w.tx, args.y ?? w.ty);
  else {
    number(args.value, 'value');
    const a = (args.value - w.rotation()) * Math.PI / 180;
    const r = new Affine(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0);
    want = r.mul(w); want.tx = w.tx; want.ty = w.ty;
  }
  const local = localFromWorld(parent === null ? null : pose.world[parent], want, pose.inherit[bone]);
  return channelValue(channel, local, doc.bones[bone].setup);
}
export function renameBone(doc, oldName, name) {
  validName(name);
  const b = boneOf(doc, oldName);
  if (oldName !== name && doc.bones.some((x) => x.name === name)) throw new Error(`A bone named '${name}' already exists.`);
  doc.bones[b].name = name;
  renameBoneRefs(doc, oldName, name);
  for (const p of doc.poses ?? []) if (Object.hasOwn(p.bones, oldName)) { p.bones[name] = p.bones[oldName]; if (name !== oldName) delete p.bones[oldName]; }
  invalidateConstraints(doc);
}

export function skinOf(doc, name) {
  return doc.skins[indexOf(doc.skins, name, 'skin')];
}
export function addSkin(doc, { name }) {
  validName(name);
  if (name === 'default' || doc.skins.some((s) => s.name === name)) throw new Error(`Skin '${name}' already exists.`);
  doc.skins.push({ name, slots: [], bones: [], ik: [], color: null, extra: {} });
  return { added: name };
}
export function deleteSkin(doc, { name }) {
  skinOf(doc, name);
  doc.skins = doc.skins.filter((s) => s.name !== name);
  if (doc.skin === name) doc.skin = null;
  for (const a of doc.animations) { a.deform = a.deform.filter((d) => d.skin !== name); if (a.extra.attachments) delete a.extra.attachments[name]; }
  return { deleted: name };
}
export function attachmentList(doc, slot, skin, create = false) {
  if (!skin || skin === 'default') return doc.slots[slot].attachments;
  const s = skinOf(doc, skin);
  let entry = s.slots.find((s) => s.slot === slot);
  if (!entry && create) s.slots.push(entry = { slot, attachments: [] });
  return entry?.attachments ?? [];
}
export function attachmentOf(doc, { slot, attachment, skin }) {
  const si = slotOf(doc, slot);
  const list = attachmentList(doc, si, skin);
  return { si, list, att: list[indexOf(list, attachment, 'attachment')] };
}
export function addAttachment(doc, { slot, name, image, x = 0, y = 0, rotation = 0, skin, space = 'local', replace = false }) {
  validName(name);
  const si = slotOf(doc, slot);
  const list = attachmentList(doc, si, skin, true);
  const old = list.findIndex((a) => a.name === name);
  if (old >= 0 && !replace) throw new Error(`Attachment '${name}' already exists.`);
  const img = doc.images[indexOf(doc.images, image, 'image')];
  let offset = transform(number(x, 'x'), number(y, 'y'), number(rotation, 'rotation'));
  if (space === 'world') offset = new Pose(doc).world[doc.slots[si].bone].inverse().mul(toAffine(offset)).decompose();
  const att = makeAttachment(name, image, offset, img.width, img.height);
  if (old >= 0) list[old] = att; else list.push(att);
  return { slot, attachment: name, skin: skin ?? 'default' };
}
export function setSkinAttachment(doc, { skin, slot, attachment, image }) {
  const si = slotOf(doc, slot);
  skinOf(doc, skin);
  const source = doc.slots[si].attachments.find((a) => a.name === attachment);
  if (!source) throw new Error(`Default slot '${slot}' has no attachment '${attachment}'.`);
  const copy = structuredClone(source);
  if (image) { const img = doc.images[indexOf(doc.images, image, 'image')]; copy.image = image; if (copy.type === 'region') { copy.width = img.width; copy.height = img.height; } }
  const list = attachmentList(doc, si, skin, true);
  const i = list.findIndex((a) => a.name === attachment);
  if (i < 0) list.push(copy); else list[i] = copy;
  return { skin, slot, attachment };
}

export function makeMesh(doc, args, alpha) {
  const { si, list, att } = attachmentOf(doc, args);
  if (att.type !== 'region') throw new Error('make_mesh needs a region attachment; existing mesh topology is preserved.');
  const mode = args.mode ?? 'outline';
  let mesh;
  if (mode === 'outline') {
    if (!alpha) throw new Error('Outline meshing needs image alpha; use MCP with embedded images, or mode grid.');
    mesh = generateMesh(alpha, { points: 32, interior: 'high', expand: 1 });
    if (!mesh) throw new Error('The image is fully transparent.');
  } else if (mode === 'grid') {
    const spacing = number(args.spacing ?? Math.max(att.width, att.height) / 8, 'spacing', 0.001);
    const nx = Math.max(1, Math.ceil(att.width / spacing)), ny = Math.max(1, Math.ceil(att.height / spacing));
    if ((nx + 1) * (ny + 1) > 10000) throw new Error('Grid exceeds 10000 vertices; increase spacing.');
    const uvs = [], triangles = [];
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) uvs.push(x / nx, y / ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = y * (nx + 1) + x; triangles.push(i, i + 1, i + nx + 2, i, i + nx + 2, i + nx + 1); }
    // Boundary vertices first, as required by the mesh format's hull count.
    const boundary = [], interior = [];
    for (let x = 0; x <= nx; x++) boundary.push(x);
    for (let y = 1; y <= ny; y++) boundary.push(y * (nx + 1) + nx);
    for (let x = nx - 1; x >= 0; x--) boundary.push(ny * (nx + 1) + x);
    for (let y = ny - 1; y > 0; y--) boundary.push(y * (nx + 1));
    for (let y = 1; y < ny; y++) for (let x = 1; x < nx; x++) interior.push(y * (nx + 1) + x);
    const order = [...boundary, ...interior], remap = new Map(order.map((v, i) => [v, i]));
    mesh = { uvs: order.flatMap((i) => uvs.slice(i * 2, i * 2 + 2)), triangles: triangles.map((i) => remap.get(i)), hull: boundary.length };
  } else throw new Error('Mesh mode must be outline or grid.');
  const m = toAffine(att.offset);
  const vertices = [];
  for (let i = 0; i < mesh.uvs.length; i += 2) vertices.push(...m.apply([(mesh.uvs[i] - 0.5) * att.width, (0.5 - mesh.uvs[i + 1]) * att.height]));
  const result = { ...att, type: 'mesh', vertices, uvs: mesh.uvs, triangles: mesh.triangles, hull: mesh.hull };
  delete result.offset;
  list[list.indexOf(att)] = result;
  return { slot: args.slot, attachment: args.attachment, vertices: vertices.length / 2, triangles: mesh.triangles.length / 3 };
}
function meshData(doc, args) {
  const { si, att } = attachmentOf(doc, args);
  if (att.type !== 'mesh') throw new Error('This operation needs a mesh attachment.');
  const pose = new Pose(doc);
  const flat = pose.worldVertices(doc, si, att);
  const points = Array.from({ length: flat.length / 2 }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]);
  return { si, att, pose, points };
}
function writeWeights(doc, { si, att, pose, points }, weights) {
  const oldLayout = JSON.stringify(att.weights?.map((v) => v.map((w) => w.bone)));
  att.weights = weights.map((list, i) => list.map(({ bone, weight }) => { const [x, y] = pose.world[bone].inverse().apply(points[i]); return { bone, weight, x, y }; }));
  delete att.vertices;
  let removedDeformTimelines = 0;
  if (oldLayout !== JSON.stringify(att.weights.map((v) => v.map((w) => w.bone)))) {
    for (const a of doc.animations) { const n = a.deform.length; a.deform = a.deform.filter((d) => !(d.slot === si && d.attachment === att.name)); removedDeformTimelines += n - a.deform.length; }
  }
  return { vertices: weights.length, removedDeformTimelines };
}
export function weightMesh(doc, args) {
  const data = meshData(doc, args);
  if (!args.bones?.length) throw new Error('Give at least one bone.');
  const segments = args.bones.map((n) => { const bone = boneOf(doc, n); return { bone, from: data.pose.world[bone].apply([0, 0]), to: data.pose.world[bone].apply([doc.bones[bone].length, 0]) }; });
  const weights = autoWeights(data.points, segments, args.falloff ?? 4);
  return writeWeights(doc, data, weights);
}
export function setWeights(doc, args) {
  const data = meshData(doc, args);
  if (!args.vertices?.length || args.vertices.length !== args.weights?.length) throw new Error('Give matching vertices and weights arrays.');
  const weights = data.att.weights?.map((v) => v.map(({ bone, weight }) => ({ bone, weight }))) ?? data.points.map(() => [{ bone: doc.slots[data.si].bone, weight: 1 }]);
  args.vertices.forEach((vi, i) => {
    if (!Number.isInteger(vi) || vi < 0 || vi >= weights.length) throw new Error(`Invalid vertex ${vi}.`);
    const list = args.weights[i].map((w) => ({ bone: boneOf(doc, w.bone), weight: number(w.weight, 'weight', 0) }));
    if (!list.length || list.reduce((s, w) => s + w.weight, 0) <= 0 || new Set(list.map((w) => w.bone)).size !== list.length) throw new Error('Weights need distinct bones and a positive total.');
    weights[vi] = normalizeWeights(list);
  });
  return writeWeights(doc, data, weights);
}
export function smoothWeights(doc, args) {
  const data = meshData(doc, args);
  if (!data.att.weights) throw new Error('Bind the mesh with auto_weight first.');
  const iterations = number(args.iterations ?? 1, 'iterations', 1, 100);
  if (!Number.isInteger(iterations)) throw new Error('iterations must be an integer.');
  const adjacent = data.points.map((_, i) => new Set([i]));
  for (let i = 0; i < data.att.triangles.length; i += 3) { const tri = data.att.triangles.slice(i, i + 3); for (const a of tri) for (const b of tri) adjacent[a].add(b); }
  let weights = data.att.weights;
  for (let k = 0; k < iterations; k++) weights = adjacent.map((ns) => { const sum = new Map(); for (const v of ns) for (const w of weights[v]) sum.set(w.bone, (sum.get(w.bone) ?? 0) + w.weight / ns.size); return normalizeWeights([...sum].map(([bone, weight]) => ({ bone, weight }))); });
  return writeWeights(doc, data, weights);
}

/** Composite the region slots' setup-pose images into one new outline mesh slot, weighted to
 * their bones, so a joint bends without a corner. The sources stay, hidden in the setup pose.
 * `pixelsOf(image)` returns RGBA; `store(name, rgba)` keeps the new image. */
export function mergeParts(doc, { slots, into, falloff }, { pixelsOf, store }) {
  validName(into);
  if (!Array.isArray(slots) || slots.length < 2) throw new Error('Give at least two slots to merge.');
  if (doc.slots.some((s) => s.name === into)) throw new Error(`A slot named '${into}' already exists.`);
  const ids = slots.map((n) => slotOf(doc, n)).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length) throw new Error('Slots to merge must be distinct.');
  const pose = new Pose(doc);
  const parts = ids.map((si) => {
    const s = doc.slots[si], att = s.attachments.find((a) => a.name === s.attachment);
    if (att?.type !== 'region') throw new Error(`Slot '${s.name}' must show a region attachment.`);
    const pixels = pixelsOf(att.image ?? att.name);
    if (!pixels) throw new Error(`No pixels for image '${att.image ?? att.name}'.`);
    const m = pose.world[s.bone].mul(toAffine(att.offset));
    if (Math.abs(m.determinant()) < 1e-10) throw new Error(`Slot '${s.name}' has zero scale.`);
    return { s, att, pixels, inv: m.inverse(), corners: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => m.apply([x * att.width / 2, y * att.height / 2])) };
  });
  const xs = parts.flatMap((p) => p.corners.map((c) => c[0])), ys = parts.flatMap((p) => p.corners.map((c) => c[1]));
  // shortcut: composites at one world unit per pixel (PSD/AutoRig art scale); sample at the source density if art is imported scaled.
  const x0 = Math.floor(Math.min(...xs)), y1 = Math.ceil(Math.max(...ys));
  const width = Math.ceil(Math.max(...xs)) - x0, height = y1 - Math.floor(Math.min(...ys));
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error(`Merged image would be ${width}x${height}; it must be 1..4096 pixels a side.`);
  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const d = (j * width + i) * 4;
    for (const { att, pixels, inv } of parts) {
      const [lx, ly] = inv.apply([x0 + i + 0.5, y1 - j - 0.5]);
      const u = lx / att.width + 0.5, v = 0.5 - ly / att.height;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const s = (Math.floor(v * pixels.height) * pixels.width + Math.floor(u * pixels.width)) * 4;
      const a = pixels.data[s + 3] / 255, under = data[d + 3] / 255 * (1 - a), out = a + under;
      if (out <= 0) continue;
      for (let c = 0; c < 3; c++) data[d + c] = Math.round((pixels.data[s + c] * a + data[d + c] * under) / out);
      data[d + 3] = Math.round(out * 255);
    }
  }
  const image = uniqueName(into, (n) => doc.images.some((i) => i.name === n));
  doc.images.push({ name: image, path: null, width, height });
  store(image, { width, height, data });
  const bone = parts[0].s.bone;
  const center = toAffine(transform(x0 + width / 2, y1 - height / 2, 0));
  doc.slots.push(makeSlot(into, bone, makeAttachment(into, image, pose.world[bone].inverse().mul(center).decompose(), width, height)));
  // Draw where the topmost source was.
  doc.moveSlot(doc.slots.length - 1, ids[ids.length - 1] + 1);
  // A grid, not an outline: outline simplification leaves a straight edge as one segment, which cannot bend at the joint.
  const mesh = makeMesh(doc, { slot: into, attachment: into, mode: 'grid', spacing: Math.max(1, Math.min(width, height) / 4) });
  const bones = [...new Set(parts.map((p) => doc.bones[p.s.bone].name))];
  weightMesh(doc, { slot: into, attachment: into, bones, falloff });
  for (const { s } of parts) s.attachment = null;
  const hidden = parts.map((p) => p.s.name);
  const keyed = doc.animations.filter((a) => a.slots.some((tl) => hidden.includes(doc.slots[tl.slot].name) && tl.attachment?.length)).map((a) => a.name);
  return { slot: into, image, width, height, bones, hidden, vertices: mesh.vertices, triangles: mesh.triangles,
    ...(keyed.length ? { warning: `Attachment keys in ${keyed.join(', ')} can show the hidden source slots again.` } : {}) };
}

export function addEvent(doc, { name, int = 0, float = 0, string = null }) {
  validName(name);
  if (doc.events.some((e) => e.name === name)) throw new Error(`Event '${name}' already exists.`);
  number(int, 'int'); number(float, 'float');
  if (!Number.isInteger(int)) throw new Error('int must be an integer.');
  doc.events.push({ name, int, float, string, audio: null, volume: 1, balance: 0 });
  return { added: name };
}

/** Mirror full subtrees. Desired world matrices are converted through each actual parent,
 * including rotated, scaled and reflected parents. Copying retains skins and binding geometry. */
export function mirrorBones(doc, { bones, duplicate = false, names = {} }) {
  const selected = new Set(bones.map((n) => boneOf(doc, n)));
  if (!selected.size || selected.has(0)) throw new Error('Select at least one non-root bone.');
  for (let i = 1; i < doc.bones.length; i++) if (selected.has(doc.bones[i].parent)) selected.add(i);
  const ids = [...selected].sort((a, b) => a - b);
  const pose = new Pose(doc);
  const reflect = (w) => new Affine(-w.a, w.b, -w.c, w.d, -w.tx, w.ty);
  const mapped = new Map();
  const result = [];
  if (duplicate) {
    const taken = new Set(doc.bones.map((b) => b.name));
    for (const i of ids) {
      const name = names[doc.bones[i].name] ?? `${doc.bones[i].name}_mirror`;
      validName(name);
      if (taken.has(name)) throw new Error(`Bone '${name}' already exists.`);
      taken.add(name); result.push(name);
    }
  }
  for (const [k, i] of ids.entries()) {
    const source = doc.bones[i], parent = source.parent;
    const world = reflect(pose.world[i]);
    const parentWorld = selected.has(parent) ? reflect(pose.world[parent]) : pose.world[parent];
    const setup = localFromWorld(parentWorld, world, source.inherit);
    if (duplicate) {
      const index = doc.bones.length;
      mapped.set(i, index);
      doc.bones.push({ ...structuredClone(source), name: result[k], parent: mapped.get(parent) ?? parent, setup });
    } else source.setup = setup;
  }
  if (duplicate) {
    const copyAtt = (a) => {
      const copy = structuredClone(a);
      if (copy.weights) for (const list of copy.weights) for (const w of list) {
        const old = w.bone;
        if (mapped.has(old)) w.bone = mapped.get(old);
        else { const point = pose.world[old].apply([w.x, w.y]); [w.x, w.y] = pose.world[old].inverse().apply([-point[0], point[1]]); }
      }
      return copy;
    };
    const slots = [...doc.slots];
    for (const [si, s] of slots.entries()) if (mapped.has(s.bone)) {
      const index = doc.slots.length;
      const name = doc.uniqueSlotName(`${s.name}_mirror`);
      doc.slots.push({ ...structuredClone(s), name, bone: mapped.get(s.bone), attachments: s.attachments.map(copyAtt) });
      for (const skin of doc.skins) {
        const entry = skin.slots.find((e) => e.slot === si);
        if (entry) skin.slots.push({ slot: index, attachments: entry.attachments.map(copyAtt) });
      }
    }
  }
  invalidateConstraints(doc);
  return { bones: duplicate ? result : ids.map((i) => doc.bones[i].name), duplicated: duplicate };
}
