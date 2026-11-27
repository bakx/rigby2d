import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createConstraint as addC, addPathAttachment, addSlot, keyDrawOrder, moveSlotTo, setSlotBone } from '../src/core/authoring.js';
import { readSkeletonJson, writeSkeletonJson } from '../src/core/interop.js';
import { Pose, applyDrawOrder } from '../src/core/pose.js';

const rig = () => readSkeletonJson({
  skeleton: { spine: '4.3.0' },
  bones: [{ name: 'root' }, { name: 'a', parent: 'root', x: 0, y: 0 }, { name: 'b', parent: 'root', x: 300, y: 0 },
    { name: 'c1', parent: 'root', length: 50 }, { name: 'c2', parent: 'c1', x: 50, length: 50 }, { name: 'c3', parent: 'c2', x: 50, length: 50 }],
  slots: [{ name: 'back', bone: 'root' }, { name: 'front', bone: 'root' }],
  skins: [{ name: 'default', attachments: {} }],
  animations: { clip: {} },
}).skeleton;
const at = (pose, sk, n) => pose.world[sk.bones.findIndex((b) => b.name === n)].apply([0, 0]);

test('add_slot places a slot in draw order and keeps references', () => {
  const sk = rig();
  addSlot(sk, { name: 'mid', bone: 'a', after: 'back' });
  assert.deepEqual(sk.slots.map((s) => s.name), ['back', 'mid', 'front']);
  moveSlotTo(sk, { slot: 'back', after: 'front' });
  assert.deepEqual(sk.slots.map((s) => s.name), ['mid', 'front', 'back']);
  assert.throws(() => addSlot(sk, { name: 'mid', bone: 'a' }));
});

test('draw order keys reproduce the requested order and reset', () => {
  const sk = rig();
  addSlot(sk, { name: 'mid', bone: 'a', after: 'back' });
  keyDrawOrder(sk, { animation: 'clip', time: 0.5, moves: [{ slot: 'back', after: 'front' }, { slot: 'front', before: 'mid' }] });
  keyDrawOrder(sk, { animation: 'clip', time: 1, reset: true });
  const anim = sk.animations[0];
  assert.deepEqual(applyDrawOrder(3, anim.drawOrder[0].value).map((i) => sk.slots[i].name), ['front', 'mid', 'back']);
  const out = writeSkeletonJson(sk, { version: '4.3' }).json;
  assert.ok(out.animations.clip.drawOrder.length === 2);
  const back = readSkeletonJson(out).skeleton;
  assert.equal(back.animations[0].drawOrder.length, 2);
  assert.equal(back.animations[0].drawOrder[1].value, null);
});

test('a weighted path drives a chain and survives a JSON round trip', () => {
  const sk = rig();
  addSlot(sk, { name: 'hose', bone: 'root' });
  const pts = [[-50, 0], [0, 0], [50, 0], [250, 0], [300, 0], [350, 0]];
  const w = pts.map((p) => [{ bone: p[0] < 150 ? 'a' : 'b', weight: 1 }]);
  const r = addPathAttachment(sk, { slot: 'hose', name: 'hose', points: pts, weights: w });
  assert.ok(Math.abs(r.length - 300) < 0.5);
  sk.slots.at(-1).attachment = 'hose';
  addC(sk, { type: 'path', name: 'p', bones: ['c1', 'c2', 'c3'], target: 'hose', settings: { rotateMode: 'chainScale', spacingMode: 'percent', spacing: 1 / 3, mixRotate: 1, mixX: 1, mixY: 1 } });
  const json = writeSkeletonJson(sk, { version: '4.3' }).json;
  const sk2 = readSkeletonJson(json).skeleton;
  // move the end bone: the chain follows the path out to it
  sk2.bones[sk2.bones.findIndex((b) => b.name === 'b')].setup.y = 120;
  const pose = new Pose(sk2);
  const end = at(pose, sk2, 'c3');
  assert.ok(end[1] > 20, `chain should bend toward b, got ${end}`);
});

test('set_slot_bone keeps a region where it was', () => {
  const sk = rig();
  addSlot(sk, { name: 's', bone: 'a' });
  sk.slots.at(-1).attachments.push({ name: 'r', type: 'region', image: 'r', offset: { x: 10, y: 5, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 }, width: 4, height: 4, color: [1, 1, 1, 1] });
  setSlotBone(sk, { slot: 's', bone: 'b' });
  const o = sk.slots.at(-1).attachments[0].offset;
  assert.ok(Math.abs(o.x + 290) < 1e-6 && Math.abs(o.y - 5) < 1e-6);
});

test('add_attachment scale shows a hi-res image at its world size', async () => {
  const { addAttachment } = await import('../src/core/authoring.js');
  const sk = rig();
  sk.images = [{ name: 'img', path: null, width: 400, height: 80 }];
  addSlot(sk, { name: 'w', bone: 'b' });
  addAttachment(sk, { slot: 'w', name: 'w', image: 'img', x: 10, y: 20, scale_x: 0.25, scale_y: 0.25, space: 'world' });
  const o = sk.slots.at(-1).attachments[0].offset;
  assert.ok(Math.abs(o.x + 290) < 1e-6 && Math.abs(o.scale_x - 0.25) < 1e-6);
});

test('slot alpha keys hide a slot and export as an alpha timeline', async () => {
  const { keySlotColor } = await import('../src/core/authoring.js');
  const sk = rig();
  keySlotColor(sk, { animation: 'clip', slot: 'front', time: 0, alpha: 0, curve: 'stepped' });
  keySlotColor(sk, { animation: 'clip', slot: 'front', time: 0.5, alpha: 1, curve: 'stepped' });
  const out = writeSkeletonJson(sk, { version: '4.3' }).json;
  assert.equal(out.animations.clip.slots.front.alpha.length, 2);
  assert.throws(() => keySlotColor(sk, { animation: 'clip', slot: 'front', time: 0 }));
});

test('slots on skin-required bones draw only while the active skin lists the bone', async () => {
  const { addSkin } = await import('../src/core/authoring.js');
  const sk = rig();
  sk.bones[1].skinRequired = true;
  addSlot(sk, { name: 's', bone: 'a' });
  sk.slots.at(-1).attachments.push({ name: 'r', type: 'region', image: 'r', offset: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 }, width: 4, height: 4, color: [1, 1, 1, 1] });
  sk.slots.at(-1).attachment = 'r';
  addSkin(sk, { name: 'k' });
  const si = sk.slots.length - 1;
  assert.equal(new Pose(sk).slotAttachment(sk, si), null);
  sk.skins[0].bones = [1]; sk.skin = 'k';
  assert.equal(new Pose(sk).slotAttachment(sk, si)?.name, 'r');
  sk.skin = null; sk.extraSkins = ['k'];
  assert.equal(new Pose(sk).slotAttachment(sk, si)?.name, 'r');
});

test('delete_attachment refuses shown attachments and removes unused ones', async () => {
  const { deleteAttachment } = await import('../src/core/authoring.js');
  const sk = rig();
  addSlot(sk, { name: 's', bone: 'a' });
  const s = sk.slots.at(-1);
  for (const n of ['x', 'y']) s.attachments.push({ name: n, type: 'region', image: n, offset: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 }, width: 4, height: 4, color: [1, 1, 1, 1] });
  s.attachment = 'x';
  assert.throws(() => deleteAttachment(sk, { slot: 's', attachment: 'x' }));
  deleteAttachment(sk, { slot: 's', attachment: 'y' });
  assert.deepEqual(s.attachments.map((a) => a.name), ['x']);
});
