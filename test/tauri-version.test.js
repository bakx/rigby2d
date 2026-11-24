// SPDX-License-Identifier: MIT OR Apache-2.0
// Tauri's bundler rejects plugin packages whose JavaScript and Rust minor versions differ.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Tauri JavaScript plugins match their Rust crate major and minor versions', () => {
  const npm = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const cargo = readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8');
  const crates = new Map([...cargo.matchAll(/^name = "(tauri-plugin-[^"]+)"\r?\nversion = "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  for (const [name, metadata] of Object.entries(npm.packages)) {
    if (!name.startsWith('node_modules/@tauri-apps/plugin-')) continue;
    const crate = `tauri-${name.split('/').at(-1)}`;
    const rust = crates.get(crate);
    assert.ok(rust, `${crate} is missing from Cargo.lock`);
    const minor = (version) => version.split('.').slice(0, 2).join('.');
    assert.equal(minor(metadata.version), minor(rust), `${crate}: npm ${metadata.version}, Rust ${rust}`);
  }
});
