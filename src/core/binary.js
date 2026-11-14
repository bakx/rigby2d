// SPDX-License-Identifier: MIT OR Apache-2.0
// Binary skeleton files (".skel"), format 4.3, and reading of format 4.2. Converts between the
// binary encoding and the skeleton JSON object structure, so all other code works with one
// representation. A 4.2 file is read into the 4.2 JSON structure (typed constraint lists with an
// order, fixed transform mixes), which interop.js reads like a 4.2 JSON export; 4.3 files into the
// 4.3 structure. The two layouts share everything but: bone length/inherit order, the constraint
// sections (4.2: IK, transform, path, physics lists, each entry with its order; 4.3: one list with a
// type byte, and property-mapped transform constraints), skin constraint references (per type in
// 4.2), weighted vertices (4.3 adds a size hint) and a trailing mesh byte, and the animation tail
// (4.3 adds slider keys, an extra section and a color).
//
// The 4.3 layout follows the Spine 4.3 SkeletonBinary reader. Unsupported features stop with
// a clear error instead of silently producing a guessed encoding.
// Supported: header, bones, slots (including dark tint), IK, transform, path, physics and slider
// constraints, skins (with skin bones and constraints), region and mesh attachments with image
// sequences, linked mesh, bounding box, path and clipping attachments (weighted or not, open or
// closed paths), events, and animations with bone, slot attachment/rgba/rgba2, IK (including
// stepped keys), transform, path position, physics wind, slider mix, deform, sequence, draw order
// and event timelines.
//
// Encoding: big-endian floats/ints; varints (7 bits per byte, low bits first; signed values are
// zig-zag encoded); strings are a varint byte length + 1 (0 = null) then UTF-8; "ref" strings are
// a varint index + 1 into a shared string table (0 = null).

import { VERSION_FIELD } from './interop.js';

const INHERIT = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const BLEND = ['normal', 'additive', 'multiply', 'screen'];
/** Bone timeline type ids, timeline names and value counts. */
const BONE_TIMELINES = [
  ['rotate', 1],
  ['translate', 2],
  ['translatex', 1],
  ['translatey', 1],
  ['scale', 2],
  ['scalex', 1],
  ['scaley', 1],
  ['shear', 2],
  ['shearx', 1],
  ['sheary', 1],
];
const CONSTRAINT_IK = 0;
const CONSTRAINT_PATH = 1;
const CONSTRAINT_TRANSFORM = 2;
const CONSTRAINT_PHYSICS = 3;
const CONSTRAINT_SLIDER = 4;
/** Slider constraint flags (mix flags as for IK constraints). */
const SLIDER_SKIN = 0x01;
const SLIDER_LOOP = 0x02;
const SLIDER_ADDITIVE = 0x04;
const SLIDER_TIME = 0x08;
const SLIDER_MIX_NOT_0 = 0x10;
const SLIDER_MIX_NOT_1 = 0x20;
const SLIDER_BONE = 0x40;
const SLIDER_LOCAL = 0x80;
/** Physics constraint flags: which bone properties are simulated, the velocity limit and mass. */
const PHYSICS_PROPERTIES = [
  [0x02, 'x'],
  [0x04, 'y'],
  [0x08, 'rotate'],
  [0x10, 'scaleX'],
  [0x20, 'shearX'],
];
const PHYSICS_LIMIT = 0x40;
const PHYSICS_MASS = 0x80;
/** Physics values that skeleton-wide physics keys can drive, in flag-bit order. */
const PHYSICS_GLOBALS = ['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix'];
const PHYSICS_DEFAULTS = { inertia: 0.5, strength: 100, damping: 0.85, fps: 60, limit: 5000 };
/** Physics key types by code (only wind keys have been observed so far). */
const PHYSICS_KEY_TYPES = { 0: 'inertia', 1: 'strength', 2: 'damping', 4: 'mass', 5: 'wind', 6: 'gravity', 7: 'mix', 8: 'reset' };
/** 4.2 physics key types (wind and mix observed; reset keys hold times only). */
const PHYSICS_KEY_TYPES_42 = { 0: 'inertia', 1: 'strength', 2: 'damping', 4: 'mass', 5: 'wind', 6: 'gravity', 7: 'mix', 8: 'reset' };
const PHYSICS_KEY_CODES = { inertia: 0, strength: 1, damping: 2, mass: 4, wind: 5, gravity: 6, mix: 7, reset: 8 };
const IK_SKIN = 0x01;
const IK_BEND_NEGATIVE = 0x04;
const IK_MIX_NOT_0 = 0x20;
const IK_MIX_NOT_1 = 0x40;
/**
 * 4.2 IK constraint data: the options are flag bits in field order (bend direction, compress,
 * stretch, uniform), the mix as in 4.3, and softness a float that follows the mix. Seen so far:
 * bend and stretch bits on two-bone chains, compress and stretch on single-bone ones.
 */
const IK_BEND_POSITIVE_42 = 0x02;
const IK_COMPRESS_42 = 0x04;
const IK_STRETCH_42 = 0x08;
const IK_UNIFORM_42 = 0x10;
const IK_SOFTNESS_42 = 0x80;
/** IK key flags: the previous segment is a bezier (8 floats follow) or stepped. */
const IK_KEY_BEZIER = 0x80;
const IK_KEY_STEPPED = 0x40;
const POSITION_MODES = ['fixed', 'percent'];
const SPACING_MODES = ['length', 'fixed', 'percent', 'proportional'];
const ROTATE_MODES = ['tangent', 'chain', 'chainScale'];
const TRANSFORM_PROPERTIES = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];
const TRANSFORM_OFFSETS = ['rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];
/** Mix key, the property it applies to, and the mix it defaults to (index) when omitted. */
const TRANSFORM_MIXES = [
  ['mixRotate', 'rotate'],
  ['mixX', 'x'],
  ['mixY', 'y', 1],
  ['mixScaleX', 'scaleX'],
  ['mixScaleY', 'scaleY', 3],
  ['mixShearY', 'shearY'],
];
const SLOT_ATTACHMENT = 0;
const SLOT_RGBA = 1;
const SLOT_RGBA2 = 3;
const ATTACHMENT_REGION = 0;
const ATTACHMENT_BOUNDINGBOX = 1;
const ATTACHMENT_MESH = 2;
const ATTACHMENT_LINKED_MESH = 3;
/** Linked meshes: inherit the source mesh's deform keys. */
const LINKED_TIMELINES = 0x80;
const ATTACHMENT_PATH = 4;
const ATTACHMENT_POINT = 5;
const ATTACHMENT_CLIPPING = 6;
/** Path attachments: constant speed, weighted vertices. */
const PATH_CLOSED = 0x10;
const PATH_CONSTANT_SPEED = 0x20;
const PATH_WEIGHTED = 0x40;
/** Bounding box and clipping attachments: the vertices are weighted. */
const VERTICES_WEIGHTED = 0x10;
/** Colors exporters leave out of JSON when unchanged. */
const DEFAULT_COLORS = { boundingbox: '60f000ff', path: 'ff7f00ff' };
/** Region/mesh: the attachment has a name different from its key. */
const FLAG_NAME = 0x08;
const FLAG_PATH = 0x10;
const FLAG_COLOR = 0x20;
/** Regions and meshes: an image sequence follows the path and color. */
const FLAG_SEQUENCE = 0x40;
/** Regions: rotation is present. Meshes: vertices are weighted. */
const FLAG_ROTATION = 0x80;
const FLAG_WEIGHTED = 0x80;
const CURVE_LINEAR = 0;
const CURVE_STEPPED = 1;
const CURVE_BEZIER = 2;
const DEFAULT_BONE_COLOR = '9b9b9bff';
/** Animation sections between transform and deform keys: path, physics and slider keys. */
const ANIMATION_SECTION_PATH = 0;
const ANIMATION_SECTION_PHYSICS = 1;
const ANIMATION_SECTION_SLIDER = 2;
/** Slider key types by code (only mix keys have been observed so far), with their default value. */
const SLIDER_KEY_TYPES = { 0: ['time', 0], 1: ['mix', 1] };
const SLIDER_KEY_CODES = { time: 0, mix: 1 };
/** Path constraint key types by code (only position keys have been observed so far). */
const PATH_KEY_TYPES = { 0: 'position', 1: 'spacing', 2: 'mix' };
const PATH_KEY_CODES = { position: 0, spacing: 1, mix: 2 };
const UNKNOWN_ANIMATION_SECTIONS = 3;
const ATTACHMENT_DEFORM = 0;
const ATTACHMENT_SEQUENCE = 1;
/** Sequence key modes, by code. */
const SEQUENCE_MODES = ['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'];
const TRANSFORM_KEY_MIXES = TRANSFORM_MIXES.map(([key]) => key);

class Unsupported extends Error {
  constructor(what) {
    super(`${what} is not supported in .skel files yet; use skeleton JSON for this skeleton`);
    this.name = 'Unsupported';
  }
}

// ---- reading ----------------------------------------------------------------------------------

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.strings = [];
    this.dec = new TextDecoder();
    this.slots = [];
  }
  slotName(i) {
    const s = this.slots[i];
    if (!s) throw new Error('invalid slot index in .skel data');
    return s.name;
  }
  check(n) {
    if (this.p + n > this.b.length) throw new Error('unexpected end of .skel data');
  }
  byte() {
    this.check(1);
    return this.b[this.p++];
  }
  bool() {
    return this.byte() !== 0;
  }
  float() {
    this.check(4);
    const v = this.v.getFloat32(this.p);
    this.p += 4;
    return shortestFloat(v);
  }
  uint() {
    this.check(4);
    const v = this.v.getUint32(this.p);
    this.p += 4;
    return v;
  }
  varint(positive = true) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = this.byte();
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80 && shift < 35);
    return positive ? result >>> 0 : (result >>> 1) ^ -(result & 1);
  }
  string() {
    const n = this.varint();
    if (n === 0) return null;
    if (n === 1) return '';
    this.check(n - 1);
    const s = this.dec.decode(this.b.subarray(this.p, this.p + n - 1));
    this.p += n - 1;
    return s;
  }
  ref() {
    const i = this.varint();
    if (i === 0) return null;
    if (i > this.strings.length) throw new Error('invalid string reference in .skel data');
    return this.strings[i - 1];
  }
  color() {
    return this.uint().toString(16).padStart(8, '0');
  }
  color3() {
    this.check(3);
    const hex = [...this.b.subarray(this.p, this.p + 3)].map((x) => x.toString(16).padStart(2, '0')).join('');
    this.p += 3;
    return hex;
  }
}

/** The shortest decimal that encodes back to the same 32-bit float. */
function shortestFloat(v) {
  if (!Number.isFinite(v) || v === 0) return v === 0 ? 0 : v;
  for (let digits = 6; digits <= 9; digits++) {
    const d = +v.toPrecision(digits);
    if (Math.fround(d) === v) return d;
  }
  return v;
}

const isSkel = (bytes) => bytes.length > 9 && bytes[8] > 1 && bytes[8] < 64;

/** True when `bytes` look like a binary skeleton (hash, then a version string). */
export function isSkeletonBinary(bytes) {
  if (!isSkel(bytes)) return false;
  const len = bytes[8] - 1;
  const text = new TextDecoder().decode(bytes.subarray(9, 9 + len));
  return /^\d+\.\d+/.test(text);
}

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '');
}

function fromBase64(text) {
  try {
    const raw = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Converts a binary skeleton into the skeleton JSON object structure (4.3 field names). Fields
 * that only exist in the binary encoding are kept under `_`-prefixed keys so they survive edits.
 */
export function readSkeletonBinary(bytes) {
  const r = new Reader(bytes);
  const hash = toBase64(bytes.subarray(0, 8));
  r.p = 8;
  const version = r.string();
  r.v42 = /^4\.2/.test(version ?? '');
  if (!r.v42 && !/^4\.3/.test(version ?? '')) throw new Unsupported(`Binary format ${version}`);
  const skeleton = { hash, [VERSION_FIELD]: version, x: r.float(), y: r.float(), width: r.float(), height: r.float() };
  const referenceScale = r.float();
  if (referenceScale !== 100) skeleton.referenceScale = referenceScale;
  const nonessential = r.bool();
  if (nonessential) {
    const fps = r.float();
    if (fps !== 30) skeleton.fps = fps;
    skeleton.images = r.string();
    skeleton.audio = r.string();
  }
  const out = { skeleton, _strings: [] };
  const nStrings = r.varint();
  for (let i = 0; i < nStrings; i++) r.strings.push(r.string());
  out._strings = r.strings.slice();

  // Bones.
  out.bones = [];
  const nBones = r.varint();
  for (let i = 0; i < nBones; i++) {
    const b = { name: r.string() };
    if (i > 0) b.parent = out.bones[r.varint()].name;
    const rotation = r.float();
    const x = r.float();
    const y = r.float();
    const scaleX = r.float();
    const scaleY = r.float();
    const shearX = r.float();
    const shearY = r.float();
    let inherit, length;
    if (r.v42) {
      length = r.float();
      inherit = INHERIT[r.varint()] ?? 'normal';
    } else {
      inherit = INHERIT[r.byte()] ?? 'normal';
      length = r.float();
    }
    if (length) b.length = length;
    if (rotation) b.rotation = rotation;
    if (x) b.x = x;
    if (y) b.y = y;
    if (scaleX !== 1) b.scaleX = scaleX;
    if (scaleY !== 1) b.scaleY = scaleY;
    if (shearX) b.shearX = shearX;
    if (shearY) b.shearY = shearY;
    if (inherit !== 'normal') b.inherit = inherit;
    if (r.bool()) b.skin = true;
    if (nonessential) {
      const color = r.color();
      if (color !== DEFAULT_BONE_COLOR) b.color = color;
      const icon = r.string();
      if (icon !== null) b.icon = icon;
      // Editor-only values; kept only when they differ from the defaults.
      const iconA = r.float();
      const iconB = r.float();
      const visible = r.bool();
      if (iconA !== 1) b._iconA = iconA;
      if (iconB !== 0) b._iconB = iconB;
      if (!visible) b._visible = false;
    }
    out.bones.push(b);
  }

  // Slots.
  out.slots = [];
  const nSlots = r.varint();
  for (let i = 0; i < nSlots; i++) {
    const s = { name: r.string(), bone: out.bones[r.varint()].name };
    const color = r.color();
    const dark = r.color();
    if (color !== 'ffffffff') s.color = color;
    if (dark !== 'ffffffff') s.dark = dark.slice(2);
    const attachment = r.ref();
    if (attachment !== null) s.attachment = attachment;
    const blend = BLEND[r.varint()] ?? 'normal';
    if (blend !== 'normal') s.blend = blend;
    if (nonessential && !r.bool()) s._visible = false;
    out.slots.push(s);
    r.slots.push(s);
  }

  // Constraints, in application order.
  out.constraints = [];
  const nConstraints = r.v42 ? 0 : r.varint();
  if (r.v42) readConstraints42(r, out);
  for (let i = 0; i < nConstraints; i++) {
    const name = r.string();
    const type = r.byte();
    if (type === CONSTRAINT_PHYSICS) {
      out.constraints.push(readPhysics(r, name, out));
      continue;
    }
    if (type === CONSTRAINT_SLIDER) {
      out.constraints.push(readSlider(r, name, out, nonessential));
      continue;
    }
    const bones = [];
    const n = r.varint();
    for (let k = 0; k < n; k++) bones.push(out.bones[r.varint()].name);
    if (type === CONSTRAINT_IK) out.constraints.push(readIk(r, name, bones, out));
    else if (type === CONSTRAINT_PATH) out.constraints.push(readPath(r, name, bones, out));
    else if (type === CONSTRAINT_TRANSFORM) out.constraints.push(readTransform(r, name, bones, out));
    else throw new Unsupported(`Constraint type ${type} ('${name}')`);
  }
  if (!out.constraints.length) delete out.constraints;

  // Skins: the default skin, then named skins.
  out.skins = [{ name: 'default', attachments: readSkin(r, out, nonessential) }];
  const nSkins = r.varint();
  for (let i = 0; i < nSkins; i++) {
    const skin = { name: r.string() };
    if (nonessential) {
      const color = r.color();
      if (color !== 'ffffffff') skin._color = color;
    }
    const nBones = r.varint();
    if (nBones) skin.bones = [];
    for (let k = 0; k < nBones; k++) skin.bones.push(out.bones[r.varint()].name);
    if (r.v42) {
      for (const type of CONSTRAINT_LISTS_42) {
        const n = r.varint();
        for (let k = 0; k < n; k++) (skin[type] ??= []).push(constraint42(r, out, type, r.varint()).name);
      }
    } else {
      const nConstraintRefs = r.varint();
      for (let k = 0; k < nConstraintRefs; k++) {
        const c = out.constraints?.[r.varint()];
        if (!c) throw new Error('invalid constraint index in .skel data');
        (skin[c.type] ??= []).push(c.name);
      }
    }
    skin.attachments = readSkin(r, out, nonessential);
    out.skins.push(skin);
  }
  for (const skin of out.skins) {
    for (const [slot, atts] of Object.entries(skin.attachments)) {
      for (const a of Object.values(atts)) {
        if (a.type !== 'linkedmesh') continue;
        if (a._skinIndex !== undefined) {
          a.skin = out.skins[a._skinIndex]?.name;
          delete a._skinIndex;
        }
        if (out.slots[a._sourceSlot]?.name === slot) delete a._sourceSlot;
      }
    }
  }

  // Events.
  out.events = {};
  const eventNames = [];
  const nEvents = r.varint();
  for (let i = 0; i < nEvents; i++) {
    const name = r.string();
    const e = {};
    const int = r.varint(false);
    const float = r.float();
    const string = r.string();
    const audio = r.string();
    if (int) e.int = int;
    if (float) e.float = float;
    if (string) e.string = string;
    if (audio !== null) {
      e.audio = audio;
      e.volume = r.float();
      e.balance = r.float();
    }
    out.events[name] = e;
    eventNames.push(name);
  }

  if (!eventNames.length) delete out.events;

  // Animations.
  out.animations = {};
  const nAnimations = r.varint();
  for (let i = 0; i < nAnimations; i++) {
    const name = r.string();
    out.animations[name] = readAnimation(r, out, eventNames, nonessential);
  }
  // Slider constraints name their animation after the animations: one index per slider.
  const animationNames = Object.keys(out.animations);
  for (const c of out.constraints ?? []) {
    if (c.type !== 'slider') continue;
    c.animation = animationNames[r.varint()];
    if (c.animation === undefined) throw new Error('invalid animation index in .skel data');
  }
  if (r.p !== bytes.length) throw new Error(`unexpected data after the animations (${bytes.length - r.p} bytes)`);
  return out;
}

function readIk(r, name, bones, out) {
  const target = out.bones[r.varint()].name;
  const flags = r.byte();
  const known = 0xff;
  if (flags & ~known) throw new Unsupported(`IK constraint options (flags 0x${flags.toString(16)}) on '${name}'`);
  const c = { type: 'ik', name, target, bones };
  if (flags & IK_SKIN) c.skin = true;
  if (r.v42) {
    if (!(flags & IK_BEND_POSITIVE_42) && bones.length > 1) c.bendPositive = false;
    if (flags & IK_COMPRESS_42) c.compress = true;
    if (flags & IK_STRETCH_42) c.stretch = true;
    if (flags & IK_UNIFORM_42) c.uniform = true;
  } else {
    if (flags & 0x02) c.scaleY = ['none', 'uniform', 'volume'][r.byte()];
    if (flags & IK_BEND_NEGATIVE && bones.length > 1) c.bendPositive = false;
    if (flags & 0x08) c.compress = true;
    if (flags & 0x10) c.stretch = true;
  }
  const mix = readMix(r, flags & IK_MIX_NOT_0, flags & IK_MIX_NOT_1);
  if (mix !== 1) c.mix = mix;
  if (flags & IK_SOFTNESS_42) c.softness = r.float();
  return c;
}

/** A mix stored as two flags, "not 0" and "not 1"; a float follows only when both are set. */
function readMix(r, not0, not1) {
  if (!not0) return 0;
  if (!not1) return 1;
  return r.float();
}

function readPath(r, name, bones, out) {
  const slot = out.slots[r.varint()].name;
  const flags = r.byte();
  if (flags & 0x40) throw new Unsupported(`Path constraint options (flags 0x${flags.toString(16)}) on '${name}'`);
  const c = { type: 'path', name, slot, bones };
  if (!r.v42 && (flags & 0x01)) c.skin = true;
  const shift = r.v42 ? 0 : 1;
  const positionMode = POSITION_MODES[(flags >> shift) & 1];
  const spacingMode = SPACING_MODES[(flags >> (shift + 1)) & 3];
  const rotateMode = ROTATE_MODES[(flags >> (shift + 3)) & 3];
  if (positionMode !== 'percent') c.positionMode = positionMode;
  if (spacingMode !== 'length') c.spacingMode = spacingMode;
  if (rotateMode !== 'tangent') c.rotateMode = rotateMode;
  if (flags & 0x80) c.rotation = r.float();
  const position = r.float();
  const spacing = r.float();
  if (position) c.position = position;
  if (spacing) c.spacing = spacing;
  const mixRotate = r.float();
  const mixX = r.float();
  const mixY = r.float();
  if (mixRotate !== 1) c.mixRotate = mixRotate;
  if (mixX !== 1) c.mixX = mixX;
  if (mixY !== mixX) c.mixY = mixY;
  return c;
}

/** Slider keys: per constraint, per type, curve keys. */
function readSliderKeys(r, out, anim) {
  const n = r.varint();
  for (let i = 0; i < n; i++) {
    const name = out.constraints[r.varint()]?.name;
    if (name === undefined) throw new Error('invalid constraint index in .skel data');
    const nTypes = r.varint();
    for (let t = 0; t < nTypes; t++) {
      const code = r.byte();
      const type = SLIDER_KEY_TYPES[code];
      if (!type) throw new Unsupported(`Slider key type ${code}`);
      const [kind, def] = type;
      const frames = r.varint();
      r.varint(); // bezier count
      ((anim.slider ??= {})[name] ??= {})[kind] = readCurveKeys(r, frames, (rr, key) => {
        const v = rr.float();
        if (v !== def) key.value = v;
        return 1;
      });
    }
  }
}

/** Path constraint keys: per constraint, per type, curve keys. */
function readPathKeys(r, out, anim) {
  const n = r.varint();
  for (let i = 0; i < n; i++) {
    const name = constraint42(r, out, 'path', r.varint()).name;
    const nTypes = r.varint();
    for (let t = 0; t < nTypes; t++) {
      const code = r.byte();
      const kind = PATH_KEY_TYPES[code];
      if (!kind) throw new Unsupported(`Path constraint key type ${code}`);
      const frames = r.varint();
      r.varint(); // bezier count
      ((anim.path ??= {})[name] ??= {})[kind] = readCurveKeys(r, frames, (rr, key) => {
        if (kind === 'mix') {
          key.mixRotate = rr.float(); key.mixX = rr.float(); key.mixY = rr.float();
          return 3;
        }
        const v = rr.float();
        if (v !== 0) key.value = v;
        return 1;
      });
    }
  }
}

/** Physics keys: per constraint (index + 1; 0 = every constraint), per type, curve keys. */
function readPhysicsKeys(r, out, anim) {
  const n = r.varint();
  for (let i = 0; i < n; i++) {
    const index = r.varint();
    const name = index === 0 ? '' : constraint42(r, out, 'physics', index - 1).name;
    const nTypes = r.varint();
    for (let t = 0; t < nTypes; t++) {
      const code = r.byte();
      const kind = (r.v42 ? PHYSICS_KEY_TYPES_42 : PHYSICS_KEY_TYPES)[code];
      if (!kind) throw new Unsupported(`Physics key type ${code}`);
      const frames = r.varint();
      if (kind === 'reset') {
        const keys = [];
        for (let f = 0; f < frames; f++) {
          const time = r.float();
          keys.push(time ? { time } : {});
        }
        ((anim.physics ??= {})[name] ??= {}).reset = keys;
        continue;
      }
      r.varint(); // bezier count
      ((anim.physics ??= {})[name] ??= {})[kind] = readCurveKeys(r, frames, (rr, key) => {
        const v = rr.float();
        if (v !== 0) key.value = v;
        return 1;
      });
    }
  }
}

/** Slider constraint: flags, time and mix, then the driving bone and property. */
function readSlider(r, name, out, nonessential) {
  const c = { type: 'slider', name };
  const flags = r.byte();
  if (flags & SLIDER_SKIN) c.skin = true;
  if (flags & SLIDER_LOOP) c.loop = true;
  if (flags & SLIDER_ADDITIVE) c.additive = true;
  c.animation = null; // set once the animations are read
  if (flags & SLIDER_TIME) { const v = r.float(); if (nonessential && (flags & SLIDER_BONE)) c.max = v; else c.time = v; }
  if (!(flags & SLIDER_MIX_NOT_0)) c.mix = 0;
  else if (flags & SLIDER_MIX_NOT_1) c.mix = r.float();
  if (flags & SLIDER_BONE) {
    c.bone = out.bones[r.varint()].name;
    const propertyOffset = r.float();
    const property = TRANSFORM_PROPERTIES[r.byte()];
    if (!property) throw new Unsupported(`Slider property on '${name}'`);
    c.property = property;
    if (propertyOffset) c.propertyOffset = propertyOffset;
    const offset = r.float();
    if (offset) c.offset = offset;
    c.scale = r.float();
    if (flags & SLIDER_LOCAL) c.local = true;
  }
  return c;
}

/** Physics constraint: bone, flags, simulated properties, then the simulation settings. */
function readPhysics(r, name, out) {
  const c = { type: 'physics', name, bone: out.bones[r.varint()].name };
  const flags = r.byte();
  if (flags & 0x01) c.skin = true;
  for (const [bit, key] of PHYSICS_PROPERTIES) if (flags & bit) c[key] = r.float();
  if (!r.v42 && c.scaleX < -2) { c.scaleX = -2 - c.scaleX; c.scaleY = 'volume'; }
  else if (!r.v42 && c.scaleX < 0) { c.scaleX = -1 - c.scaleX; c.scaleY = 'uniform'; }
  if (flags & PHYSICS_LIMIT) c.limit = r.float();
  const fps = r.byte();
  if (fps !== PHYSICS_DEFAULTS.fps) c.fps = fps;
  for (const key of ['inertia', 'strength', 'damping']) {
    const v = r.float();
    if (v !== PHYSICS_DEFAULTS[key]) c[key] = v;
  }
  // 4.3 stores the mass here as its inverse; 4.2 stores the mix here and the mass (plain) after the
  // globals, each with the 0x80 flag of its byte.
  if (flags & PHYSICS_MASS) {
    if (r.v42) c.mix = r.float();
    else c.mass = shortestFloat(Math.fround(1 / r.float()));
  }
  const wind = r.float();
  const gravity = r.float();
  if (wind) c.wind = wind;
  if (gravity) c.gravity = gravity;
  const globals = r.byte();
  if (globals & 0x80) {
    if (r.v42) c.mass = r.float();
    else c.mix = r.float();
  }
  PHYSICS_GLOBALS.forEach((key, i) => {
    if (globals & (1 << i)) c[`${key}Global`] = true;
  });
  return c;
}

/** Transform constraint flag bits 0x02, 0x04, 0x08, 0x10 (bit 0 is skin, bits 5-7 the property count). */
const TRANSFORM_FLAGS = ['localSource', 'localTarget', 'additive', 'clamp'];

function readTransform(r, name, bones, out) {
  const mappedByName = (r.transformMapped ??= new Map());
  const source = out.bones[r.varint()].name;
  const flags = r.byte();
  const c = { type: 'transform', name, source, bones };
  if (flags & 0x01) c.skin = true;
  TRANSFORM_FLAGS.forEach((key, i) => {
    if (flags & (0x02 << i)) c[key] = true;
  });
  const properties = {};
  const mapped = new Set();
  for (let p = flags >> 5; p > 0; p--) {
    const from = TRANSFORM_PROPERTIES[r.byte()];
    if (!from) throw new Unsupported(`Transform property on '${name}'`);
    const entry = {};
    const offset = r.float();
    if (offset) entry.offset = offset;
    entry.to = {};
    const nTo = r.varint();
    for (let t = 0; t < nTo; t++) {
      const to = TRANSFORM_PROPERTIES[r.byte()];
      if (!to) throw new Unsupported(`Transform property on '${name}'`);
      const target = {};
      const toOffset = r.float();
      const max = r.float();
      const scale = r.float();
      if (toOffset) target.offset = toOffset;
      if (max !== 1) target.max = max;
      if (scale !== 1) target.scale = scale;
      entry.to[to] = target;
      mapped.add(to);
    }
    properties[from] = entry;
  }
  const offsets = r.byte();
  if (offsets & ~0x3f) throw new Unsupported(`Transform offsets on '${name}'`);
  TRANSFORM_OFFSETS.forEach((key, bit) => {
    if (offsets & (1 << bit)) c[key] = r.float();
  });
  c.properties = properties;
  mappedByName.set(name, mapped);
  const mixes = r.byte();
  if (mixes & ~0x3f) throw new Unsupported(`Transform mixes on '${name}'`);
  const value = TRANSFORM_MIXES.map((_, bit) => (mixes & (1 << bit) ? r.float() : 0));
  // Mixes of unmapped properties have no effect; exporters leave them (and defaults) out.
  TRANSFORM_MIXES.forEach(([key, property, sameAs], bit) => {
    if (!mapped.has(property)) return;
    const def = sameAs === undefined ? 1 : value[sameAs];
    if (value[bit] !== def) c[key] = value[bit];
  });
  return c;
}

/** Reads a vertex count and vertices (weighted: size hint, then bone count + bone/x/y/weight). */
function readVertices(r, a, weighted) {
  const count = r.varint();
  a.vertexCount = count;
  a.vertices = [];
  if (weighted) {
    if (!r.v42) r.varint(); // size hint
    for (let v = 0; v < count; v++) {
      const n = r.varint();
      a.vertices.push(n);
      for (let k = 0; k < n; k++) a.vertices.push(r.varint(), r.float(), r.float(), r.float());
    }
  } else {
    for (let k = 0; k < count * 2; k++) a.vertices.push(r.float());
  }
}

function setColor(a, color) {
  if (color !== DEFAULT_COLORS[a.type]) a.color = color;
}

function readSkin(r, out, nonessential) {
  const skin = {};
  const nSlots = r.varint();
  for (let i = 0; i < nSlots; i++) {
    const slot = out.slots[r.varint()].name;
    const atts = (skin[slot] = {});
    const n = r.varint();
    for (let k = 0; k < n; k++) {
      const key = r.ref();
      const flags = r.byte();
      atts[key] = readAttachment(r, flags, key, nonessential);
    }
  }
  return skin;
}

function readAttachment(r, flags, key, nonessential) {
  const type = flags & 0x07;
  if (type === ATTACHMENT_POINT) {
    const a = { type: 'point' };
    if (flags & FLAG_NAME) a.name = r.ref();
    a.rotation = r.float(); a.x = r.float(); a.y = r.float();
    if (nonessential) a.color = r.color();
    return a;
  }
  if (type === ATTACHMENT_BOUNDINGBOX || type === ATTACHMENT_CLIPPING) {
    if ((flags & ~(VERTICES_WEIGHTED | (!r.v42 && type === ATTACHMENT_CLIPPING ? 0x60 : 0))) !== type) throw new Unsupported(`Attachment options (flags 0x${flags.toString(16)}) on '${key}'`);
    const a = { type: type === ATTACHMENT_CLIPPING ? 'clipping' : 'boundingbox' };
    if (type === ATTACHMENT_CLIPPING && !r.v42) { if (flags & 0x20) a.convex = true; if (flags & 0x40) a.inverse = true; }
    if (type === ATTACHMENT_CLIPPING) a.end = r.slotName(r.varint());
    readVertices(r, a, !!(flags & VERTICES_WEIGHTED));
    if (nonessential) setColor(a, r.color());
    return a;
  }
  if (type === ATTACHMENT_PATH) {
    if (flags & ~(ATTACHMENT_PATH | PATH_CLOSED | PATH_CONSTANT_SPEED | PATH_WEIGHTED)) {
      throw new Unsupported(`Path attachment options (flags 0x${flags.toString(16)}) on '${key}'`);
    }
    const a = { type: 'path' };
    if (flags & PATH_CLOSED) a.closed = true;
    if (!(flags & PATH_CONSTANT_SPEED)) a.constantSpeed = false;
    readVertices(r, a, !!(flags & PATH_WEIGHTED));
    a.lengths = [];
    for (let k = 0; k < a.vertexCount / 3; k++) a.lengths.push(r.float());
    if (nonessential) setColor(a, r.color());
    return a;
  }
  if (type === ATTACHMENT_LINKED_MESH) {
    const a = { type: 'linkedmesh' };
    if (flags & FLAG_NAME) a.name = r.ref();
    if (flags & FLAG_PATH) a.path = r.ref();
    if (flags & FLAG_COLOR) a.color = r.color();
    if (flags & FLAG_SEQUENCE) a.sequence = readSequence(r);
    a._sourceSlot = r.varint();
    const skin = r.varint();
    a.source = r.ref();
    if (skin) a._skinIndex = skin;
    if (!(flags & LINKED_TIMELINES)) a.timelines = false;
    if (nonessential) {
      a.width = r.float();
      a.height = r.float();
    }
    return a;
  }
  const known = FLAG_NAME | FLAG_PATH | FLAG_COLOR | FLAG_SEQUENCE | FLAG_WEIGHTED | 0x07;
  if (flags & ~known) throw new Unsupported(`Attachment options (flags 0x${flags.toString(16)}) on '${key}'`);
  const a = {};
  if (flags & FLAG_NAME) a.name = r.ref();
  if (type === ATTACHMENT_REGION) {
    if (flags & FLAG_PATH) a.path = r.ref();
    if (flags & FLAG_COLOR) a.color = r.color();
    if (flags & FLAG_SEQUENCE) a.sequence = readSequence(r);
    a.rotation = flags & FLAG_ROTATION ? r.float() : 0;
    a.x = r.float();
    a.y = r.float();
    a.scaleX = r.float();
    a.scaleY = r.float();
    a.width = r.float();
    a.height = r.float();
    for (const [k, def] of [['rotation', 0], ['x', 0], ['y', 0], ['scaleX', 1], ['scaleY', 1]]) if (a[k] === def) delete a[k];
    return a;
  }
  if (type !== ATTACHMENT_MESH) throw new Unsupported(`Attachment type ${type} ('${key}')`);
  a.type = 'mesh';
  if (flags & FLAG_PATH) a.path = r.ref();
  if (flags & FLAG_COLOR) a.color = r.color();
  if (flags & FLAG_SEQUENCE) a.sequence = readSequence(r);
  a.hull = r.varint();
  const count = r.varint();
  a.vertices = [];
  if (flags & FLAG_WEIGHTED) {
    if (!r.v42) r.varint(); // size hint: bone counts + bone indices
    for (let v = 0; v < count; v++) {
      const n = r.varint();
      a.vertices.push(n);
      for (let k = 0; k < n; k++) a.vertices.push(r.varint(), r.float(), r.float(), r.float());
    }
  } else {
    for (let k = 0; k < count * 2; k++) a.vertices.push(r.float());
  }
  a.uvs = [];
  for (let k = 0; k < count * 2; k++) a.uvs.push(r.float());
  a.triangles = [];
  for (let k = 0; k < 3 * (2 * count - a.hull - 2); k++) a.triangles.push(r.varint());
  if (!r.v42) {
    const n = r.varint();
    if (n) { a._timelineSlots = []; for (let i = 0; i < n; i++) a._timelineSlots.push(r.varint()); }
  }
  if (nonessential) {
    const ne = r.varint();
    a.edges = [];
    for (let k = 0; k < ne; k++) a.edges.push(r.varint());
    a.width = r.float();
    a.height = r.float();
  }
  return a;
}

/** Sequence keys: time, (frame index << 4 | mode) as a 32-bit integer, delay. JSON leaves out a delay equal to the previous key's. */
function readSequenceKeys(r, frames) {
  const keys = [];
  let lastDelay = 0;
  for (let f = 0; f < frames; f++) {
    const key = {};
    const time = r.float();
    const modeAndIndex = r.uint();
    const delay = r.float();
    const mode = SEQUENCE_MODES[modeAndIndex & 0x0f];
    if (!mode) throw new Unsupported(`Sequence mode ${modeAndIndex & 0x0f}`);
    if (time) key.time = time;
    if (mode !== 'hold') key.mode = mode;
    if (modeAndIndex >> 4) key.index = modeAndIndex >> 4;
    if (delay !== lastDelay) key.delay = delay;
    lastDelay = delay;
    keys.push(key);
  }
  return keys;
}

function writeSequenceKeys(w, keys) {
  let delay = 0;
  for (const k of keys) {
    delay = k.delay ?? delay;
    const mode = SEQUENCE_MODES.indexOf(k.mode ?? 'hold');
    if (mode < 0) throw new Unsupported(`Sequence mode '${k.mode}'`);
    w.float(k.time ?? 0);
    w.uint(((k.index ?? 0) << 4) | mode);
    w.float(delay);
  }
}

/** Image sequence: frame count, number of the first image, digits, setup frame. */
function readSequence(r) {
  const seq = { count: r.varint() };
  const start = r.varint();
  const digits = r.varint();
  const setup = r.varint();
  if (start !== 1) seq.start = start;
  if (digits !== 0) seq.digits = digits;
  if (setup !== 0) seq.setup = setup;
  return seq;
}

function writeSequence(w, seq) {
  w.varint(seq.count ?? 1);
  w.varint(seq.start ?? 1);
  w.varint(seq.digits ?? 0);
  w.varint(seq.setup ?? 0);
}

/** Reads keys of `n` values; the curve of a segment follows the segment's second key. */
function readCurveKeys(r, frames, read) {
  const keys = [];
  for (let f = 0; f < frames; f++) {
    const key = { time: r.float() };
    const n = read(r, key);
    if (f > 0) {
      const type = r.byte();
      const prev = keys[f - 1];
      if (type === CURVE_STEPPED) prev.curve = 'stepped';
      else if (type === CURVE_BEZIER) {
        prev.curve = [];
        for (let i = 0; i < 4 * n; i++) prev.curve.push(r.float());
      } else if (type !== CURVE_LINEAR) throw new Error(`invalid curve type ${type}`);
    }
    keys.push(key);
  }
  for (const k of keys) if (k.time === 0) delete k.time;
  return keys;
}

/** Deform keys: time, the previous segment's curve, then a value count, start offset and values. */
function readDeformKeys(r, frames) {
  const keys = [];
  for (let f = 0; f < frames; f++) {
    const key = {};
    const time = r.float();
    if (time) key.time = time;
    if (f > 0) {
      const type = r.byte();
      const prev = keys[f - 1];
      if (type === CURVE_STEPPED) prev.curve = 'stepped';
      else if (type === CURVE_BEZIER) prev.curve = [r.float(), r.float(), r.float(), r.float()];
      else if (type !== CURVE_LINEAR) throw new Error(`invalid curve type ${type}`);
    }
    const count = r.varint();
    if (count) {
      const offset = r.varint();
      if (offset) key.offset = offset;
      key.vertices = [];
      for (let k = 0; k < count; k++) key.vertices.push(r.float());
    }
    keys.push(key);
  }
  return keys;
}

function readAnimation(r, out, eventNames, nonessential) {
  const anim = {};
  r.varint(); // total timeline count
  const nSlots = r.varint();
  for (let i = 0; i < nSlots; i++) {
    const slot = out.slots[r.varint()].name;
    const timelines = ((anim.slots ??= {})[slot] = {});
    const n = r.varint();
    for (let t = 0; t < n; t++) {
      const type = r.byte();
      const frames = r.varint();
      if (type === SLOT_ATTACHMENT) {
        timelines.attachment = [];
        for (let f = 0; f < frames; f++) {
          const time = r.float();
          const name = r.ref();
          const key = {};
          if (time) key.time = time;
          if (name !== null) key.name = name;
          timelines.attachment.push(key);
        }
      } else if (type === 2 || type === 4 || type === 5) {
        r.varint();
        const kind = type === 2 ? 'rgb' : type === 4 ? 'rgb2' : 'alpha';
        timelines[kind] = readCurveKeys(r, frames, (rr, key) => {
          if (type === 2) key.color = rr.color3();
          else if (type === 4) { key.light = rr.color3(); key.dark = rr.color3(); }
          else key.value = rr.byte() / 255;
          return type === 2 ? 3 : type === 4 ? 6 : 1;
        });
      } else if (type === SLOT_RGBA) {
        r.varint(); // bezier count
        timelines.rgba = readCurveKeys(r, frames, (rr, key) => {
          key.color = rr.color();
          return 4;
        });
      } else if (type === SLOT_RGBA2) {
        r.varint(); // bezier count
        timelines.rgba2 = readCurveKeys(r, frames, (rr, key) => {
          key.light = rr.color();
          key.dark = rr.color3();
          return 7;
        });
      } else {
        throw new Unsupported(`Slot timeline type ${type}`);
      }
    }
  }
  const nBones = r.varint();
  for (let i = 0; i < nBones; i++) {
    const bone = out.bones[r.varint()].name;
    const timelines = ((anim.bones ??= {})[bone] = {});
    const n = r.varint();
    for (let t = 0; t < n; t++) {
      const type = r.byte();
      const frames = r.varint();
      if (type === BONE_INHERIT_42) {
        timelines.inherit = [];
        for (let f = 0; f < frames; f++) {
          const time = r.float();
          const inherit = INHERIT[r.byte()] ?? 'normal';
          timelines.inherit.push({ ...(time ? { time } : {}), ...(inherit !== 'normal' ? { inherit } : {}) });
        }
        continue;
      }
      r.varint(); // bezier count
      const spec = BONE_TIMELINES[type];
      if (!spec) throw new Unsupported(`Bone timeline type ${type}`);
      const [kind, count] = spec;
      const def = kind.startsWith('scale') ? 1 : 0;
      timelines[kind] = readCurveKeys(r, frames, (rr, key) => {
        if (count === 1) {
          const v = rr.float();
          if (v !== def) key.value = v;
        } else {
          const x = rr.float();
          const y = rr.float();
          if (x !== def) key.x = x;
          if (y !== def) key.y = y;
        }
        return count;
      });
    }
  }
  const nIk = r.varint();
  for (let i = 0; i < nIk; i++) {
    const constraint = constraint42(r, out, 'ik', r.varint()).name;
    const frames = r.varint();
    r.varint(); // bezier count
    const keys = ((anim.ik ??= {})[constraint] = []);
    for (let f = 0; f < frames; f++) {
      const flags = r.byte();
      const key = {};
      const time = r.float();
      if (time) key.time = time;
      if (!(flags & 0x01)) key.mix = 0;
      else if (flags & 0x02) key.mix = r.float();
      if (flags & 0x04) key.softness = r.float();
      if (!(flags & 0x08)) key.bendPositive = false;
      if (flags & 0x10) key.compress = true;
      if (flags & 0x20) key.stretch = true;
      // The curve of the segment ending at this key: stepped, or mix and softness beziers.
      if (flags & IK_KEY_STEPPED) {
        if (f > 0) keys[f - 1].curve = 'stepped';
      } else if (flags & IK_KEY_BEZIER) {
        const curve = [];
        for (let k = 0; k < 8; k++) curve.push(r.float());
        if (f > 0) keys[f - 1].curve = curve;
      }
      keys.push(key);
    }
  }
  const nTransform = r.varint();
  for (let i = 0; i < nTransform; i++) {
    const constraint = constraint42(r, out, 'transform', r.varint()).name;
    const frames = r.varint();
    r.varint(); // bezier count
    const mapped = r.transformMapped?.get(constraint) ?? new Set(TRANSFORM_PROPERTIES);
    (anim.transform ??= {})[constraint] = readCurveKeys(r, frames, (rr, key) => {
      TRANSFORM_MIXES.forEach(([mix, property]) => {
        const v = rr.float();
        if (v !== 1 && mapped.has(property)) key[mix] = v;
      });
      return TRANSFORM_KEY_MIXES.length;
    });
  }
  for (let s = 0; s < (r.v42 ? 2 : UNKNOWN_ANIMATION_SECTIONS); s++) {
    if (s === ANIMATION_SECTION_PATH) readPathKeys(r, out, anim);
    else if (s === ANIMATION_SECTION_PHYSICS) readPhysicsKeys(r, out, anim);
    else readSliderKeys(r, out, anim);
  }
  const nSkins = r.varint();
  for (let i = 0; i < nSkins; i++) {
    const skin = out.skins[r.varint()]?.name;
    if (!skin) throw new Error('invalid skin index in .skel data');
    const nSlots = r.varint();
    for (let k = 0; k < nSlots; k++) {
      const slot = r.slotName(r.varint());
      const nAttachments = r.varint();
      for (let a = 0; a < nAttachments; a++) {
        const attachment = r.ref();
        const type = r.byte();
        const frames = r.varint();
        const timelines = ((((anim.attachments ??= {})[skin] ??= {})[slot] ??= {})[attachment] ??= {});
        if (type === ATTACHMENT_DEFORM) {
          r.varint(); // bezier count
          timelines.deform = readDeformKeys(r, frames);
        } else if (type === ATTACHMENT_SEQUENCE) {
          timelines.sequence = readSequenceKeys(r, frames);
        } else {
          throw new Unsupported(`Attachment timeline type ${type}`);
        }
      }
    }
  }
  const nDraw = r.varint();
  for (let i = 0; i < nDraw; i++) {
    const key = {};
    const time = r.float();
    if (time) key.time = time;
    const n = r.varint();
    if (n) key.offsets = [];
    for (let k = 0; k < n; k++) key.offsets.push({ slot: out.slots[r.varint()].name, offset: r.varint() | 0 });
    (anim.drawOrder ??= []).push(key);
  }
  if (!r.v42) {
    const folders = r.varint();
    if (folders) anim._drawOrderFolders = [];
    for (let i = 0; i < folders; i++) {
      const slots = Array.from({ length: r.varint() }, () => r.varint());
      const keys = Array.from({ length: r.varint() }, () => {
        const time = r.float();
        const offsets = Array.from({ length: r.varint() }, () => ({ slot: r.varint(), offset: r.varint() | 0 }));
        return { time, offsets };
      });
      anim._drawOrderFolders.push({ slots, keys });
    }
  }
  const nEvents = r.varint();
  for (let i = 0; i < nEvents; i++) {
    const time = r.float();
    const key = { ...(time ? { time } : {}), name: eventNames[r.varint()] };
    const int = r.varint(false);
    const float = r.float();
    const def = out.events[key.name] ?? {};
    if (int !== (def.int ?? 0)) key.int = int;
    if (float !== (def.float ?? 0)) key.float = float;
    if (r.bool()) key.string = r.string();
    if (def.audio) {
      key.volume = r.float();
      key.balance = r.float();
    }
    (anim.events ??= []).push(key);
  }
  if (!r.v42 && nonessential) {
    const color = r.color();
    if (color !== 'ffffffff') anim._color = color;
  }
  return anim;
}

// ---- format 4.2 -------------------------------------------------------------------------------

/** The 4.2 constraint lists, in file order; animations and skins index each list on its own. */
const CONSTRAINT_LISTS_42 = ['ik', 'transform', 'path', 'physics'];
/** Transform constraint flags (4.2): local, relative, then which offsets are present. */
const TRANSFORM_FLAGS_42 = [['rotation', 0x08], ['x', 0x10], ['y', 0x20], ['scaleX', 0x40], ['scaleY', 0x80]];
const BONE_INHERIT_42 = 10;

/** The constraint a 4.2 (typed list) or 4.3 (unified list) index names. */
function constraint42(r, out, type, index) {
  const c = r.v42 ? out[type]?.[index] : out.constraints[index];
  if (!c) throw new Error('invalid constraint index in .skel data');
  return c;
}

/**
 * The four 4.2 constraint lists: IK, transform, path, physics. Each entry starts with its name and
 * application order; the rest matches the 4.3 encoding except transform constraints, which keep
 * 4.2's offsets and six mixes (a flag bit per non-zero value).
 */
function readConstraints42(r, out) {
  const bones = () => {
    const list = [];
    const n = r.varint();
    for (let k = 0; k < n; k++) list.push(out.bones[r.varint()].name);
    return list;
  };
  for (const type of CONSTRAINT_LISTS_42) {
    out[type] = [];
    const n = r.varint();
    for (let i = 0; i < n; i++) {
      const name = r.string();
      const order = r.varint();
      let c;
      if (type === 'physics') c = readPhysics(r, name, out);
      else {
        const list = bones();
        c = type === 'ik' ? readIk(r, name, list, out) : type === 'path' ? readPath(r, name, list, out) : readTransform42(r, name, list, out);
      }
      delete c.type;
      out[type].push({ name, order, ...c });
    }
    if (!out[type].length) delete out[type];
  }
}

function readTransform42(r, name, bones, out) {
  const c = { type: 'transform', name, bones, target: out.bones[r.varint()].name };
  const flags = r.byte();
  if (flags & 0x01) c.skin = true;
  if (flags & 0x02) c.local = true;
  if (flags & 0x04) c.relative = true;
  for (const [key, bit] of TRANSFORM_FLAGS_42) if (flags & bit) c[key] = r.float();
  const mixes = r.byte();
  if (mixes & 0x01) c.shearY = r.float();
  if (mixes & 0x80) throw new Unsupported(`Transform constraint options (0x${mixes.toString(16)}) on '${name}'`);
  // A clear bit is a mix of 0; JSON leaves out the default of 1.
  TRANSFORM_MIXES.forEach(([key], i) => {
    const v = mixes & (0x02 << i) ? r.float() : 0;
    if (v !== 1) c[key] = v;
  });
  return c;
}

// ---- writing ----------------------------------------------------------------------------------

class Writer {
  constructor(strings) {
    this.buf = new Uint8Array(1 << 16);
    this.p = 0;
    this.enc = new TextEncoder();
    this.strings = strings;
    this.index = new Map();
    strings.forEach((s, i) => {
      if (!this.index.has(s)) this.index.set(s, i);
    });
  }
  ensure(n) {
    if (this.p + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.p + n));
    next.set(this.buf);
    this.buf = next;
  }
  byte(v) {
    this.ensure(1);
    this.buf[this.p++] = v & 0xff;
  }
  bool(v) {
    this.byte(v ? 1 : 0);
  }
  bytes(b) {
    this.ensure(b.length);
    this.buf.set(b, this.p);
    this.p += b.length;
  }
  float(v) {
    this.ensure(4);
    new DataView(this.buf.buffer).setFloat32(this.p, v);
    this.p += 4;
  }
  uint(v) {
    this.ensure(4);
    new DataView(this.buf.buffer).setUint32(this.p, v >>> 0);
    this.p += 4;
  }
  varint(v, positive = true) {
    let u = positive ? v >>> 0 : ((v << 1) ^ (v >> 31)) >>> 0;
    do {
      let b = u & 0x7f;
      u >>>= 7;
      if (u) b |= 0x80;
      this.byte(b);
    } while (u);
  }
  string(s) {
    if (s === null || s === undefined) return this.varint(0);
    const b = this.enc.encode(s);
    this.varint(b.length + 1);
    this.bytes(b);
  }
  ref(s) {
    if (s === null || s === undefined) return this.varint(0);
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push(s);
      this.index.set(s, i);
    }
    this.varint(i + 1);
  }
  color3(hex) {
    const h = (hex ?? '000000').toLowerCase();
    for (let i = 0; i < 6; i += 2) this.byte(parseInt(h.slice(i, i + 2), 16));
  }
  color(hex, def = 'ffffffff') {
    const h = (hex ?? def).toLowerCase();
    this.uint(parseInt((h.length === 6 ? `${h}ff` : h).slice(0, 8), 16));
  }
  result() {
    return this.buf.slice(0, this.p);
  }
}

/** Collects every string written as a reference, in the order the writer uses them. */
function collectRefs(json) {
  const refs = [];
  for (const s of json.slots ?? []) if (s.attachment) refs.push(s.attachment);
  for (const skin of json.skins ?? []) {
    for (const atts of Object.values(skin.attachments ?? {})) {
      for (const [key, a] of Object.entries(atts)) {
        refs.push(key);
        if (a.name !== undefined && a.name !== key) refs.push(a.name);
        if (a.type === 'linkedmesh') refs.push(a.source ?? a.parent);
        if (a.path !== undefined) refs.push(a.path);
      }
    }
  }
  for (const anim of Object.values(json.animations ?? {})) {
    for (const timelines of Object.values(anim.slots ?? {})) for (const k of timelines.attachment ?? []) if (k.name) refs.push(k.name);
    for (const slots of Object.values(anim.attachments ?? {})) for (const atts of Object.values(slots)) refs.push(...Object.keys(atts));
  }
  return refs;
}

/**
 * Converts a skeleton JSON object (4.3 field names, e.g. from `writeSkeletonJson(sk, { version:
 * '4.3', binary: true })`) into binary `.skel` bytes. Throws for features the binary encoding
 * does not support yet.
 */
export function writeSkeletonBinary(json) {
  for (const key of ['ik', 'transform', 'path', 'physics']) if (json[key]?.length) throw new Unsupported('A pre-4.3 constraint layout');
  // The string table: keep an imported file's table (so unchanged files encode identically), then
  // add any new references.
  const strings = (json._strings ?? []).slice();
  const known = new Set(strings);
  for (const s of collectRefs(json)) {
    if (!known.has(s)) {
      known.add(s);
      strings.push(s);
    }
  }
  const head = new Writer([]);
  const w = new Writer(strings);
  const sk = json.skeleton ?? {};
  const hash = fromBase64(sk.hash ?? '');
  for (let i = 0; i < 8; i++) head.byte(hash[i] ?? 0);
  head.string(String(sk[VERSION_FIELD] ?? '4.3.0'));
  for (const k of ['x', 'y', 'width', 'height']) head.float(sk[k] ?? 0);
  head.float(sk.referenceScale ?? 100);
  head.bool(true);
  head.float(sk.fps ?? 30);
  head.string(sk.images ?? null);
  head.string(sk.audio ?? null);

  const boneIndex = new Map((json.bones ?? []).map((b, i) => [b.name, i]));
  const skinIndex = new Map((json.skins ?? []).map((sk, i) => [sk.name, i]));
  /** Target properties each transform constraint maps. */
  const transformMapped = new Map();
  for (const c of json.constraints ?? []) {
    if (c.type !== 'transform') continue;
    const set = new Set();
    for (const entry of Object.values(c.properties ?? {})) for (const to of Object.keys(entry.to ?? {})) set.add(to);
    transformMapped.set(c.name, set);
  }
  const slotIndex = new Map((json.slots ?? []).map((s, i) => [s.name, i]));
  const constraintIndex = new Map();

  w.varint(json.bones.length);
  json.bones.forEach((b, i) => {
    w.string(b.name);
    if (i > 0) w.varint(boneIndex.get(b.parent));
    for (const [k, def] of [['rotation', 0], ['x', 0], ['y', 0], ['scaleX', 1], ['scaleY', 1], ['shearX', 0], ['shearY', 0]]) w.float(b[k] ?? def);
    w.byte(Math.max(0, INHERIT.indexOf(b.inherit ?? b.transform ?? 'normal')));
    w.float(b.length ?? 0);
    w.bool(!!b.skin);
    w.color(b.color, DEFAULT_BONE_COLOR);
    w.string(b.icon ?? null);
    w.float(b._iconA ?? 1);
    w.float(b._iconB ?? 0);
    w.bool(b._visible ?? true);
  });

  w.varint((json.slots ?? []).length);
  for (const s of json.slots ?? []) {
    w.string(s.name);
    w.varint(boneIndex.get(s.bone));
    w.color(s.color);
    w.color(s.dark ? `00${s.dark.slice(0, 6)}` : null);
    w.ref(s.attachment ?? null);
    w.byte(Math.max(0, BLEND.indexOf(s.blend ?? 'normal')));
    w.bool(s._visible ?? true);
  }

  const constraints = json.constraints ?? [];
  w.varint(constraints.length);
  constraints.forEach((c, i) => {
    constraintIndex.set(`${c.type}:${c.name}`, i);
    w.string(c.name);
    if (c.type === 'ik') writeIk(w, c, boneIndex);
    else if (c.type === 'path') writePath(w, c, boneIndex, slotIndex);
    else if (c.type === 'transform') writeTransform(w, c, boneIndex);
    else if (c.type === 'physics') writePhysics(w, c, boneIndex);
    else if (c.type === 'slider') writeSlider(w, c, boneIndex);
    else throw new Unsupported(`'${c.type}' constraints`);
  });

  const skins = json.skins ?? [];
  const writeSkinAttachments = (skin) => {
    const slotsWithAttachments = Object.entries(skin.attachments ?? {});
    w.varint(slotsWithAttachments.length);
    for (const [slot, atts] of slotsWithAttachments) {
      w.varint(slotIndex.get(slot));
      const entries = Object.entries(atts);
      w.varint(entries.length);
      for (const [key, a] of entries) writeAttachment(w, key, a, slotIndex, skinIndex, slot);
    }
  };
  writeSkinAttachments(skins.find((sk) => sk.name === 'default') ?? { attachments: {} });
  const others = skins.filter((sk) => sk.name !== 'default');
  w.varint(others.length);
  for (const skin of others) {
    w.string(skin.name);
    w.color(skin._color ?? skin.color ?? 'ffffffff');
    const bones = skin.bones ?? [];
    w.varint(bones.length);
    for (const b of bones) w.varint(boneIndex.get(b));
    const refs = [];
    for (const type of ['ik', 'transform', 'path', 'physics']) {
      for (const name of skin[type] ?? []) {
        const index = constraintIndex.get(`${type}:${name}`);
        if (index === undefined) throw new Error(`unknown ${type} constraint '${name}' in skin '${skin.name}'`);
        refs.push(index);
      }
    }
    w.varint(refs.length);
    for (const i of refs) w.varint(i);
    writeSkinAttachments(skin);
  }

  const eventNames = Object.keys(json.events ?? {});
  w.varint(eventNames.length);
  for (const name of eventNames) {
    const e = json.events[name];
    w.string(name);
    w.varint(e.int ?? 0, false);
    w.float(e.float ?? 0);
    w.string(e.string ?? '');
    w.string(e.audio ?? null);
    if (e.audio) {
      w.float(e.volume ?? 1);
      w.float(e.balance ?? 0);
    }
  }

  const animations = Object.entries(json.animations ?? {});
  w.varint(animations.length);
  for (const [name, anim] of animations) {
    w.string(name);
    writeAnimation(w, anim, { boneIndex, slotIndex, constraintIndex, skinIndex, transformMapped, eventNames, events: json.events ?? {} });
  }
  // Each slider constraint's animation, by index.
  const animationNames = animations.map(([name]) => name);
  for (const c of json.constraints ?? []) {
    if (c.type !== 'slider') continue;
    const index = animationNames.indexOf(c.animation);
    if (index < 0) throw new Error(`unknown animation '${c.animation}' in slider '${c.name}'`);
    w.varint(index);
  }

  // Header, then the (possibly extended) string table, then the body.
  const table = new Writer([]);
  table.varint(w.strings.length);
  for (const s of w.strings) table.string(s);
  const parts = [head.result(), table.result(), w.result()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function writeBones(w, c, boneIndex) {
  w.varint(c.bones.length);
  for (const b of c.bones) w.varint(boneIndex.get(b));
}

function writeIk(w, c, boneIndex) {
  w.byte(CONSTRAINT_IK);
  writeBones(w, c, boneIndex);
  w.varint(boneIndex.get(c.target));
  const mix = c.mix ?? 1;
  const bendNegative = c.bones.length < 2 || c.bendPositive === false;
  const scaleMode = c.scaleY ?? (c.uniform ? 'uniform' : 'none');
  const mode = ['none', 'uniform', 'volume'].indexOf(scaleMode);
  if (mode < 0) throw new Unsupported(`IK scaleYMode '${scaleMode}'`);
  w.byte((c.skin ? IK_SKIN : 0) | (mode ? 2 : 0) | (bendNegative ? IK_BEND_NEGATIVE : 0) | (c.compress ? 8 : 0) | (c.stretch ? 16 : 0) | (mix !== 0 ? IK_MIX_NOT_0 : 0) | (mix !== 0 && mix !== 1 ? IK_MIX_NOT_1 : 0) | (c.softness ? 128 : 0));
  if (mode) w.byte(mode);
  if (mix !== 0 && mix !== 1) w.float(mix);
  if (c.softness) w.float(c.softness);
}

function writePath(w, c, boneIndex, slotIndex) {
  w.byte(CONSTRAINT_PATH);
  writeBones(w, c, boneIndex);
  w.varint(slotIndex.get(c.slot ?? c.target));
  const position = Math.max(0, POSITION_MODES.indexOf(c.positionMode ?? 'percent'));
  const spacing = Math.max(0, SPACING_MODES.indexOf(c.spacingMode ?? 'length'));
  const rotate = Math.max(0, ROTATE_MODES.indexOf(c.rotateMode ?? 'tangent'));
  w.byte((c.skin ? 0x01 : 0) | (position << 1) | (spacing << 2) | (rotate << 4) | (c.rotation ? 0x80 : 0));
  if (c.rotation) w.float(c.rotation);
  w.float(c.position ?? 0);
  w.float(c.spacing ?? 0);
  const mixX = c.mixX ?? 1;
  w.float(c.mixRotate ?? 1);
  w.float(mixX);
  w.float(c.mixY ?? mixX);
}

function writeSlider(w, c, boneIndex) {
  for (const key of Object.keys(c)) {
    if (!['type', 'name', 'skin', 'loop', 'additive', 'animation', 'time', 'max', 'mix', 'bone', 'property', 'propertyOffset', 'offset', 'scale', 'local', 'order'].includes(key)) {
      throw new Unsupported(`Slider constraint '${key}' setting ('${c.name}')`);
    }
  }
  const mix = c.mix ?? 1;
  let flags = 0;
  if (c.skin) flags |= SLIDER_SKIN;
  if (c.loop) flags |= SLIDER_LOOP;
  if (c.additive) flags |= SLIDER_ADDITIVE;
  if (c.max || c.time) flags |= SLIDER_TIME;
  if (mix !== 0) flags |= SLIDER_MIX_NOT_0;
  if (mix !== 0 && mix !== 1) flags |= SLIDER_MIX_NOT_1;
  if (c.bone !== undefined) flags |= SLIDER_BONE;
  if (c.bone !== undefined && c.local) flags |= SLIDER_LOCAL;
  w.byte(CONSTRAINT_SLIDER);
  w.byte(flags);
  if (flags & SLIDER_TIME) w.float(c.bone !== undefined ? (c.max ?? c.time) : c.time);
  if (flags & SLIDER_MIX_NOT_1) w.float(mix);
  if (c.bone !== undefined) {
    const bone = boneIndex.get(c.bone);
    if (bone === undefined) throw new Error(`unknown bone '${c.bone}'`);
    w.varint(bone);
    w.float(c.propertyOffset ?? 0);
    const property = TRANSFORM_PROPERTIES.indexOf(c.property ?? 'rotate');
    if (property < 0) throw new Unsupported(`Slider property '${c.property}' ('${c.name}')`);
    w.byte(property);
    w.float(c.offset ?? 0);
    w.float(c.scale ?? 1);
  }
}

function writePhysics(w, c, boneIndex) {
  const bone = boneIndex.get(c.bone);
  if (bone === undefined) throw new Error(`unknown bone '${c.bone}'`);
  const limit = c.limit !== undefined && c.limit !== PHYSICS_DEFAULTS.limit;
  const mass = c.mass !== undefined && c.mass !== 1;
  let flags = c.skin ? 0x01 : 0;
  for (const [bit, key] of PHYSICS_PROPERTIES) if (c[key] || (key === 'scaleX' && c.scaleY && c.scaleY !== 'none')) flags |= bit;
  if (limit) flags |= PHYSICS_LIMIT;
  if (mass) flags |= PHYSICS_MASS;
  w.byte(CONSTRAINT_PHYSICS);
  w.varint(bone);
  w.byte(flags);
  for (const [bit, key] of PHYSICS_PROPERTIES) if (flags & bit) {
    let value = c[key] ?? 0;
    if (key === 'scaleX' && c.scaleY === 'uniform') value = -1 - value;
    if (key === 'scaleX' && c.scaleY === 'volume') value = -2 - value;
    w.float(value);
  }
  if (limit) w.float(c.limit);
  w.byte(c.fps ?? PHYSICS_DEFAULTS.fps);
  for (const key of ['inertia', 'strength', 'damping']) w.float(c[key] ?? PHYSICS_DEFAULTS[key]);
  if (mass) w.float(1 / c.mass);
  w.float(c.wind ?? 0);
  w.float(c.gravity ?? 0);
  let globals = 0;
  PHYSICS_GLOBALS.forEach((key, i) => {
    if (c[`${key}Global`]) globals |= 1 << i;
  });
  if (c.mix !== undefined && c.mix !== 1) globals |= 0x80;
  w.byte(globals);
  if (globals & 0x80) w.float(c.mix);
}

function writeTransform(w, c, boneIndex) {
  const properties = Object.entries(c.properties ?? {});
  if (properties.length > 7) throw new Unsupported(`More than 7 transform properties ('${c.name}')`);
  w.byte(CONSTRAINT_TRANSFORM);
  writeBones(w, c, boneIndex);
  w.varint(boneIndex.get(c.source));
  // 4.2's local/relative are 4.3's localSource + localTarget / additive.
  const options = [c.localSource ?? c.local, c.localTarget ?? c.local, c.additive ?? c.relative, c.clamp];
  w.byte((properties.length << 5) | options.reduce((bits, on, i) => (on ? bits | (0x02 << i) : bits), c.skin ? 0x01 : 0));
  const mapped = new Set();
  for (const [from, entry] of properties) {
    const fromId = TRANSFORM_PROPERTIES.indexOf(from);
    if (fromId < 0) throw new Unsupported(`Transform property '${from}' ('${c.name}')`);
    w.byte(fromId);
    w.float(entry.offset ?? 0);
    const targets = Object.entries(entry.to ?? {});
    w.varint(targets.length);
    for (const [to, t] of targets) {
      const toId = TRANSFORM_PROPERTIES.indexOf(to);
      if (toId < 0) throw new Unsupported(`Transform property '${to}' ('${c.name}')`);
      w.byte(toId);
      w.float(t.offset ?? 0);
      w.float(t.max ?? 1);
      w.float(t.scale ?? 1);
      mapped.add(to);
    }
  }
  let offsets = 0;
  TRANSFORM_OFFSETS.forEach((key, bit) => {
    if (c[key]) offsets |= 1 << bit;
  });
  w.byte(offsets);
  for (const key of TRANSFORM_OFFSETS) if (c[key]) w.float(c[key]);
  const values = [];
  TRANSFORM_MIXES.forEach(([key, property, sameAs], bit) => {
    const def = sameAs === undefined ? 1 : values[sameAs];
    values[bit] = mapped.has(property) ? (c[key] ?? def) : 0;
  });
  let mixes = 0;
  values.forEach((v, bit) => {
    if (v !== 0) mixes |= 1 << bit;
  });
  w.byte(mixes);
  for (const v of values) if (v !== 0) w.float(v);
}

function writeVertexAttachment(w, key, a, type, slotIndex) {
  const count = a.vertexCount ?? a.vertices.length / 2;
  const weighted = a.vertices.length > count * 2;
  if (a.sequence !== undefined) throw new Unsupported(`Sequences ('${key}')`);
  w.ref(key);
  if (type === 'path') {
    let flags = ATTACHMENT_PATH;
    if (a.closed) flags |= PATH_CLOSED;
    if (a.constantSpeed !== false) flags |= PATH_CONSTANT_SPEED;
    if (weighted) flags |= PATH_WEIGHTED;
    w.byte(flags);
  } else {
    w.byte((type === 'clipping' ? ATTACHMENT_CLIPPING : ATTACHMENT_BOUNDINGBOX) | (weighted ? VERTICES_WEIGHTED : 0) | (type === 'clipping' && a.convex ? 0x20 : 0) | (type === 'clipping' && a.inverse ? 0x40 : 0));
  }
  if (type === 'clipping') w.varint(slotIndex.get(a.end));
  w.varint(count);
  if (weighted) {
    let hint = 0;
    for (let i = 0; i < a.vertices.length; ) {
      const n = a.vertices[i];
      hint += 1 + n;
      i += 1 + n * 4;
    }
    w.varint(hint);
    for (let i = 0; i < a.vertices.length; ) {
      const n = a.vertices[i++];
      w.varint(n);
      for (let k = 0; k < n; k++) {
        w.varint(a.vertices[i++]);
        w.float(a.vertices[i++]);
        w.float(a.vertices[i++]);
        w.float(a.vertices[i++]);
      }
    }
  } else {
    for (const v of a.vertices) w.float(v);
  }
  // One length per path point (the reader relies on that count).
  if (type === 'path') for (let k = 0; k < count / 3; k++) w.float(a.lengths?.[k] ?? a.lengths?.at(-1) ?? 0);
  w.color(a.color ?? DEFAULT_COLORS[type] ?? 'ce3a3aff');
}

function writeLinkedMesh(w, key, a, slotIndex, skinIndex, slot) {
  const named = a.name !== undefined && a.name !== key;
  w.ref(key);
  w.byte(ATTACHMENT_LINKED_MESH | (named ? FLAG_NAME : 0) | (a.path !== undefined ? FLAG_PATH : 0) | (a.color !== undefined ? FLAG_COLOR : 0) | (a.sequence ? FLAG_SEQUENCE : 0) | (a.timelines === false || a.deform === false ? 0 : LINKED_TIMELINES));
  if (named) w.ref(a.name);
  if (a.path !== undefined) w.ref(a.path);
  if (a.color !== undefined) w.color(a.color);
  if (a.sequence) writeSequence(w, a.sequence);
  w.varint(a._sourceSlot ?? slotIndex.get(slot));
  const skin = a.skin ? skinIndex.get(a.skin) : 0;
  if (skin === undefined) throw new Error(`unknown skin '${a.skin}'`);
  w.varint(skin);
  w.ref(a.source ?? a.parent);
  w.float(a.width ?? 0);
  w.float(a.height ?? 0);
}

function writeAttachment(w, key, a, slotIndex, skinIndex, slot) {
  const type = a.type ?? 'region';
  if (type === 'point') {
    const named = a.name !== undefined && a.name !== key;
    w.ref(key); w.byte(ATTACHMENT_POINT | (named ? FLAG_NAME : 0)); if (named) w.ref(a.name);
    w.float(a.rotation ?? 0); w.float(a.x ?? 0); w.float(a.y ?? 0); w.color(a.color ?? 'f1f100ff'); return;
  }
  if (type === 'boundingbox' || type === 'clipping' || type === 'path') return writeVertexAttachment(w, key, a, type, slotIndex);
  if (type === 'linkedmesh') return writeLinkedMesh(w, key, a, slotIndex, skinIndex, slot);
  if (type !== 'region' && type !== 'mesh') throw new Unsupported(`'${type}' attachments ('${key}')`);
  const named = a.name !== undefined && a.name !== key;
  w.ref(key);
  if (type === 'region') {
    const rotation = a.rotation ?? 0;
    w.byte((rotation ? FLAG_ROTATION : 0) | (named ? FLAG_NAME : 0) | (a.path !== undefined ? FLAG_PATH : 0) | (a.color !== undefined ? FLAG_COLOR : 0) | (a.sequence ? FLAG_SEQUENCE : 0) | ATTACHMENT_REGION);
    if (named) w.ref(a.name);
    if (a.path !== undefined) w.ref(a.path);
    if (a.color !== undefined) w.color(a.color);
    if (a.sequence) writeSequence(w, a.sequence);
    if (rotation) w.float(rotation);
    for (const [k, def] of [['x', 0], ['y', 0], ['scaleX', 1], ['scaleY', 1], ['width', 0], ['height', 0]]) w.float(a[k] ?? def);
    return;
  }
  const count = a.uvs.length / 2;
  const weighted = a.vertices.length > a.uvs.length;
  if (a.triangles.length !== 3 * (2 * count - a.hull - 2)) {
    throw new Unsupported(`Meshes whose triangle count is not 2 x vertices - hull - 2 ('${key}')`);
  }
  w.byte((weighted ? FLAG_WEIGHTED : 0) | (named ? FLAG_NAME : 0) | (a.path !== undefined ? FLAG_PATH : 0) | (a.color !== undefined ? FLAG_COLOR : 0) | (a.sequence ? FLAG_SEQUENCE : 0) | ATTACHMENT_MESH);
  if (named) w.ref(a.name);
  if (a.path !== undefined) w.ref(a.path);
  if (a.color !== undefined) w.color(a.color);
  if (a.sequence) writeSequence(w, a.sequence);
  w.varint(a.hull);
  w.varint(count);
  if (weighted) {
    let hint = 0;
    for (let i = 0; i < a.vertices.length; ) {
      const n = a.vertices[i];
      hint += 1 + n;
      i += 1 + n * 4;
    }
    w.varint(hint);
    for (let i = 0; i < a.vertices.length; ) {
      const n = a.vertices[i++];
      w.varint(n);
      for (let k = 0; k < n; k++) {
        w.varint(a.vertices[i++]);
        w.float(a.vertices[i++]);
        w.float(a.vertices[i++]);
        w.float(a.vertices[i++]);
      }
    }
  } else {
    for (const v of a.vertices) w.float(v);
  }
  for (const v of a.uvs) w.float(v);
  for (const t of a.triangles) w.varint(t);
  w.varint(a._timelineSlots?.length ?? 0);
  for (const i of a._timelineSlots ?? []) w.varint(i);
  const edges = a.edges ?? [];
  w.varint(edges.length);
  for (const e of edges) w.varint(e);
  w.float(a.width ?? 0);
  w.float(a.height ?? 0);
}

/** Writes keys whose segment curves follow the segment's second key. Returns nothing. */
function writeCurveKeys(w, keys, values) {
  keys.forEach((k, f) => {
    w.float(k.time ?? 0);
    for (const v of values(k)) w.float(v);
    if (f > 0) {
      const c = keys[f - 1].curve;
      if (c === 'stepped') w.byte(CURVE_STEPPED);
      else if (Array.isArray(c)) {
        w.byte(CURVE_BEZIER);
        for (const v of c) w.float(v);
      } else w.byte(CURVE_LINEAR);
    }
  });
}

function writeSegmentCurve(w, c) {
  if (c === 'stepped') w.byte(CURVE_STEPPED);
  else if (Array.isArray(c)) {
    w.byte(CURVE_BEZIER);
    for (const v of c) w.float(v);
  } else w.byte(CURVE_LINEAR);
}

function bezierCount(keys, n) {
  let count = 0;
  for (let f = 0; f + 1 < keys.length; f++) if (Array.isArray(keys[f].curve)) count += n;
  return count;
}

function writeAnimation(w, anim, { boneIndex, slotIndex, constraintIndex, skinIndex, transformMapped, eventNames, events }) {
  if (anim.deform && Object.keys(anim.deform).length) throw new Unsupported(`'deform' animation keys`);
  const slots = Object.entries(anim.slots ?? {});
  const bones = Object.entries(anim.bones ?? {});
  const ik = Object.entries(anim.ik ?? {});
  const transform = Object.entries(anim.transform ?? {});
  const deform = [];
  for (const [skin, slots] of Object.entries(anim.attachments ?? {})) {
    for (const [slot, atts] of Object.entries(slots)) {
      for (const [attachment, timelines] of Object.entries(atts)) {
        for (const [kind, keys] of Object.entries(timelines)) {
          if (kind !== 'deform' && kind !== 'sequence') throw new Unsupported(`'${kind}' attachment keys`);
          deform.push({ skin, slot, attachment, kind, keys });
        }
      }
    }
  }
  let total = ik.length + transform.length + deform.length + (anim.drawOrder?.length ? 1 : 0) + (anim.events?.length ? 1 : 0) + (anim._drawOrderFolders?.length ?? 0);
  for (const [, t] of slots) total += Object.keys(t).length;
  for (const [, t] of bones) total += Object.keys(t).length;
  for (const group of [anim.path, anim.physics, anim.slider]) for (const t of Object.values(group ?? {})) total += Object.keys(t).length;
  w.varint(total);

  w.varint(slots.length);
  for (const [slot, timelines] of slots) {
    w.varint(slotIndex.get(slot));
    const kinds = Object.entries(timelines);
    w.varint(kinds.length);
    for (const [kind, keys] of kinds) {
      if (kind === 'attachment') {
        w.byte(SLOT_ATTACHMENT);
        w.varint(keys.length);
        for (const k of keys) {
          w.float(k.time ?? 0);
          w.ref(k.name ?? null);
        }
      } else if (kind === 'rgb' || kind === 'rgb2' || kind === 'alpha') {
        const count = kind === 'rgb' ? 3 : kind === 'rgb2' ? 6 : 1;
        w.byte(kind === 'rgb' ? 2 : kind === 'rgb2' ? 4 : 5);
        w.varint(keys.length);
        w.varint(bezierCount(keys, count));
        keys.forEach((k, f) => {
          w.float(k.time ?? 0);
          if (kind === 'rgb') w.color3(k.color);
          else if (kind === 'rgb2') { w.color3(k.light); w.color3(k.dark); }
          else w.byte(Math.round((k.value ?? 1) * 255));
          if (f > 0) writeSegmentCurve(w, keys[f - 1].curve);
        });
      } else if (kind === 'rgba') {
        w.byte(SLOT_RGBA);
        w.varint(keys.length);
        w.varint(bezierCount(keys, 4));
        keys.forEach((k, f) => {
          w.float(k.time ?? 0);
          w.color(k.color);
          if (f > 0) {
            const c = keys[f - 1].curve;
            if (c === 'stepped') w.byte(CURVE_STEPPED);
            else if (Array.isArray(c)) {
              w.byte(CURVE_BEZIER);
              for (const v of c) w.float(v);
            } else w.byte(CURVE_LINEAR);
          }
        });
      } else if (kind === 'rgba2') {
        w.byte(SLOT_RGBA2);
        w.varint(keys.length);
        w.varint(bezierCount(keys, 7));
        keys.forEach((k, f) => {
          w.float(k.time ?? 0);
          w.color(k.light);
          w.color3(k.dark);
          if (f > 0) writeSegmentCurve(w, keys[f - 1].curve);
        });
      } else {
        throw new Unsupported(`'${kind}' slot keys`);
      }
    }
  }

  w.varint(bones.length);
  for (const [bone, timelines] of bones) {
    w.varint(boneIndex.get(bone));
    const kinds = Object.entries(timelines);
    w.varint(kinds.length);
    for (const [kind, keys] of kinds) {
      if (kind === 'inherit') {
        w.byte(BONE_INHERIT_42);
        w.varint(keys.length);
        for (const k of keys) { w.float(k.time ?? 0); w.byte(Math.max(0, INHERIT.indexOf(k.inherit ?? 'normal'))); }
        continue;
      }
      const type = BONE_TIMELINES.findIndex(([k]) => k === kind);
      if (type < 0) throw new Unsupported(`'${kind}' bone keys`);
      const n = BONE_TIMELINES[type][1];
      const def = kind.startsWith('scale') ? 1 : 0;
      w.byte(type);
      w.varint(keys.length);
      w.varint(bezierCount(keys, n));
      writeCurveKeys(w, keys, (k) => (n === 1 ? [k.value ?? k.angle ?? def] : [k.x ?? def, k.y ?? def]));
    }
  }

  w.varint(ik.length);
  for (const [name, keys] of ik) {
    w.varint(constraintIndex.get(`ik:${name}`));
    w.varint(keys.length);
    w.varint(bezierCount(keys, 2));
    keys.forEach((k, f) => {
      const curve = f > 0 && Array.isArray(keys[f - 1].curve) ? keys[f - 1].curve : null;
      const stepped = f > 0 && keys[f - 1].curve === 'stepped';
      const mix = k.mix ?? 1;
      let flags = 0;
      if (mix !== 0) flags |= 0x01;
      if (mix !== 1) flags |= 0x02;
      if (k.softness) flags |= 0x04;
      if (k.bendPositive !== false) flags |= 0x08;
      if (k.compress) flags |= 0x10;
      if (k.stretch) flags |= 0x20;
      if (curve) flags |= IK_KEY_BEZIER;
      if (stepped) flags |= IK_KEY_STEPPED;
      w.byte(flags);
      w.float(k.time ?? 0);
      if ((flags & 0x03) === 0x03) w.float(mix);
      if (flags & 0x04) w.float(k.softness);
      if (curve) for (const v of curve) w.float(v);
    });
  }

  w.varint(transform.length);
  for (const [name, keys] of transform) {
    const index = constraintIndex.get(`transform:${name}`);
    if (index === undefined) throw new Error(`unknown transform constraint '${name}'`);
    w.varint(index);
    w.varint(keys.length);
    w.varint(bezierCount(keys, TRANSFORM_KEY_MIXES.length));
    const mapped = transformMapped.get(name) ?? new Set(TRANSFORM_PROPERTIES);
    keys.forEach((k, f) => {
      w.float(k.time ?? 0);
      for (const [mix, property] of TRANSFORM_MIXES) w.float(mapped.has(property) ? (k[mix] ?? 1) : 0);
      if (f > 0) writeSegmentCurve(w, keys[f - 1].curve);
    });
  }
  for (let s = 0; s < UNKNOWN_ANIMATION_SECTIONS; s++) {
    if (s === ANIMATION_SECTION_PATH) {
      const paths = Object.entries(anim.path ?? {});
      w.varint(paths.length);
      for (const [name, timelines] of paths) {
        const index = constraintIndex.get(`path:${name}`);
        if (index === undefined) throw new Error(`unknown path constraint '${name}'`);
        w.varint(index);
        const kinds = Object.entries(timelines);
        w.varint(kinds.length);
        for (const [kind, keys] of kinds) {
          const code = PATH_KEY_CODES[kind];
          if (code === undefined) throw new Unsupported(`Path constraint '${kind}' keys`);
          w.byte(code);
          w.varint(keys.length);
          w.varint(bezierCount(keys, kind === 'mix' ? 3 : 1));
          writeCurveKeys(w, keys, (k) => kind === 'mix' ? [k.mixRotate ?? 1, k.mixX ?? 1, k.mixY ?? 1] : [k.value ?? 0]);
        }
      }
      continue;
    }
    if (s === ANIMATION_SECTION_SLIDER) {
      const sliders = Object.entries(anim.slider ?? {});
      w.varint(sliders.length);
      for (const [name, timelines] of sliders) {
        const index = constraintIndex.get(`slider:${name}`);
        if (index === undefined) throw new Error(`unknown slider constraint '${name}'`);
        w.varint(index);
        const kinds = Object.entries(timelines);
        w.varint(kinds.length);
        for (const [kind, keys] of kinds) {
          const code = SLIDER_KEY_CODES[kind];
          if (code === undefined) throw new Unsupported(`Slider '${kind}' keys`);
          const def = SLIDER_KEY_TYPES[code][1];
          w.byte(code);
          w.varint(keys.length);
          w.varint(bezierCount(keys, 1));
          writeCurveKeys(w, keys, (k) => [k.value ?? def]);
        }
      }
      continue;
    }
    if (s !== ANIMATION_SECTION_PHYSICS) {
      w.varint(0);
      continue;
    }
    const physics = Object.entries(anim.physics ?? {});
    w.varint(physics.length);
    for (const [name, timelines] of physics) {
      const index = name === '' ? -1 : constraintIndex.get(`physics:${name}`);
      if (index === undefined) throw new Error(`unknown physics constraint '${name}'`);
      w.varint(index + 1);
      const kinds = Object.entries(timelines);
      w.varint(kinds.length);
      for (const [kind, keys] of kinds) {
        const code = PHYSICS_KEY_CODES[kind];
        if (code === undefined) throw new Unsupported(`Physics '${kind}' keys`);
        w.byte(code);
        w.varint(keys.length);
        if (kind === 'reset') { for (const k of keys) w.float(k.time ?? 0); continue; }
        w.varint(bezierCount(keys, 1));
        writeCurveKeys(w, keys, (k) => [k.value ?? 0]);
      }
    }
  }
  // Deform and sequence keys grouped by skin, then slot.
  const bySkin = new Map();
  for (const d of deform) {
    if (!bySkin.has(d.skin)) bySkin.set(d.skin, new Map());
    const slots = bySkin.get(d.skin);
    if (!slots.has(d.slot)) slots.set(d.slot, []);
    slots.get(d.slot).push(d);
  }
  w.varint(bySkin.size);
  for (const [skin, slots] of bySkin) {
    const index = skinIndex.get(skin);
    if (index === undefined) throw new Error(`unknown skin '${skin}'`);
    w.varint(index);
    w.varint(slots.size);
    for (const [slot, list] of slots) {
      w.varint(slotIndex.get(slot));
      w.varint(list.length);
      for (const d of list) {
        w.ref(d.attachment);
        if (d.kind === 'sequence') {
          w.byte(ATTACHMENT_SEQUENCE);
          w.varint(d.keys.length);
          writeSequenceKeys(w, d.keys);
          continue;
        }
        w.byte(ATTACHMENT_DEFORM);
        w.varint(d.keys.length);
        w.varint(bezierCount(d.keys, 1));
        d.keys.forEach((k, f) => {
          w.float(k.time ?? 0);
          if (f > 0) writeSegmentCurve(w, d.keys[f - 1].curve);
          const values = k.vertices ?? [];
          w.varint(values.length);
          if (values.length) {
            w.varint(k.offset ?? 0);
            for (const v of values) w.float(v);
          }
        });
      }
    }
  }

  const draw = anim.drawOrder ?? anim.draworder ?? [];
  w.varint(draw.length);
  for (const k of draw) {
    w.float(k.time ?? 0);
    const offsets = k.offsets ?? [];
    w.varint(offsets.length);
    for (const o of offsets) {
      w.varint(slotIndex.get(o.slot));
      w.varint(o.offset >>> 0);
    }
  }
  w.varint(anim._drawOrderFolders?.length ?? 0);
  for (const folder of anim._drawOrderFolders ?? []) {
    w.varint(folder.slots.length);
    for (const slot of folder.slots) w.varint(slot);
    w.varint(folder.keys.length);
    for (const key of folder.keys) {
      w.float(key.time ?? 0); w.varint(key.offsets.length);
      for (const offset of key.offsets) { w.varint(offset.slot); w.varint(offset.offset >>> 0); }
    }
  }

  const keys = anim.events ?? [];
  w.varint(keys.length);
  for (const k of keys) {
    const def = events[k.name] ?? {};
    w.float(k.time ?? 0);
    w.varint(eventNames.indexOf(k.name));
    w.varint(k.int ?? def.int ?? 0, false);
    w.float(k.float ?? def.float ?? 0);
    w.bool(k.string !== undefined);
    if (k.string !== undefined) w.string(k.string);
    if (def.audio) {
      w.float(k.volume ?? def.volume ?? 1);
      w.float(k.balance ?? def.balance ?? 0);
    }
  }
  w.color(anim._color ?? 'ffffffff');
}
