// SPDX-License-Identifier: MIT OR Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectKind } from '../src/editor/io.js';

/** Discover editor entry points without traversing symbolic links. */
export async function discoverProjects(root) {
  const entries = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await walk(file);
      else if (e.isFile() && /\.(?:json|rigby\d?|skel)$/i.test(e.name)) {
        const text = /\.json$/i.test(e.name) ? await fs.readFile(file, 'utf8').catch(() => null) : null;
        const kind = projectKind(e.name, text);
        if (kind) entries.push({ file, kind: kind.kind });
      }
    }
  }
  await walk(root);
  return entries;
}
