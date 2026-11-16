// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { Skeleton, makeBone, makeSlot, makeAttachment } from '../src/core/model.js';
import { Animation } from '../src/core/animation.js';
import { transform } from '../src/core/math.js';
import { createEditTools, save } from '../src/mcp/edits.js';
import { Workspace, loadProject } from '../src/mcp/tools.js';
import { encodePng } from '../src/mcp/png.js';

async function setup(t, second = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-authoring-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ws = await Workspace.open([dir]);
  const doc = new Skeleton();
  doc.bones.push(makeBone('upper', 0, transform(4, 1), 15));
  doc.bones.push(makeBone('lower', 1, transform(15, 0), 12));
  doc.images.push({ name: 'art', path: null, width: 32, height: 12 });
  doc.slots.push(makeSlot('arm', 1, makeAttachment('art', 'art', transform(8, 0), 32, 12)));
  if (second) doc.slots.push(makeSlot('forearm', 2, makeAttachment('art', 'art', transform(8, 0), 32, 12)));
  doc.animations.push(new Animation('wave', 1));
  const pixels = { width: 32, height: 12, data: new Uint8Array(Array.from({ length: 32 * 12 }, () => [120, 20, 30, 255]).flat()) };
  const png = encodePng(pixels);
  await fs.writeFile(path.join(dir, 'new.png'), png);
  const file = path.join(dir, 'project.rigby');
  await save(ws, { doc, entries: new Map([['images/art.png', png]]), file, format: 'rigby' }, {});
  const tools = Object.fromEntries(createEditTools(ws).map(t => [t.name, args => t.handler({ path: file, ...args })]));
  return { dir, file, tools, read: async () => (await loadProject(file)).doc };
}

test('MCP batch authors skins, image attachments and weighted meshes atomically', async t => {
  const { tools, read, file } = await setup(t);
  await tools.batch_edit({ operations: [
    { op: 'add_skin', name: 'outfit' },
    { op: 'set_skin_attachment', skin: 'outfit', slot: 'arm', attachment: 'art', image_file: 'new.png' },
    { op: 'add_attachment', slot: 'arm', name: 'hand', image_file: 'new.png', x: 4 },
    { op: 'make_mesh', slot: 'arm', attachment: 'art', mode: 'grid', spacing: 5 },
    { op: 'auto_weight', slot: 'arm', attachment: 'art', bones: ['upper', 'lower'] },
    { op: 'set_weights', slot: 'arm', attachment: 'art', vertices: [0], weights: [[{ bone: 'lower', weight: 2 }]] },
    { op: 'smooth_weights', slot: 'arm', attachment: 'art', iterations: 2 },
    { op: 'duplicate_attachment', slot: 'arm', attachment: 'art', new_name: 'copy' },
    { op: 'add_event', name: 'marker' },
  ] });
  let doc = await read();
  assert.equal(doc.skins[0].name, 'outfit');
  const mesh = doc.slots[0].attachments.find(a => a.name === 'art');
  const copy = doc.slots[0].attachments.find(a => a.name === 'copy');
  assert.equal(mesh.type, 'mesh');
  assert.ok(mesh.weights.every(weights => Math.abs(weights.reduce((n, w) => n + w.weight, 0) - 1) < 1e-5));
  assert.deepEqual(copy.weights, mesh.weights);
  assert.equal(doc.events[0].name, 'marker');
  const before = await fs.readFile(file);
  await assert.rejects(tools.batch_edit({ operations: [{ op: 'add_skin', name: 'temporary' }, { op: 'replace_image', slot: 'arm', attachment: 'copy', image_file: 'missing.png' }] }), /Operation 2/);
  assert.deepEqual(await fs.readFile(file), before);
  await tools.replace_image({ slot: 'arm', attachment: 'copy', image_file: 'new.png' });
  await tools.delete_skin({ name: 'outfit' });
  doc = await read();
  assert.equal(doc.skins.length, 0);
  assert.notEqual(doc.slots[0].attachments.find(a => a.name === 'copy').image, mesh.image);
});

test('MCP rig operations reject invalid weights without saving', async t => {
  const { tools, file } = await setup(t);
  await tools.make_mesh({ slot: 'arm', attachment: 'art', mode: 'grid', spacing: 8 });
  const before = await fs.readFile(file);
  await assert.rejects(tools.set_weights({ slot: 'arm', attachment: 'art', vertices: [0], weights: [[{ bone: 'lower', weight: -1 }]] }), /weight/);
  assert.deepEqual(await fs.readFile(file), before);
});


test('MCP constraint authoring keys IK and targets in animation space', async t => {
  const { tools, read } = await setup(t);
  await tools.batch_edit({ operations: [
    { op: 'add_bone', name: 'target', parent: 'root', x: 24, y: 8 },
    { op: 'add_constraint', type: 'ik', name: 'arm_ik', bones: ['upper', 'lower'], target: 'target' },
    { op: 'set_constraint_key', animation: 'wave', constraint: 'arm_ik', time: 0.5, values: { mix: 0.25 } },
    { op: 'set_ik_target_key', animation: 'wave', constraint: 'arm_ik', time: 0.5, world_point: [20, 10] },
  ] });
  const doc = await read();
  assert.equal(doc.ik[0].name, 'arm_ik');
  assert.equal(doc.animations[0].ik[0].keys[0].value.mix, 0.25);
  assert.ok(doc.animations[0].bones.some(t => t.translate?.length));
});



test('MCP joins two rigid image slots into a weighted mesh', async t => {
  const { tools, read } = await setup(t, true);
  const result = await tools.merge_parts({ slots: ['arm', 'forearm'], into: 'merged' });
  const doc = await read();
  assert.ok(result.vertices > 4);
  assert.equal(doc.slots.find(s => s.name === 'merged').attachments[0].type, 'mesh');
  assert.equal(doc.slots.find(s => s.name === 'arm').attachment, null);
  assert.equal(doc.slots.find(s => s.name === 'forearm').attachment, null);
  await assert.rejects(tools.merge_parts({ slots: ['arm', 'arm'], into: 'another' }), /distinct/);
});
