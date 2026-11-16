// SPDX-License-Identifier: MIT OR Apache-2.0
// Validate projects with the editor loader and renderer. The input tree is read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { discoverProjects } from './compatibility-discovery.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const args = process.argv.slice(2);
const root = args[0] && path.resolve(args[0]);
const report = args[1] && path.resolve(args[1]);
if (!root || !report) throw new Error('Usage: node scripts/compatibility.mjs <directory> <report.json>');
const canonicalRoot = await fs.realpath(root);
const within = (base, target) => { const r = path.relative(base, target); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
const reportDir = await fs.realpath(path.dirname(report));
const reportTarget = await fs.realpath(report).catch(() => path.join(reportDir, path.basename(report)));
if (within(canonicalRoot, reportTarget)) throw new Error('The report must be outside the input directory.');
const entries = await discoverProjects(canonicalRoot);
const reportFile = await fs.open(report, 'wx');
await reportFile.close();
const vite = await createViteServer({ root: app, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8">'); return; }
  vite.middlewares(req, res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results = [];
try {
  for (const entry of entries) {
    const page = await browser.newPage();
    const errors = [];
    const consoleWarnings = [];
    page.on('pageerror', e => {
      if (e.stack?.includes('/@vite/client')) consoleWarnings.push(e.message);
      else errors.push(e.message);
    });
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleWarnings.push(message.text()); });
    await page.exposeFunction('readCompatibilityFile', async p => {
      const resolved = await fs.realpath(path.resolve(p));
      if (!within(canonicalRoot, resolved)) throw new Error('Resource is outside the input directory');
      return (await fs.readFile(resolved)).toString('base64');
    });
    await page.exposeFunction('listCompatibilityDirectory', async p => {
      const resolved = await fs.realpath(path.resolve(p));
      if (!within(canonicalRoot, resolved)) throw new Error('Resource is outside the input directory');
      return fs.readdir(resolved);
    });
    let result;
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      let timer;
      try {
        result = await Promise.race([
          page.evaluate(async file => (await import('/scripts/compatibility-page.js')).validate(file), entry.file),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Validation timed out')), 120000); }),
        ]);
      } finally { clearTimeout(timer); }
    } catch (e) { result = { result: 'UNVERIFIED', reason: `Browser validation could not complete: ${e.message}` }; }
    result.errors = errors;
    result.consoleWarnings = consoleWarnings;
    if (errors.length && result.result === 'UNVERIFIED') {
      result.result = 'PARTIAL';
      result.reason = 'Browser page reported an error';
    }
    results.push({ ...entry, ...result });
    await page.close();
    await fs.writeFile(report, JSON.stringify({ root: canonicalRoot, total: entries.length, results }, null, 2));
    console.log(`${results.length}/${entries.length}: ${result.result}`);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await vite.close(); }
const counts = Object.fromEntries([...new Set(results.map(r => r.result))].map(k => [k, results.filter(r => r.result === k).length]));
console.log(JSON.stringify(counts));
if (results.some(r => r.result !== 'PASS')) process.exitCode = 1;
