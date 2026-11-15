import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverProjects } from '../scripts/compatibility-discovery.js';

test('compatibility discovery finds editor projects recursively and excludes unrelated JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-compat-test-'));
  try {
    await fs.mkdir(path.join(dir, 'nested'));
    await fs.writeFile(path.join(dir, 'nested', 'skeleton.json'), JSON.stringify({ skeleton: { spine: '4.2' }, bones: [] }));
    await fs.writeFile(path.join(dir, 'nested', 'atlas.json'), JSON.stringify({ imagePath: 'page.png', SubTexture: [] }));
    await fs.writeFile(path.join(dir, 'native.rigby'), '');
    await fs.writeFile(path.join(dir, 'binary.skel'), '');
    const entries = await discoverProjects(dir);
    assert.deepEqual(entries.map(e => e.kind).sort(), ['Rigby2D work file', 'binary skeleton', 'skeleton JSON'].sort());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('compatibility runner refuses reports inside the input tree and existing reports', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigby-compat-test-'));
  const input = path.join(dir, 'input');
  const report = path.join(dir, 'report.json');
  try {
    await fs.mkdir(input);
    await fs.writeFile(report, 'keep');
    const run = promisify(execFile);
    const runner = path.resolve('scripts/compatibility.mjs');
    await assert.rejects(run(process.execPath, [runner, input, path.join(input, 'report.json')]), /outside the input directory/);
    await assert.rejects(run(process.execPath, [runner, input, report]), /EEXIST/);
    assert.equal(await fs.readFile(report, 'utf8'), 'keep');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
