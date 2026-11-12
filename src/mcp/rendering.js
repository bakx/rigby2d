// SPDX-License-Identifier: MIT OR Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { animOf, number } from '../core/authoring.js';
import { bakePhysics, lintAnimations, sampleTimes, simulate } from '../core/automation.js';
import { SoftRenderer } from '../editor/raster.js';
import { outputFrame } from '../editor/output.js';
import { encodeGif } from '../editor/gif.js';
import { encodePng } from './png.js';
import { EDIT, OUTPUT, OVERWRITE, edit } from './edits.js';
import { PATH, READ_ONLY, loadProject, rasterLookup } from './tools.js';
import { ToolError } from './protocol.js';

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const fps = { ...num, minimum: 1, maximum: 240 };

function background(rgba, bg) {
  if (!bg) return;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255, ba = bg[3] * (1 - a), out = a + ba;
    for (let c = 0; c < 3; c++) rgba[i + c] = out ? (rgba[i + c] * a + bg[c] * 255 * ba) / out : 0;
    rgba[i + 3] = out * 255;
  }
}
function line(pixels, width, height, from, to, color) {
  const n = Math.ceil(Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), 1));
  for (let i = 0; i <= Math.min(n, 50000); i++) {
    const x = Math.round(from[0] + (to[0] - from[0]) * i / n), y = Math.round(from[1] + (to[1] - from[1]) * i / n);
    if (x >= 0 && y >= 0 && x < width && y < height) pixels.set(color, (y * width + x) * 4);
  }
}
const DIGITS = ['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
function label(pixels, width, height, text) {
  for (let y = 0; y < Math.min(14, height); y++) for (let x = 0; x < Math.min(width, text.length * 8 + 8); x++) pixels.set([20, 24, 32, 255], (y * width + x) * 4);
  [...text].forEach((c, i) => {
    const glyph = c === '.' ? '000000000000010' : DIGITS[Number(c)];
    if (!glyph) return;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (glyph[y * 3 + x] === '1') for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const px = 4 + i * 8 + x * 2 + dx, py = 2 + y * 2 + dy;
      if (px < width && py < height) pixels.set([240, 244, 250, 255], (py * width + px) * 4);
    }
  });
}

/** Draw with the same software rasterizer and constraint solver used by sprite sheet export. */
async function frames(p, args, video = false) {
  const { doc } = p;
  if (doc.scene) throw new ToolError('Pass a character project; scene video rendering remains in the editor.');
  const anim = animOf(doc, args.animation);
  if (args.skin && args.skin !== 'default' && !doc.skins.some((s) => s.name === args.skin)) throw new ToolError(`No skin '${args.skin}'.`);
  doc.skin = args.skin && args.skin !== 'default' ? args.skin : null;
  if (args.times !== undefined && args.fps !== undefined) throw new ToolError('Give times or fps, not both.');
  const times = args.times ?? sampleTimes(anim.duration, args.fps ?? (video ? doc.settings.fps : 15));
  const poses = [], bounds = [Infinity, Infinity, -Infinity, -Infinity];
  simulate(doc, args.animation, times, { loop: args.loop ?? true }, (pose) => {
    for (const q of pose.quads(doc)) if (q.color[3] > 0) for (const [x, y] of q.positions) {
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
    }
  });
  if (!bounds.every(Number.isFinite)) throw new ToolError('The animation has no visible artwork.');
  const scale = number(args.scale ?? 1, 'scale', 0.001, 100);
  let width, height, frame;
  if (video) {
    [width, height] = args.size ?? [doc.settings.width, doc.settings.height];
    frame = outputFrame({ ...doc.settings, width, height }, bounds);
  } else {
    width = Math.max(1, Math.ceil((bounds[2] - bounds[0]) * scale) + 8);
    height = Math.max(1, Math.ceil((bounds[3] - bounds[1]) * scale) + 8);
    frame = { x0: bounds[0] - 4 / scale, y1: bounds[3] + 4 / scale, scale: 1 / scale };
  }
  number(width, 'width', 1, 8192); number(height, 'height', 1, 8192);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new ToolError('Output dimensions must be integers.');
  if (width * height * times.length > 128 * 1024 * 1024) throw new ToolError('Render exceeds 128 million pixels; lower scale, size or fps.');
  const lookup = await rasterLookup(p);
  simulate(doc, args.animation, times, { loop: args.loop ?? true }, (pose, i) => {
    let f = frame;
    if (video && doc.settings.frame?.camera) {
      const ci = doc.bones.findIndex((b) => b.name === 'camera');
      if (ci >= 0) {
        const camera = pose.world[ci], scale = frame.scale / (Math.hypot(camera.a, camera.b) || 1);
        f = { scale, x0: camera.tx - width * scale / 2, y1: camera.ty + height * scale / 2 };
      }
    }
    const renderer = new SoftRenderer(width, height, f, { smooth: doc.textureFilter !== 'nearest' });
    renderer.drawSkeleton(doc, pose, lookup);
    const rgba = renderer.resolve();
    if (video) background(rgba, doc.settings.background ?? (args.format === 'mp4' ? [0, 0, 0, 1] : null));
    const point = (p) => [(p[0] - f.x0) / f.scale, (f.y1 - p[1]) / f.scale];
    if (args.overlays?.length) for (let b = 0; b < doc.bones.length; b++) {
      const origin = point(pose.world[b].apply([0, 0]));
      if (args.overlays.includes('bones')) line(rgba, width, height, origin, point(pose.world[b].apply([doc.bones[b].length, 0])), [60, 210, 255, 255]);
      if (args.overlays.includes('pivots') || args.overlays.includes('ik_targets') && doc.ik.some((c) => c.target === b)) {
        line(rgba, width, height, [origin[0] - 3, origin[1]], [origin[0] + 3, origin[1]], [255, 100, 80, 255]);
        line(rgba, width, height, [origin[0], origin[1] - 3], [origin[0], origin[1] + 3], [255, 100, 80, 255]);
      }
    }
    if (args.labels) label(rgba, width, height, times[i].toFixed(2));
    poses.push(rgba);
  });
  return { width, height, times, pixels: poses };
}

async function destination(ws, output, overwrite) {
  const target = await ws.writable(output);
  if (!overwrite && await fs.stat(target).then(() => true, () => false)) throw new ToolError(`${output} already exists; pass overwrite: true.`);
  return target;
}
async function atomicWrite(target, bytes) {
  const temp = `${target}.${process.pid}.tmp`;
  try { await fs.writeFile(temp, bytes); await fs.rename(temp, target); }
  finally { await fs.rm(temp, { force: true }); }
}

export function createRenderingTools(ws) {
  const base = { path: PATH, animation: str };
  return [
    {
      name: 'render_preview', title: 'Render preview', description: 'Render a clip to one PNG strip/grid or animated GIF, with physics, optional frame-time labels and bone/IK/pivot overlays. Returns its viewable file path and dimensions. GIF requires uniform fps, not explicit times.',
      inputSchema: { type: 'object', properties: { ...base, output: str, times: { type: 'array', items: { ...num, minimum: 0 }, minItems: 1, maxItems: 10000 }, fps, skin: str, scale: { ...num, exclusiveMinimum: 0 }, layout: { type: 'string', enum: ['strip', 'grid', 'gif'] }, labels: bool, loop: bool, overlays: { type: 'array', items: { type: 'string', enum: ['bones', 'ik_targets', 'pivots'] } }, overwrite: OVERWRITE }, required: ['path', 'animation', 'output'], additionalProperties: false }, annotations: { ...EDIT, destructiveHint: false },
      handler: async (args) => {
        const layout = args.layout ?? 'grid', ext = layout === 'gif' ? '.gif' : '.png';
        if (path.extname(args.output).toLowerCase() !== ext) throw new ToolError(`Use a ${ext} output for ${layout}.`);
        if (layout === 'gif' && args.times) throw new ToolError('GIF uses uniform fps; omit times.');
        const output = await destination(ws, args.output, args.overwrite);
        const p = await loadProject(await ws.existing(args.path));
        const r = await frames(p, args);
        let width = r.width, height = r.height, bytes;
        if (layout === 'gif') bytes = encodeGif({ width, height, frames: r.pixels, fps: args.fps ?? 15, transparent: true, loop: args.loop ?? true });
        else {
          const columns = layout === 'strip' ? r.pixels.length : Math.ceil(Math.sqrt(r.pixels.length * r.height / r.width));
          width = r.width * columns; height = r.height * Math.ceil(r.pixels.length / columns);
          if (width > 32767 || height > 32767 || width * height > 128 * 1024 * 1024) throw new ToolError('Preview is too large; lower scale/fps or use a grid.');
          const data = new Uint8Array(width * height * 4);
          r.pixels.forEach((rgba, i) => { const x = (i % columns) * r.width, y = Math.floor(i / columns) * r.height; for (let row = 0; row < r.height; row++) data.set(rgba.subarray(row * r.width * 4, (row + 1) * r.width * 4), ((y + row) * width + x) * 4); });
          bytes = encodePng({ width, height, data });
        }
        await atomicWrite(output, bytes);
        return { file: output, width, height, frames: r.times.length, times: r.times, layout };
      },
    },
    {
      name: 'render_video', title: 'Render video', description: 'Render a character clip to WebM (VP9 with alpha) or MP4 (H.264). Uses project framing/background and mixes animation audio. Requires FFmpeg on PATH. Scenes remain available through editor rendering.',
      inputSchema: { type: 'object', properties: { ...base, output: str, fps, size: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 8192 }, minItems: 2, maxItems: 2 }, skin: str, loop: bool, overwrite: OVERWRITE }, required: ['path', 'animation', 'output'], additionalProperties: false }, annotations: { ...EDIT, destructiveHint: false },
      handler: async (args) => {
        const format = path.extname(args.output).toLowerCase().slice(1);
        if (!['webm', 'mp4'].includes(format)) throw new ToolError('Output must be .webm or .mp4.');
        const output = await destination(ws, args.output, args.overwrite);
        const p = await loadProject(await ws.existing(args.path));
        const rate = args.fps ?? p.doc.settings.fps;
        const run = promisify(execFile);
        try { await run('ffmpeg', ['-version'], { windowsHide: true }); } catch { throw new ToolError('render_video needs FFmpeg on PATH.'); }
        const r = await frames(p, { ...args, fps: rate, format }, true);
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-video-'));
        try {
          for (let i = 0; i < r.pixels.length; i++) await fs.writeFile(path.join(dir, `${String(i).padStart(6, '0')}.png`), encodePng({ width: r.width, height: r.height, data: r.pixels[i] }));
          const argv = ['-v', 'error', '-y', '-framerate', String(rate), '-i', path.join(dir, '%06d.png')];
          const tracks = p.doc.audio.filter((t) => t.animation === args.animation && p.entries?.has(`audio/${t.sound}`));
          const filters = [];
          for (const [i, track] of tracks.entries()) {
            const sound = path.join(dir, `audio${i}${path.extname(track.sound)}`);
            await fs.writeFile(sound, p.entries.get(`audio/${track.sound}`));
            argv.push('-i', sound);
            const shift = track.offset < 0 ? `atrim=start=${-track.offset},asetpts=PTS-STARTPTS` : `adelay=${Math.round(track.offset * 1000)}:all=1`;
            filters.push(`[${i + 1}:a]${shift},volume=${track.volume}[a${i}]`);
          }
          if (tracks.length) {
            filters.push(`${tracks.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tracks.length}:normalize=0,apad[audio]`);
            argv.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[audio]', '-c:a', format === 'mp4' ? 'aac' : 'libopus');
          }
          argv.push('-t', String(r.pixels.length / rate));
          if (format === 'mp4') argv.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
          else argv.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0');
          const rendered = path.join(dir, `render.${format}`);
          argv.push(rendered);
          await run('ffmpeg', argv, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
          await atomicWrite(output, await fs.readFile(rendered));
          return { file: output, width: format === 'mp4' ? Math.ceil(r.width / 2) * 2 : r.width, height: format === 'mp4' ? Math.ceil(r.height / 2) * 2 : r.height, fps: rate, frames: r.pixels.length, audioTracks: tracks.length };
        } finally {
          const root = await fs.realpath(os.tmpdir()), actual = await fs.realpath(dir);
          if (path.dirname(actual) === root && path.basename(actual).startsWith('rigby-video-')) await fs.rm(actual, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'lint_animations', title: 'Lint animations', description: 'Report loop seams, large frame jumps, missing/hidden attachments, pinned IK targets and keys overridden by IK. Loop detection defaults to idle/breathe/walk/run/loop names; set loop explicitly for other clips. Warnings do not make a structurally valid project invalid.',
      inputSchema: { type: 'object', properties: { path: PATH, animation: str, loop: bool, fps, jump_threshold: { ...num, minimum: 0 }, rotation_threshold: { ...num, minimum: 0 } }, required: ['path'], additionalProperties: false }, annotations: READ_ONLY,
      handler: async (args) => { const p = await loadProject(await ws.existing(args.path)); return { warnings: lintAnimations(p.doc, args) }; },
    },
  ];
}

export function bakeTool(ws) {
  const base = { path: PATH, animation: str };
  const tool = {
    name: 'bake_physics', title: 'Bake physics', description: 'Simulate physics and replace affected bone channels with sampled keys. By default disables the selected physics constraints in this clip only. loop settles one period and closes the last key. Refuses bones also driven by another constraint type.',
    inputSchema: { type: 'object', properties: { ...base, constraints: { type: 'array', items: str, minItems: 1 }, fps, loop: bool, disable: bool, output: OUTPUT, overwrite: OVERWRITE }, required: ['path', 'animation'], additionalProperties: false }, annotations: EDIT,
    apply: (doc, args) => bakePhysics(doc, args),
  };
  tool.handler = (args) => edit(ws, args, (doc) => tool.apply(doc, args));
  return tool;
}
