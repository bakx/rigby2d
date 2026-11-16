// SPDX-License-Identifier: MIT OR Apache-2.0
/** Distinguish known unsupported or invalid inputs from later resource failures. */
export function classifyLoadError(reason, loaded) {
  if (loaded) return 'PARTIAL';
  if (/not supported|unsupported/i.test(reason)) return 'UNSUPPORTED';
  if (/invalid JSON|not a Rigby2D work file.*missing/i.test(reason)) return 'INVALID';
  return 'FAIL';
}
