// SPDX-License-Identifier: MIT OR Apache-2.0
// Drawing without a graphics API (draw.js): what the WebGL renderer and the engine runtimes (Cocos
// Creator) draw from. A real character's triangles land inside their atlas pages, with tint, and
// clipping masks what it covers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { atlasLookup, drawSkeletonGeometry, imageLookup, parseAtlas, Pose, readSkeletonBinary, readSkeletonJson } from '../src/core/index.js';

test("NILA's export draws as triangles inside her atlas pages", () => {
  const sk = readSkeletonJson(readSkeletonBinary(new Uint8Array(fs.readFileSync('branding/nila/export/nila.skel'))), 'nila').skeleton;
  const atlas = parseAtlas(fs.readFileSync('branding/nila/export/nila.atlas', 'utf8'));
  const page = { name: 'page' };
  const lookup = atlasLookup(atlas, () => page);
  const pose = new Pose(sk);
  pose.setToSetup(sk);
  pose.updateWorld(sk);
  let triangles = 0;
  let pieces = 0;
  drawSkeletonGeometry(sk, pose, lookup, (tex, blend, positions, uvs, tri, light) => {
    assert.equal(tex, page);
    assert.ok(['normal', 'additive', 'multiply', 'screen'].includes(blend));
    assert.equal(positions.length, uvs.length);
    for (const v of uvs) assert.ok(v >= -1e-6 && v <= 1 + 1e-6, `uv ${v}`);
    for (const t of tri) assert.ok(t < positions.length / 2);
    assert.equal(light.length, 4);
    triangles += tri.length / 3;
    pieces++;
  });
  assert.ok(pieces > 20 && triangles > 100, `${pieces} pieces, ${triangles} triangles`);
});

test('tint multiplies, skip leaves out, and images without an atlas work', () => {
  const sk = readSkeletonJson(
    {
      skeleton: { spine: '4.2.0' },
      bones: [{ name: 'root' }],
      slots: [
        { name: 'a', bone: 'root', attachment: 'a', color: 'ff000080' },
        { name: 'b', bone: 'root', attachment: 'b', blend: 'additive' },
      ],
      skins: [{ name: 'default', attachments: { a: { a: { width: 10, height: 10 } }, b: { b: { width: 4, height: 4 } } } }],
    },
    't',
  ).skeleton;
  const pose = new Pose(sk);
  pose.setToSetup(sk);
  pose.updateWorld(sk);
  const lookup = imageLookup({ a: 'texA', b: 'texB' });
  const seen = [];
  drawSkeletonGeometry(sk, pose, lookup, (tex, blend, p, uv, tri, light) => seen.push({ tex, blend, light }), { tint: [1, 1, 1, 0.5] });
  assert.deepEqual(
    seen.map((s) => [s.tex, s.blend]),
    [
      ['texA', 'normal'],
      ['texB', 'additive'],
    ],
  );
  assert.ok(Math.abs(seen[0].light[3] - 0.25) < 0.01, 'slot alpha times tint alpha');
  const skipped = [];
  drawSkeletonGeometry(sk, pose, lookup, (tex) => skipped.push(tex), { skip: (slot) => slot === 0 });
  assert.deepEqual(skipped, ['texB']);
});

test('inverse clipping removes the mask interior and interpolates texture coordinates', async () => {
  const { Clipper } = await import('../src/core/clipping.js');
  const positions = [0, 0, 2, 0, 0, 2];
  const uvs = [0, 0, 1, 0, 0, 1];
  const polygon = [0, 0, 1, 0, 1, 1, 0, 1];
  let area = 0;
  new Clipper(polygon, { inverse: true }).clip(positions, uvs, [0, 1, 2], (p, uv, tris) => {
    for (let i = 0; i < p.length; i += 2) { assert.ok(Math.abs(uv[i] - p[i] / 2) < 1e-6); assert.ok(Math.abs(uv[i + 1] - p[i + 1] / 2) < 1e-6); }
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = tris.slice(i, i + 3).map(n => [p[2 * n], p[2 * n + 1]]);
      area += Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])) / 2;
    }
  });
  assert.ok(Math.abs(area - 1) < 1e-6);
});

test('inverse clipping attachments affect the skeleton draw path', () => {
  const json = {
    skeleton: { spine: '4.3.0' }, bones: [{ name: 'root' }],
    slots: [{ name: 'mask', bone: 'root', attachment: 'mask' }, { name: 'body', bone: 'root', attachment: 'body' }],
    skins: [{ name: 'default', attachments: { mask: { mask: { type: 'clipping', end: 'body', vertexCount: 4, vertices: [-1,-1,1,-1,1,1,-1,1], inverse: true } }, body: { body: { width: 4, height: 4 } } } }],
  };
  const sk = readSkeletonJson(json).skeleton, pose = new Pose(sk);
  let area = 0;
  drawSkeletonGeometry(sk, pose, imageLookup(new Map([['body', {}]])), (_tex, _blend, p, _uv, triangles) => {
    for (let i = 0; i < triangles.length; i += 3) {
      const [a,b,c] = triangles.slice(i,i+3).map(n => [p[2*n],p[2*n+1]]);
      area += Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])) / 2;
    }
  });
  assert.ok(Math.abs(area - 12) < 1e-6, `drawn area ${area}`);
});
