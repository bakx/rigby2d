// SPDX-License-Identifier: MIT OR Apache-2.0
import { createEditTools } from './edits.js';
import { createFilmTools } from './film.js';
import { createRiggingTools } from './rigging.js';
import { createScriptTools } from './scripting.js';
import { createSceneTools } from './scene.js';
import { createTools } from './tools.js';

/** Tools offered by the stdio server, bundled extension, and generated reference. */
export function createToolRegistry(workspace) {
  return [
    ...createTools(workspace),
    ...createEditTools(workspace),
    ...createFilmTools(workspace),
    ...createRiggingTools(workspace),
    ...createSceneTools(workspace),
    ...createScriptTools(workspace),
  ];
}
