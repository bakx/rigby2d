// SPDX-License-Identifier: MIT OR Apache-2.0
// Deterministic simulation and animation diagnostics shared by headless tools.
import { animOf, constraintOf, keyConstraint, number } from './authoring.js';
import { listConstraints } from './constraintdata.js';
import { compileConstraints } from './constraints.js';
import { setKey } from './animation.js';
import { poseAt, channelValue } from './keying.js';
import { Pose } from './pose.js';
import { AnimationState } from './state.js';
import { wrapDegrees } from './math.js';

export function sampleTimes(duration, fps = 30) {
  number(fps, 'fps', 1, 240);
  const count = Math.max(1, Math.ceil(duration * fps));
  if (count > 10000) throw new Error('More than 10000 frames requested; lower fps or shorten the animation.');
  return Array.from({ length: count }, (_, i) => Math.min(duration, i / fps));
}

/** Visit monotonic times, integrating physics in steps of at most 1/60 s. A looping clip
 * first plays one full period so the first captured frame includes follow-through. */
export function simulate(doc, animation, times, { loop = false } = {}, visit) {
  const anim = animOf(doc, animation);
  if (!times.length || times.length > 10000) throw new Error('Provide 1..10000 sample times.');
  for (let i = 0; i < times.length; i++) {
    number(times[i], 'time', 0, anim.duration);
    if (i && times[i] < times[i - 1]) throw new Error('Sample times must be in ascending order.');
  }
  if (anim.duration > 3600) throw new Error('Simulation is limited to one hour per clip.');
  const state = new AnimationState(), pose = new Pose(doc);
  state.setAnimation(doc, 0, animation, loop, 0);
  state.apply(doc, pose);
  let elapsed = 0;
  const preroll = loop ? anim.duration : 0;
  for (const [i, time] of times.entries()) {
    const target = preroll + time;
    while (target - elapsed > 1e-9) {
      const dt = Math.min(1 / 60, target - elapsed);
      state.update(doc, dt); state.apply(doc, pose); elapsed += dt;
    }
    visit(pose, i, time);
  }
}

export function bakePhysics(doc, { animation, constraints, fps = 30, loop = false, disable = true }) {
  const anim = animOf(doc, animation);
  const all = listConstraints(doc).filter((c) => c.type === 'physics');
  const selected = constraints ? constraints.map((n) => constraintOf(doc, n)) : all;
  if (!selected.length || selected.some((c) => c.type !== 'physics')) throw new Error('Select at least one physics constraint.');
  const bones = new Set(selected.map((c) => doc.boneIndex(c.data.bone)));
  // Two independently mixed constraints on one bone cannot be disabled independently after baking.
  if (all.some((c) => bones.has(doc.boneIndex(c.data.bone)) && !selected.some((s) => s.name === c.name))) throw new Error('Bake all physics constraints on each selected bone together.');
  const conflict = compileConstraints(doc).find((c) => c.type !== 'physics' && c.bones.some((b) => bones.has(b)));
  if (conflict || doc.ik.some((c) => c.bones.some((b) => bones.has(b)))) throw new Error('A baked bone also has IK, transform, path or slider constraints; bake an unconstrained physics chain first.');
  const times = sampleTimes(anim.duration, fps);
  if (anim.duration > 0) times.push(anim.duration);
  const samples = [];
  simulate(doc, animation, times, { loop }, (pose) => samples.push(new Map([...bones].map((b) => [b, { ...pose.applied[b] }]))));
  if (loop && samples.length > 1) samples[samples.length - 1] = samples[0];
  for (const b of bones) {
    const tl = anim.boneTimelineMut(b);
    // Separate-axis tracks would override the new combined tracks.
    for (const ch of ['translateX', 'translateY', 'scaleX', 'scaleY', 'shearX', 'shearY']) tl[ch] = [];
    for (const ch of ['rotate', 'translate', 'scale', 'shear']) {
      tl[ch] = [];
      let previous;
      samples.forEach((s, i) => {
        let value = channelValue(ch, s.get(b), doc.bones[b].setup);
        if (ch === 'rotate' && previous !== undefined) value = previous + wrapDegrees(value - previous);
        if (ch === 'rotate') previous = value;
        setKey(tl[ch], times[i], value);
      });
    }
  }
  if (disable) for (const c of selected) {
    const track = anim.extra.physics?.[c.name];
    if (track) delete track.mix;
    keyConstraint(doc, { animation, constraint: c.name, time: 0, values: { mix: 0 } });
  }
  return { animation, constraints: selected.map((c) => c.name), bones: [...bones].map((b) => doc.bones[b].name), frames: times.length, fps, disabled: disable };
}

export function lintAnimations(doc, { animation, loop, fps = 30, jump_threshold = 100, rotation_threshold = 90 } = {}) {
  const warnings = [];
  const animations = animation ? [animOf(doc, animation)] : doc.animations;
  const warn = (code, a, detail) => warnings.push({ code, animation: a.name, ...detail });
  number(jump_threshold, 'jump_threshold', 0); number(rotation_threshold, 'rotation_threshold', 0);
  for (const anim of animations) {
    const shouldLoop = loop ?? /(^|[ _-])(idle|breathe|breathing|walk|run|loop)([ _-]|$)/i.test(anim.name);
    const times = sampleTimes(anim.duration, fps);
    if (anim.duration > 0) times.push(anim.duration);
    const start = poseAt(doc, anim, 0), end = poseAt(doc, anim, anim.duration);
    if (shouldLoop && anim.duration > 0) {
      for (const tl of anim.bones) for (const ch of ['rotate', 'translate', 'scale', 'shear']) {
        if (!tl[ch]?.length && !tl[`${ch}X`]?.length && !tl[`${ch}Y`]?.length) continue;
        const a = channelValue(ch, start.local[tl.bone], doc.bones[tl.bone].setup), b = channelValue(ch, end.local[tl.bone], doc.bones[tl.bone].setup);
        const delta = ch === 'rotate' ? Math.abs(wrapDegrees(b - a)) : Math.max(...a.map((v, i) => Math.abs(v - b[i])));
        if (delta > 1e-3) warn('loop_seam', anim, { bone: doc.bones[tl.bone].name, channel: ch, difference: delta });
      }
      for (const tl of anim.slots) if (start.slotAttachment(doc, tl.slot)?.name !== end.slotAttachment(doc, tl.slot)?.name) warn('loop_attachment', anim, { slot: doc.slots[tl.slot].name });
    }
    for (const tl of anim.slots) for (const key of tl.attachment ?? []) {
      if (key.value === null) warn('hidden_slot', anim, { slot: doc.slots[tl.slot].name, time: key.time, message: 'Attachment key hides this slot; verify that this is intentional.' });
      else if (!doc.slots[tl.slot].attachments.some((a) => a.name === key.value) && !doc.skins.some((s) => s.slots.some((e) => e.slot === tl.slot && e.attachments.some((a) => a.name === key.value)))) warn('missing_attachment', anim, { slot: doc.slots[tl.slot].name, attachment: key.value, time: key.time });
    }
    const sampled = times.map((t) => poseAt(doc, anim, t));
    for (const [ci, c] of doc.ik.entries()) {
      const overridden = anim.bones.filter((tl) => c.bones.includes(tl.bone) && tl.rotate?.length);
      const fullMix = sampled.every((p) => p.ik[ci].mix >= 1);
      if (fullMix) for (const tl of overridden) warn('overridden_keys', anim, { constraint: c.name, bone: doc.bones[tl.bone].name, channel: 'rotate' });
      const target = doc.bones[c.target];
      const targetKeys = anim.boneTimeline(c.target);
      if (c.mix > 0 && target.parent === 0 && !['translate', 'translateX', 'translateY'].some((ch) => targetKeys?.[ch]?.length)) {
        for (let b = doc.bones[c.bones[0]].parent; b !== null && b !== 0; b = doc.bones[b].parent) {
          const tl = anim.boneTimeline(b);
          if (['translate', 'translateX', 'translateY'].some((ch) => tl?.[ch]?.some((k) => JSON.stringify(k.value) !== JSON.stringify(tl[ch][0].value)))) {
            warn('pinned_ik_target', anim, { constraint: c.name, target: target.name, movingAncestor: doc.bones[b].name }); break;
          }
        }
      }
    }
    const compiled = compileConstraints(doc);
    for (const [ci, c] of compiled.entries()) {
      if (c.type !== 'transform') continue;
      for (const [channel, fields] of [['rotate', ['rotate']], ['translate', ['x', 'y']], ['scale', ['scaleX', 'scaleY']], ['shear', ['shearY']]]) {
        if (!sampled.every((p) => fields.every((f) => p.constraintState[ci]?.mix?.[f] === 1))) continue;
        for (const tl of anim.bones) if (c.bones.includes(tl.bone) && tl[channel]?.length) warn('overridden_keys', anim, { constraint: c.name, bone: doc.bones[tl.bone].name, channel });
      }
    }
    let prev = null;
    const reported = new Set();
    for (const [i, time] of times.entries()) {
      const pose = sampled[i];
      if (prev) for (let b = 0; b < doc.bones.length; b++) {
        const w = pose.world[b], old = prev.world[b];
        const distance = Math.hypot(w.tx - old.tx, w.ty - old.ty), rotation = Math.abs(wrapDegrees(w.rotation() - old.rotation()));
        if ((distance > jump_threshold || rotation > rotation_threshold) && !reported.has(b)) { warn('frame_jump', anim, { bone: doc.bones[b].name, time, distance, rotation }); reported.add(b); }
      }
      prev = pose;
    }
  }
  return warnings;
}
