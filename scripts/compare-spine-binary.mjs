// Usage: node scripts/compare-spine-binary.mjs <spine-core/dist/index.js> <file.skel> [...]
// Install @esotericsoftware/spine-core@4.3.13 separately; game assets stay local.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSkeletonBinary, writeSkeletonBinary } from '../src/core/binary.js';
const [modulePath, ...files] = process.argv.slice(2);
if (!modulePath || !files.length) throw new Error('Provide the Spine core index.js and one or more .skel files');
const s = await import(pathToFileURL(resolve(modulePath)).href);
const loader = {
  newRegionAttachment: (_s, _p, n, _path, q) => { const a = new s.RegionAttachment(n, q); a.updateSequence = () => {}; return a; },
  newMeshAttachment: (_s, _p, n, _path, q) => { const a = new s.MeshAttachment(n, q); a.updateSequence = () => {}; return a; },
  newBoundingBoxAttachment: (_s, _p, n) => new s.BoundingBoxAttachment(n),
  newPathAttachment: (_s, _p, n) => new s.PathAttachment(n),
  newPointAttachment: (_s, _p, n) => new s.PointAttachment(n),
  newClippingAttachment: (_s, _p, n) => new s.ClippingAttachment(n),
};
const summary = o => ({ bones: o.bones.length, slots: o.slots.length, skins: o.skins.length,
  attachments: o.skins.map(x => x.getAttachments().length),
  constraints: Object.fromEntries(['IkConstraintData', 'TransformConstraintData', 'PathConstraintData', 'PhysicsConstraintData', 'SliderData'].map(t => [t, o.constraints.filter(c => c.constructor.name === t).length])),
  animations: o.animations.map(a => [a.name, a.duration, a.timelines.length]) });
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const official = summary(new s.SkeletonBinary(loader).readSkeletonData(bytes));
  const ours = readSkeletonBinary(bytes);
  assert.equal(ours.bones.length, official.bones);
  assert.equal(ours.slots.length, official.slots);
  assert.equal(ours.skins.length, official.skins);
  assert.deepEqual(ours.skins.map(skin => Object.values(skin.attachments).reduce((n, a) => n + Object.keys(a).length, 0)), official.attachments);
  const types = { ik: 'IkConstraintData', transform: 'TransformConstraintData', path: 'PathConstraintData', physics: 'PhysicsConstraintData', slider: 'SliderData' };
  for (const [type, name] of Object.entries(types)) assert.equal((ours.constraints ?? []).filter(c => c.type === type).length, official.constraints[name]);
  for (const [name, duration, timelines] of official.animations) {
    const animation = ours.animations[name];
    assert.ok(animation, `missing animation ${name}`);
    const arrays = [];
    const visit = value => {
      if (Array.isArray(value)) arrays.push(value);
      else if (value && typeof value === 'object') for (const v of Object.values(value)) visit(v);
    };
    for (const section of ['slots', 'bones', 'ik', 'transform', 'path', 'physics', 'slider', 'attachments', 'drawOrder', 'events']) visit(animation[section]);
    const folderCount = animation._drawOrderFolders?.length ?? 0;
    assert.equal(arrays.length + folderCount, timelines, `${name} timeline count`);
    const maxTime = Math.max(0, ...arrays.flatMap(keys => keys.map(key => key.time ?? 0)), ...(animation._drawOrderFolders ?? []).flatMap(folder => folder.keys.map(key => key.time ?? 0)));
    assert.ok(Math.abs(maxTime - duration) < 0.00001, `${name} duration`);
  }
  const roundtrip = summary(new s.SkeletonBinary(loader).readSkeletonData(writeSkeletonBinary(ours)));
  assert.deepEqual(roundtrip, official);
  console.log(`${file}: counts, animation durations and timeline counts match`);
}
