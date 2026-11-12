// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { writePsd } from 'ag-psd';
import { Skeleton, makeBone, makeSlot, makeAttachment } from '../src/core/model.js';
import { Animation, setKey } from '../src/core/animation.js';
import { transform } from '../src/core/math.js';
import { Pose } from '../src/core/pose.js';
import { poseAt } from '../src/core/keying.js';
import { simulate, bakePhysics, lintAnimations } from '../src/core/automation.js';
import * as author from '../src/core/authoring.js';
import { readSkeletonJson, writeSkeletonJson } from '../src/core/interop.js';
import { createEditTools, save } from '../src/mcp/edits.js';
import { createTools, Workspace, loadProject } from '../src/mcp/tools.js';
import { createFilmTools } from '../src/mcp/film.js';
import { createRiggingTools } from '../src/mcp/rigging.js';
import { createScriptTools } from '../src/mcp/scripting.js';
import { checkArguments } from '../src/mcp/protocol.js';
import { encodePng, decodePng } from '../src/mcp/png.js';

function rig() {
  const d = new Skeleton();
  d.bones.push(makeBone('chest', 0, transform(3, 5, 25), 10));
  d.bones.push(makeBone('upperarm_l', 1, transform(4, 1, -30), 15));
  d.bones.push(makeBone('forearm_l', 2, transform(15, 0, -20), 12));
  d.bones.push(makeBone('hand_target', 0, transform(25, 10), 0));
  d.bones.push(makeBone('hair_l1', 1, transform(0, 10, 90), 8));
  d.bones.push(makeBone('hair_l2', 5, transform(8, 0), 6));
  d.images.push({ name: 'arm', path: null, width: 32, height: 12 });
  d.slots.push(makeSlot('arm', 2, makeAttachment('arm', 'arm', transform(8, 0), 32, 12)));
  d.animations.push(new Animation('wave', 1));
  return d;
}
const rgba = (color = [220, 80, 30, 255], width = 32, height = 12) => ({ width, height, data: new Uint8Array(Array.from({ length: width * height }, () => color).flat()) });
async function setup(t, doc = rig()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-automation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ws = await Workspace.open([dir]);
  const entries = new Map([['images/arm.png', encodePng(rgba())]]);
  await save(ws, { doc, entries, file: path.join(dir, 'a.rigby'), format: 'rigby' }, {});
  const table = [...createTools(ws), ...createEditTools(ws), ...createFilmTools(ws), ...createRiggingTools(ws), ...createScriptTools(ws)];
  const tools = Object.fromEntries(table.map((t) => [t.name, (args) => t.handler({ path: 'a.rigby', ...args })]));
  return { dir, ws, tools, table, read: async () => (await loadProject(path.join(dir, 'a.rigby'))).doc };
}
const close = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);

test('constraints: atomic batch creates physics, keys IK, renames references, edits slots and saves a pose', async (t) => {
  const { tools, read, dir } = await setup(t);
  const result = await tools.batch_edit({ operations: [
    { op: 'add_constraint', type: 'ik', name: 'arm_ik', bones: ['upperarm_l', 'forearm_l'], target: 'hand_target' },
    { op: 'set_constraint', name: 'arm_ik', settings: { bendPositive: false } },
    { op: 'set_constraint_key', animation: 'wave', constraint: 'arm_ik', time: 0, values: { mix: 0 } },
    { op: 'add_constraint', type: 'physics', name: 'hair', bones: ['hair_l1', 'hair_l2'], settings: { rotate: 1, damping: 0.7, gravityGlobal: true } },
    { op: 'rename_bone', bone: 'hair_l1', name: 'fringe' },
    { op: 'set_slot', slot: 'arm', color: '#aabbcc' },
    { op: 'save_pose', name: 'rest' },
  ] });
  assert.equal(result.applied, 7);
  const d = await read();
  assert.equal(d.ik[0].bendPositive, false);
  assert.equal(poseAt(d, d.animations[0], 0.5).ik[0].mix, 0);
  const info = await tools.describe_rig({});
  assert.equal(info.constraints.find((c) => c.name === 'hair').bones[0], 'fringe');
  assert.equal(info.constraints.find((c) => c.name === 'hair').settings.damping, 0.7);
  const before = await fs.readFile(path.join(dir, 'a.rigby'));
  await assert.rejects(tools.batch_edit({ operations: [{ op: 'add_skin', name: 'temporary' }, { op: 'set_constraint', name: 'hair', settings: { unknown: 1 } }] }), /Operation 2/);
  assert.deepEqual(await fs.readFile(path.join(dir, 'a.rigby')), before);
  await tools.delete_constraint({ name: 'arm_ik' });
  assert.equal((await read()).animations[0].ik.length, 0);
});

test('all constraint families expose keys and preserve eased values through JSON export', () => {
  const d = rig();
  author.createConstraint(d, { type: 'transform', name: 'copy', bones: ['hair_l1'], target: 'hand_target', settings: { mixX: 0, mixY: 0 } });
  author.createConstraint(d, { type: 'path', name: 'path', bones: ['hair_l2'], target: 'arm' });
  author.createConstraint(d, { type: 'slider', name: 'face', bones: [], settings: { animation: 'wave' } });
  author.createConstraint(d, { type: 'physics', name: 'spring', bones: ['hair_l1'], settings: { rotate: 1 } });
  for (const [name, values] of [['copy', { mixRotate: 0 }], ['path', { position: 0, spacing: 2 }], ['face', { time: 0, mix: 0 }], ['spring', { damping: 0.2, mix: 0 }]]) {
    author.keyConstraint(d, { animation: 'wave', constraint: name, time: 0, values, curve: 'easeIn' });
    author.keyConstraint(d, { animation: 'wave', constraint: name, time: 1, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v + 0.5])) });
  }
  const exported = writeSkeletonJson(d, { version: '4.3' }).json;
  assert.ok(Array.isArray(exported.animations.wave.physics.spring.mix[0].curve));
  const back = readSkeletonJson(exported).skeleton;
  const originalPose = poseAt(d, d.animations[0], 0.4), copiedPose = poseAt(back, back.animations[0], 0.4);
  originalPose.world.forEach((w, i) => { close(w.tx, copiedPose.world[i].tx, 0.01); close(w.ty, copiedPose.world[i].ty, 0.01); });
});

test('world-space translation and rotation handle rotated, scaled and reflected parents', async (t) => {
  const d = rig(); d.bones[1].setup.scale_x = -1.5; d.bones[1].setup.scale_y = 0.8;
  const { tools, read } = await setup(t, d);
  await tools.set_bone_key({ animation: 'wave', bone: 'upperarm_l', channel: 'translate', time: 0.5, x: 42, y: 25, space: 'world' });
  await tools.set_bone_key({ animation: 'wave', bone: 'upperarm_l', channel: 'rotate', time: 0.5, value: 65, space: 'world' });
  const doc = await read(), pose = poseAt(doc, doc.animations[0], 0.5), w = pose.world[2];
  close(w.tx, 42); close(w.ty, 25); close(w.rotation(), 65);
  const local = await tools.world_to_local({ bone: 'upperarm_l', animation: 'wave', time: 0.5, point: [42, 25] });
  close(local.point[0], 0); close(local.point[1], 0);
  await tools.add_constraint({ type: 'ik', name: 'arm_ik', bones: ['upperarm_l', 'forearm_l'], target: 'hand_target' });
  await tools.set_ik_target_key({ animation: 'wave', constraint: 'arm_ik', time: 0.5, world_point: [18, 32] });
  const sampled = await tools.sample_pose({ animation: 'wave', time: 0.5 });
  assert.deepEqual([sampled.bones[4].x, sampled.bones[4].y], [18, 32]);
});

test('attachments, skins and mesh weights edit and render in one batch', async (t) => {
  const { tools, read, dir } = await setup(t);
  await fs.writeFile(path.join(dir, 'blue.png'), encodePng(rgba([20, 40, 230, 255])));
  await tools.batch_edit({ operations: [
    { op: 'add_skin', name: 'outfit' },
    { op: 'set_skin_attachment', skin: 'outfit', slot: 'arm', attachment: 'arm', image_file: 'blue.png' },
    { op: 'add_attachment', slot: 'arm', name: 'hand', image_file: 'blue.png', x: 4 },
    { op: 'make_mesh', slot: 'arm', attachment: 'arm', mode: 'grid', spacing: 5 },
    { op: 'auto_weight', slot: 'arm', attachment: 'arm', bones: ['upperarm_l', 'forearm_l'] },
    { op: 'set_weights', slot: 'arm', attachment: 'arm', vertices: [0], weights: [[{ bone: 'forearm_l', weight: 2 }]] },
    { op: 'smooth_weights', slot: 'arm', attachment: 'arm', iterations: 2 },
  ] });
  const d = await read(), att = d.slots[0].attachments[0];
  assert.equal(att.type, 'mesh'); assert.ok(att.weights.length > 4);
  for (const list of att.weights) close(list.reduce((s, w) => s + w.weight, 0), 1);
  for (const skin of ['default', 'outfit']) await tools.render_preview({ animation: 'wave', times: [0], skin, output: `${skin}.png` });
  assert.notDeepEqual(await fs.readFile(path.join(dir, 'default.png')), await fs.readFile(path.join(dir, 'outfit.png')));
  await tools.delete_skin({ name: 'outfit' }); assert.equal((await read()).skins.length, 0);
});

test('previews produce a single labeled PNG and GIF; video encodes frames', async (t) => {
  const { tools, dir } = await setup(t);
  const r = await tools.render_preview({ animation: 'wave', fps: 3, output: 'preview.png', layout: 'strip', labels: true, overlays: ['bones', 'pivots'] });
  const png = decodePng(await fs.readFile(path.join(dir, 'preview.png')));
  assert.equal(r.frames, 3); assert.equal(png.width, r.width); assert.equal(png.height, r.height);
  await tools.render_preview({ animation: 'wave', fps: 3, output: 'preview.gif', layout: 'gif' });
  assert.equal((await fs.readFile(path.join(dir, 'preview.gif'))).subarray(0, 6).toString(), 'GIF89a');
  await assert.rejects(tools.render_preview({ animation: 'wave', fps: 3, output: 'preview.png' }), /already exists/);
  let ffmpeg = true; try { execFileSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' }); } catch { ffmpeg = false; }
  if (ffmpeg) for (const ext of ['mp4', 'webm']) {
    const video = await tools.render_video({ animation: 'wave', fps: 3, size: [96, 64], output: `clip.${ext}` });
    assert.equal(video.frames, 3); assert.ok((await fs.stat(path.join(dir, `clip.${ext}`))).size > 100);
  }
});

test('physics baking reproduces the simulated bone world matrices without runtime physics', () => {
  const doc = rig();
  author.createConstraint(doc, { type: 'physics', name: 'hair', bones: ['hair_l1', 'hair_l2'], settings: { rotate: 1, x: 0.5, inertia: 0.7 } });
  const a = doc.animations[0];
  setKey(a.boneTimelineMut(1).translate, 0, [0, 0]);
  setKey(a.boneTimelineMut(1).translate, 0.5, [8, 5]);
  setKey(a.boneTimelineMut(1).translate, 1, [0, 0]);
  const times = Array.from({ length: 31 }, (_, i) => i / 30), expected = [];
  simulate(doc, 'wave', times, {}, (p) => expected.push(p.world.map((w) => ({ ...w }))));
  bakePhysics(doc, { animation: 'wave', fps: 30, loop: false });
  times.forEach((time, i) => {
    const p = poseAt(doc, a, time);
    for (const b of [5, 6]) for (const field of ['a', 'b', 'c', 'd', 'tx', 'ty']) close(p.world[b][field], expected[i][b][field], 0.001);
  });
});

test('animation lint reports loop seams, hidden slots, pinned targets and ineffective keys', () => {
  const d = rig(), a = d.animations[0];
  a.name = 'idle';
  author.createConstraint(d, { type: 'ik', name: 'ik', bones: ['upperarm_l', 'forearm_l'], target: 'hand_target' });
  setKey(a.boneTimelineMut(1).translate, 0, [0, 0]); setKey(a.boneTimelineMut(1).translate, 1, [200, 0], 'stepped');
  setKey(a.boneTimelineMut(2).rotate, 0, 0); setKey(a.boneTimelineMut(2).rotate, 1, 25);
  setKey(a.slotTimelineMut(0).attachment, 0.5, null);
  const codes = new Set(lintAnimations(d, { jump_threshold: 1 }).map((w) => w.code));
  for (const c of ['loop_seam', 'hidden_slot', 'pinned_ik_target', 'overridden_keys', 'frame_jump']) assert.ok(codes.has(c), c);
});

test('mirroring a nested three-bone chain reflects world matrices and duplicates skin art', () => {
  const d = rig();
  d.bones.push(makeBone('hand_l', 3, transform(12, 0, 20), 5));
  author.addSkin(d, { name: 'outfit' }); author.setSkinAttachment(d, { skin: 'outfit', slot: 'arm', attachment: 'arm' });
  const before = new Pose(d);
  const result = author.mirrorBones(d, { bones: ['upperarm_l'], duplicate: true });
  const after = new Pose(d);
  for (const name of ['upperarm_l', 'forearm_l', 'hand_l']) {
    const i = d.boneIndex(name), j = d.boneIndex(`${name}_mirror`), a = before.world[i], b = after.world[j];
    close(b.tx, -a.tx); close(b.ty, a.ty); close(b.a, -a.a); close(b.b, a.b); close(b.c, -a.c); close(b.d, a.d);
  }
  assert.equal(result.bones.length, 3); assert.equal(d.slots.length, 2); assert.equal(d.skins[0].slots.length, 2);
});

test('nested schema validation rejects nonfinite weights, bad dimensions and unknown operation arguments', () => {
  const schema = { properties: { size: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1, maximum: 8192 } } } };
  assert.equal(checkArguments(schema, { size: [96, 64] }).length, 0);
  assert.ok(checkArguments(schema, { size: [96, 1e9] }).length);
  assert.ok(checkArguments(schema, { size: [96, NaN] }).length);
});

function psd(size = 1, extra = false) {
  const layers = [['Body', 40, 40, 30, 60], ['upperarm_l', 70, 50, 12, 25], ['forearm_l', 72, 75, 10, 25], ['hand_l', 72, 100, 12, 12]];
  if (extra) layers.push(['badge', 45, 50, 6, 6]);
  return new Uint8Array(writePsd({ width: 120, height: 140, children: layers.map(([name, left, top, w, h]) => ({ name, left, top, imageData: rgba([80 * size, 120, 60, 255], Math.round(w * size), h) })) }, { noBackground: true, generateThumbnail: false }));
}

test('PSD joint hints use canvas pixels and re-import preserves clips, constraints and skins', async (t) => {
  const { tools, dir } = await setup(t);
  await fs.writeFile(path.join(dir, 'art.psd'), psd());
  await fs.writeFile(path.join(dir, 'art.joints.json'), JSON.stringify({ shoulder_l: [75, 55], elbow_l: [78, 80], wrist_l: [77, 105] }));
  await tools.autorig({ path: undefined, psd_file: 'art.psd', output: 'hero.rigby' });
  const before = await tools.sample_pose({ path: 'hero.rigby' });
  for (const [bone, expected] of [['upperarm_l', [15, 85]], ['forearm_l', [18, 60]], ['hand_l', [17, 35]]]) {
    const b = before.bones.find((b) => b.name === bone); close(b.x, expected[0], 0.002); close(b.y, expected[1], 0.002);
  }
  await tools.batch_edit({ path: 'hero.rigby', operations: [{ op: 'add_animation', name: 'wave' }, { op: 'set_bone_key', animation: 'wave', bone: 'chest', channel: 'rotate', time: 0, value: 5 }, { op: 'add_skin', name: 'outfit' }] });
  const original = (await loadProject(path.join(dir, 'hero.rigby'))).doc;
  await fs.writeFile(path.join(dir, 'art.psd'), psd(1.2, true));
  const report = await tools.update_art({ path: 'hero.rigby', psd_file: 'art.psd', mode: 'add_missing' });
  assert.deepEqual(report.added, ['badge']);
  const changed = (await loadProject(path.join(dir, 'hero.rigby'))).doc;
  assert.deepEqual(changed.animations.map((a) => a.bones), original.animations.map((a) => a.bones));
  assert.deepEqual(changed.ik, original.ik); assert.deepEqual(changed.skins, original.skins); assert.deepEqual(changed.bones, original.bones);
  assert.equal(changed.slots[0].attachments[0].width, 36);
});

test('Python exposes constraints, skin attachments, weights and event keys through run_script', async (t) => {
  const { tools, read } = await setup(t);
  await tools.run_script({ script: `import rigby
for b in rigby.bones():
    if b.name.startswith('hair_'):
        rigby.add_constraint('physics', b.name + '_physics', [b], rotate=1, damping=0.7)
skin = rigby.add_skin('outfit')
skin.set_attachment('arm', 'arm')
slot = rigby.slot('arm')
slot.add_attachment('alternate', 'arm')
mesh = slot.make_mesh('arm', mode='grid', spacing=8)
mesh.auto_weight(['upperarm_l', 'forearm_l'])
assert len(mesh.weights) > 4
mesh.smooth_weights()
event = rigby.add_event('step', int=2)
anim = rigby.animation('wave')
anim.key_event(event, 0.5)
anim.key_constraint('hair_l1_physics', 0, mix=0)
assert len(rigby.constraints()) == 2
` });
  const d = await read(); assert.equal(d.skins.length, 1); assert.equal(d.events[0].name, 'step'); assert.equal(d.animations[0].events[0].time, 0.5);
});

test('official add-ons swap name pairs, move IK arms and exclude constraint targets from unused bones', async (t) => {
  const { tools, read } = await setup(t);
  await tools.add_constraint({ type: 'ik', name: 'arm_ik', bones: ['upperarm_l', 'forearm_l'], target: 'hand_target' });
  const breath = await fs.readFile(new URL('../addons/breathing_idle/__init__.py', import.meta.url), 'utf8');
  await tools.run_script({ script: `${breath}\nregister()\nrigby._tools['Make a breathing idle']['fn']()\nrigby._tools['Make a breathing idle with weight shift']['fn']()` });
  let d = await read();
  for (const a of d.animations.filter((a) => a.name.startsWith('breathe'))) {
    const keys = a.boneTimeline(4).translate;
    assert.ok(keys.some((k) => Math.hypot(...k.value) > 0));
    close(keys[0].value[0], keys.at(-1).value[0]); close(keys[0].value[1], keys.at(-1).value[1]);
  }
  const report = await fs.readFile(new URL('../addons/rig_report/__init__.py', import.meta.url), 'utf8');
  const r = await tools.run_script({ script: `${report}\nregister()\nrigby._tools['Rig report']['fn']()` });
  assert.ok(!r.output.some((s) => s.includes("Bone 'hand_target' has no children")));
  await tools.add_bone({ name: 'upperarm_r', parent: 'chest', x: -12 });
  const mirror = await fs.readFile(new URL('../addons/mirror_tools/__init__.py', import.meta.url), 'utf8');
  await tools.run_script({ selection: ['upperarm_l', 'upperarm_r'], script: `${mirror}\nregister()\nrigby._tools['Swap left/right in names']['fn']()` });
  d = await read();
  assert.equal(d.bones[2].name, 'upperarm_r');
  assert.equal(d.bones.at(-1).name, 'upperarm_l');
});

test('merge_parts joins two rigid pieces into one mesh weighted across the joint', async (t) => {
  const doc = rig();
  doc.slots.push(makeSlot('lower', 3, makeAttachment('lower', 'arm', transform(6, 0), 32, 12)));
  const { tools, read } = await setup(t, doc);
  const r = await tools.merge_parts({ slots: ['lower', 'arm'], into: 'arm_mesh' });
  assert.deepEqual(r.bones.sort(), ['forearm_l', 'upperarm_l']);
  const d = await read();
  assert.deepEqual(d.slots.map((s) => [s.name, s.attachment]), [['arm', null], ['lower', null], ['arm_mesh', 'arm_mesh']]);
  const att = d.slots[2].attachments[0];
  assert.equal(att.type, 'mesh');
  const forearm = (list) => list.find((w) => w.bone === 3)?.weight ?? 0;
  assert.ok(att.weights.some((l) => forearm(l) > 0.9) && att.weights.some((l) => forearm(l) < 0.1), 'each end follows its own bone');
  assert.ok(att.weights.some((l) => forearm(l) > 0.2 && forearm(l) < 0.8), 'the joint blends');
  await tools.render_preview({ animation: 'wave', times: [0], output: 'merged.png' });
  await assert.rejects(tools.merge_parts({ slots: ['arm_mesh', 'arm'], into: 'x' }), /region/);
});

test('PSD joint layers give AutoRig hints and are not imported as art', async (t) => {
  const { tools, dir } = await setup(t);
  const layers = [['Body', 40, 40, 30, 60], ['upperarm_l', 70, 50, 12, 25], ['forearm_l', 72, 75, 10, 25], ['hand_l', 72, 100, 12, 12], ['@shoulder_l', 74, 54, 2, 2], ['joint:elbow_l', 77, 79, 2, 2]];
  await fs.writeFile(path.join(dir, 'art.psd'), new Uint8Array(writePsd({ width: 120, height: 140, children: layers.map(([name, left, top, w, h]) => ({ name, left, top, imageData: rgba([80, 120, 60, 255], w, h) })) }, { noBackground: true, generateThumbnail: false })));
  await tools.autorig({ path: undefined, psd_file: 'art.psd', output: 'hero.rigby', joints: { wrist_l: [77, 105] } });
  const pose = await tools.sample_pose({ path: 'hero.rigby' });
  for (const [bone, expected] of [['upperarm_l', [15, 85]], ['forearm_l', [18, 60]], ['hand_l', [17, 35]]]) {
    const b = pose.bones.find((b) => b.name === bone); close(b.x, expected[0], 0.002); close(b.y, expected[1], 0.002);
  }
  const d = (await loadProject(path.join(dir, 'hero.rigby'))).doc;
  assert.ok(!d.slots.some((s) => /shoulder|elbow/.test(s.name)));
});
