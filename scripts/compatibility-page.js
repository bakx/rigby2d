// SPDX-License-Identifier: MIT OR Apache-2.0
// Runs in Chromium against the same loading, pose and frame renderer used by the editor.
import { openProject, usedImages } from '../src/editor/io.js';
import { Images } from '../src/editor/images.js';
import { Pose } from '../src/core/pose.js';
import { FrameRenderer } from '../src/editor/render/offline.js';
import { classifyLoadError } from './compatibility-classification.js';

const fs = {
  async readFile(p) { const data = atob(await window.readCompatibilityFile(p)); return Uint8Array.from(data, c => c.charCodeAt(0)); },
  async readText(p) { return new TextDecoder().decode(await this.readFile(p)); },
  async list(p) { try { return await window.listCompatibilityDirectory(p); } catch { return []; } },
};
export async function validate(file) {
  const stages = {};
  const images = new Images();
  try {
    const opened = await openProject(file, fs, images);
    const doc = opened.doc;
    const warnings = opened.warnings;
    stages.load = 'ok';
    stages.structure = doc.validate() || 'ok';
    const needed = usedImages(doc);
    const missingImages = needed.filter(name => !images.contains(name));
    stages.images = { needed: needed.length, loaded: needed.length - missingImages.length, missing: missingImages };
    const pose = new Pose(doc);
    const samples = [null, ...doc.animations];
    let nonfinite = false;
    for (const animation of samples) {
      for (const t of animation ? [0, animation.duration / 2, animation.duration] : [0]) {
        pose.reset(doc);
        if (animation) pose.apply(doc, animation, t, 1);
        pose.updateWorld(doc);
        for (const w of pose.world) if (![w.a,w.b,w.c,w.d,w.tx,w.ty].every(Number.isFinite)) nonfinite = true;
        for (const quad of pose.quads(doc)) if (quad.positions.flat().some(n => !Number.isFinite(n))) nonfinite = true;
      }
    }
    stages.geometry = nonfinite ? 'non-finite geometry' : 'ok';
    stages.animations = { count: doc.animations.length, sampled: doc.animations.length };
    let rendered = 0, nonempty = 0;
    const settings = { ...doc.settings, width: 128, height: 128, fps: 30, background: null, frame: null };
    for (let i = 0; i < Math.max(1, doc.animations.length); i++) {
      const renderer = new FrameRenderer(doc, images, { animation: doc.animations.length ? i : null, skin: null, settings, width: 128, height: 128 });
      try {
        for (const frame of doc.animations.length ? [0, 1] : [0]) {
          renderer.render(frame);
          const pixels = new Uint8Array(128 * 128 * 4);
          renderer.gl.readPixels(0, 0, 128, 128, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixels);
          if (renderer.gl.getError() !== renderer.gl.NO_ERROR) throw new Error('WebGL rendering error');
          if (pixels.some((v, n) => n % 4 === 3 && v !== 0)) nonempty++;
          rendered++;
        }
      } finally { renderer.dispose(); }
    }
    stages.render = { frames: rendered, nonempty };
    const partial = stages.structure !== 'ok' || nonfinite || missingImages.length || warnings.length || (needed.length > 0 && nonempty === 0);
    return { result: partial ? 'PARTIAL' : 'UNVERIFIED', reason: partial ? 'Review warnings or failed validation stages' : 'Rendered frames require visual and motion review', version: doc.header?.version ?? doc.format ?? null, warnings, stages };
  } catch (e) {
    const reason = String(e?.message ?? e);
    return { result: classifyLoadError(reason, !!stages.load), reason, stages };
  }
}
