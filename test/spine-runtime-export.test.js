// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TextureAtlas, AtlasAttachmentLoader, SkeletonJson, SkeletonBinary, Skeleton as SpineSkeleton, AnimationState, AnimationStateData, Physics, FakeTexture } from '@esotericsoftware/spine-core';
import decodeWebp, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import { readSkeletonJson } from '../src/core/interop.js';
import { parseAtlas, writeAtlas } from '../src/core/atlas.js';
import { drawSkeletonGeometry, imageLookup } from '../src/core/draw.js';
import { Pose } from '../src/core/pose.js';
import { Workspace, createTools } from '../src/mcp/tools.js';
import { save } from '../src/mcp/edits.js';
import { encodePng, decodePng } from '../src/mcp/png.js';

async function fixture(t, { spacing = 0, mode = 'proportional', positionMode = 'percent', position = 0, rotateMode = 'chainScale', ik = null, skinFilter = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-spine-export-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = { skeleton: { spine: '4.2.0' }, bones: [{ name: 'root' }, { name: 'a', parent: 'root', length: 10 }, { name: 'b', parent: 'a', x: 10, length: 10 }],
    slots: [{ name: 'art', bone: 'root', attachment: 'art' }, { name: 'guide', bone: 'root', attachment: 'guide' }],
    path: [{ name: 'follow', bones: ['a', 'b'], target: 'guide', positionMode, position, spacingMode: mode, spacing, rotateMode }],
    skins: [{ name: 'default', attachments: { art: { art: { type: 'mesh', uvs: [0,0, 1,0, 1,1, 0,1], triangles: [0,1,2, 0,2,3], vertices: [-8,-8,8,-8,8,8,-8,8], hull: 4, width: 16, height: 16 } }, guide: { guide: { type: 'path', vertexCount: 9, vertices: [-10,0,0,0,5,20,20,15,30,0,40,-20,55,-15,60,0,70,0], lengths: [40,80,120] } } } }],
    animations: { clip: { slots: { art: { alpha: [{ value: 1, curve: 'stepped' }] } } } } };
  if (ik) {
    Object.assign(source.bones[0], { rotation: 25, scaleX: 1.4, scaleY: 0.6 });
    source.bones[2].length = 8;
    source.bones.push({ name: 'target', parent: 'root', x: 13, y: 7 });
    source.path = [];
    source.ik = [{ name: 'aim', bones: ['a', 'b'], target: 'target', bendPositive: ik.bend, mix: ik.mix }];
  }
  if (skinFilter) {
    source.bones[1].skin = true; source.bones[2].skin = true;
    source.slots[0].bone = 'a';
    source.slots.push({ name: 'inactive', bone: 'b', attachment: 'inactive' });
    source.skins[0].attachments.inactive = { inactive: { path: 'art', width: 16, height: 16 } };
    source.skins.push({ name: 'chosen', bones: ['a'], attachments: {} });
    source.path = [];
  }
  const doc = readSkeletonJson(source).skeleton;
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y=0;y<16;y++) for(let x=0;x<16;x++) {
    const i=(y*16+x)*4, alpha = x>=6 && x<10 && y>=6 && y<10 ? 128 : 0;
    rgba.set([(x*47+y*13)%256, (x*31+y*23)%256, (x*19+y*43)%256, alpha], i);
  }
  const ws = await Workspace.open([dir]);
  const file = path.join(dir, 'source.rigby');
  await save(ws, { doc, entries: new Map([['images/art.png', encodePng({ width: 16, height: 16, data: rgba })]]), file, format: 'rigby' }, {});
  const tools = Object.fromEntries(createTools(ws).map(z => [z.name,z.handler]));
  const output=path.join(dir,'model.json');
  return {dir,doc,file,output,tools,rgba};
}
async function exported(f, options = {}) {
  await f.tools.convert_project({input:f.file,output:f.output,version:'4.3',atlas:true,overwrite:true,trim:true,pma:true,...options});
  const json=JSON.parse(await fs.readFile(f.output,'utf8')), text=await fs.readFile(path.join(f.dir,'model.atlas'),'utf8');
  const atlas=new TextureAtlas(text);
  for (const page of atlas.pages) page.setTexture(new FakeTexture({width:page.width,height:page.height}));
  const data=new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(json), spine=new SpineSkeleton(data);
  const state=new AnimationState(new AnimationStateData(data));state.setAnimation(0,'clip',false);state.update(0);state.apply(spine);spine.updateWorldTransform(Physics.none);
  const pose=new Pose(f.doc);pose.apply(f.doc,f.doc.animations[0],0,1);pose.updateWorld(f.doc);
  return {json,atlas,spine,pose};
}
async function compare(f, r) {
  const sampled=await f.tools.sample_pose({path:f.file,animation:'clip',time:0});
  for (const bone of sampled.bones) { const b=r.spine.findBone(bone.name).appliedPose; assert.ok(Math.abs(b.worldX-bone.x)<0.002 && Math.abs(b.worldY-bone.y)<0.002, `${bone.name}: ${b.worldX},${b.worldY} vs ${bone.x},${bone.y}`); }
  const slot=r.spine.findSlot('art'), index=f.doc.slots.findIndex(s=>s.name==='art');
  const color=slot.appliedPose.color;
  for (const [i, value] of [color.r,color.g,color.b,color.a].entries())
    assert.ok(Math.abs(value-r.pose.color[index][i])<1e-6, `slot color component ${i}`);
  const attachment=slot.appliedPose.attachment, a=new Array(attachment.worldVerticesLength), ours=r.pose.worldVertices(f.doc,index,r.pose.slotAttachment(f.doc,index));
  attachment.computeWorldVertices(r.spine,slot,0,a.length,a,0,2);
  assert.equal(a.length,ours.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-ours[i])<0.002,`vertex ${i}: ${a[i]} vs ${ours[i]}`);
}

test('Spine runtime sees full-opacity alpha keys in JSON and binary exports', async t => {
  const f=await fixture(t), r=await exported(f);
  assert.equal(r.json.animations.clip.slots.art.alpha[0].value,1);
  await compare(f,r);
  const binary=path.join(f.dir,'binary.skel');
  await f.tools.convert_project({input:f.file,output:binary,version:'4.3'});
  const data=new SkeletonBinary(new AtlasAttachmentLoader(r.atlas)).readSkeletonData(new Uint8Array(await fs.readFile(binary)));
  const spine=new SpineSkeleton(data), state=new AnimationState(new AnimationStateData(data));
  state.setAnimation(0,'clip',false);state.update(0);state.apply(spine);spine.updateWorldTransform(Physics.none);
  await compare(f,{ ...r,spine });
});
test('Spine runtime and Rigby agree on path spacing and position modes', async t => {
  for (const [mode, spacings] of [['proportional', [0, 0.3, 1]], ['percent', [0, 0.3]], ['length', [0, 3]], ['fixed', [0, 3]]]) {
    for (const spacing of spacings) for (const rotateMode of ['chainScale', 'tangent']) for (const positionMode of ['percent', 'fixed']) {
      const f=await fixture(t,{mode,spacing,rotateMode,positionMode,position:positionMode==='percent'?0.2:2});
      await compare(f,await exported(f));
    }
  }
});
test('two-bone IK under a nonuniform ancestor matches the Spine runtime', async t => {
  for (const bend of [true, false]) for (const mix of [0.4, 1]) {
    const f = await fixture(t, { ik: { bend, mix } });
    await compare(f, await exported(f));
  }
});
test('skin-required bones hide the same attachments as the Spine runtime', async t => {
  const f = await fixture(t, { skinFilter: true }), r = await exported(f);
  f.doc.skin = 'chosen'; r.spine.setSkinByName('chosen'); r.spine.setupPoseSlots();
  r.spine.updateWorldTransform(Physics.none); r.pose.updateWorld(f.doc);
  assert.equal(r.spine.findBone('a').active, true);
  assert.equal(r.spine.findBone('b').active, false);
  assert.deepEqual(r.pose.quads(f.doc).map(q => f.doc.slots[q.slot].name), ['art']);
  let drawn = 0;
  drawSkeletonGeometry(f.doc, r.pose, imageLookup(new Map([['art', {}]])), () => drawn++);
  assert.equal(drawn, 1);
});
test('trimmed export retains full region for mesh UVs in Spine runtime', async t => {
  const f=await fixture(t),r=await exported(f), region=r.atlas.findRegion('art');
  assert.equal(region.width,16);assert.equal(region.originalWidth,16);await compare(f,r);
  const atlasFile=path.join(f.dir,'model.atlas'), parsed=parseAtlas(await fs.readFile(atlasFile,'utf8'));
  const trimmed=parsed.pages[0].regions.find(x=>x.name==='art');
  Object.assign(trimmed,{width:4,height:4,offsetX:6,offsetY:6,originalWidth:16,originalHeight:16});
  await fs.writeFile(atlasFile,writeAtlas(parsed.pages));
  const report=await f.tools.validate_project({path:f.output});
  assert.ok(report.warnings.some(w=>/UVs outside atlas region 'art'/.test(w)));
});
test('lossless WebP atlas is exact and usable by Spine runtime', async t => {
  const f=await fixture(t);
  await exported(f);
  const png = decodePng(await fs.readFile(path.join(f.dir, 'model.png')));
  const r=await exported(f,{texture_format:'webp'});
  const bytes=await fs.readFile(path.join(f.dir,'model.webp'));
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');
  const decoderWasm = new URL('./codec/dec/webp_dec.wasm', import.meta.resolve('@jsquash/webp/decode.js'));
  await initWebpDecoder(await WebAssembly.compile(await fs.readFile(decoderWasm)));
  const webp = await decodeWebp(bytes);
  assert.deepEqual([webp.width, webp.height], [png.width, png.height]);
  assert.deepEqual(Buffer.from(webp.data), Buffer.from(png.data));
  for (let i = 0; i < webp.data.length; i += 4)
    if (webp.data[i + 3] === 0) assert.deepEqual([...webp.data.subarray(i, i + 3)], [0, 0, 0]);
  await compare(f,r);
});
