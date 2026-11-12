# Rigby2D automation guide

Rigby2D edits 2D skeletal animation for games and film. Start by reading the project with
`inspect_project`, then `describe_rig` and `describe_animation`. These tools operate on files;
they do not change an already-open editor document. Reload that document after external edits.

## Coordinates and files

- World Y points up. Rotations are counter-clockwise degrees. Times are seconds.
- Setup transforms are relative to the parent bone. Animation rotate/translate/shear keys are
  offsets from setup; scale keys multiply setup scale. `space: "world"` on `set_bone_key`
  accepts absolute translate/rotate values, converted using the evaluated pose at that time.
  Constraints can still override the keyed bone: key the IK target or reduce constraint mix.
- AutoRig's `l` means the character's left, on the image's right for a front-facing character.
- Joint hints are **canvas pixels, origin top left** at the MCP boundary. Example:
  `{"joints":{"shoulder_l":[347,300],"elbow_l":[398,520],"wrist_l":[430,728]}}`.
  Hints may also be stored in `<PSD basename>.joints.json`, as that object or its inner map, or
  drawn as small PSD layers named `joint:shoulder_l` or `@shoulder_l` (the layer's centre is the
  joint; these layers are not imported as art). Arguments beat the sidecar, which beats layers. The core `autoRig` function takes **world** points.
- Every MCP input/output must be under a configured workspace root. Output folders must exist.
  A `.rigby` work file is a ZIP containing `project.json`, `images/*.png`, and optional audio
  and actor files. Use the tools rather than hand-editing the archive.
- Editors save in the input format, in place unless `output` is specified. New outputs are
  protected against replacement unless `overwrite: true`. `batch_edit` validates its operations,
  edits one in-memory project, then saves once; any failure leaves the original file unchanged.

## Capabilities

| Task | MCP | Python `rigby` / add-ons | Editor |
| --- | --- | --- | --- |
| Bones, slots, animations and keys | Editing tools, `batch_edit`, world keys | Bone/Slot/Animation objects; `space="world"` | Yes |
| IK, transform, path, physics, slider | `add_constraint`, `set_constraint`, `delete_constraint`, `set_constraint_key` | `constraints`, `add_constraint`, `Constraint.set/delete`, `Animation.key_constraint` | Yes |
| Region attachments and skins | `add_attachment`, `replace_image`, `add_skin`, `set_skin_attachment`, `delete_skin` | `Slot.add_attachment` using an existing project image; `add_skin`, `Skin.set_attachment/delete` | Yes |
| Meshes and weights | `make_mesh` outline/grid, `auto_weight`, `set_weights`, `smooth_weights`, `merge_parts` (join rigid pieces into one bending mesh) | `Slot.make_mesh`, `Mesh.data/vertices/triangles/weights`, weight methods | Yes, including manual vertex editing |
| Events | `add_event`, `set_event_key` | `add_event`, `events`, `Animation.key_event` | Yes |
| PSD rigging and art updates | `detect_parts`, `autorig`, `update_art` | Use MCP for filesystem/image import | AutoRig and image tools |
| Preview and export | `render_preview`, `render_video`, `export_sprite_sheet` | Use MCP or editor | Character and scene rendering |
| Physics baking | `bake_physics` | Use MCP | Live simulation |
| Quality checks | `validate_project`, `lint_animations` | Rig report add-on | Visual preview |

Python runs in a sandbox with the standard library, without network or host file access.
Outline meshes in Python accept explicit alpha data (`width`, `height`, `data`); grid meshing
needs no pixels. Import new image files through MCP or the editor first.

## Recommended loop

1. Import layered PSD art. Run `detect_parts`; correct `roles`/`sides` and supply known `joints`.
2. Run `autorig` to a new `.rigby`; inspect the resulting bones, slots, skins and constraints.
3. Use `batch_edit` for one logical change: slot defaults, animation creation, keys, constraint
   mix/bend, attachments and mesh weights. File arguments are omitted inside operations.
4. Use `set_ik_target_key` for a world-space hand/foot target. `world_to_local` converts a point
   into a named bone's coordinates without editing anything.
5. Run `render_preview` with `fps: 15`, `layout: "grid"`, `scale: 0.5`, and an output PNG.
   Inspect the image, then use `validate_project` and `lint_animations` before export.
6. When art changes, use `update_art` with `mode: "images"` (default). It matches layer names
   to attachment/image names, preserves topology and weights, and rebinds mesh vertices to the
   new layer rectangle. `add_missing` also attaches new layers to matching AutoRig bones.
   Review `unmatchedLayers` and `slotsWithoutLayer`. Joint locations do not change on re-import.

## Defaults and limitations

Physics motion weights `x`, `y`, `rotate`, `scaleX`, `shearX` start at **0**. For swinging hair,
set `rotate: 1`. Defaults: inertia 0.5, strength 100, damping 0.85, mass 1, wind/gravity 0,
limit 5000, simulation fps 60, mix 1. Global flags opt into skeleton-wide physics keys.
Physics is per bone; adding a chain returns a constraint name for each bone. Key those names.

`set_skin_attachment` overrides the same attachment key as the default skin. A slot draws one
attachment at a time; different slots can draw simultaneously. Skins fall back to default
attachments where they have no override. `add_attachment` does not change slot visibility.
Weight edits report removed deform timelines if their influence layout changes.

`render_preview` writes one PNG or GIF; it returns the absolute path. Explicit preview `times`
must be ascending and cannot be combined with `fps`. GIF uses uniform `fps`.
Video and WebP import require FFmpeg on PATH. Video supports character clips, project framing,
camera zoom, background and audio; use the editor for scenes. Render size/frame limits guard
against unbounded allocations. No FFmpeg executable is bundled.

`bake_physics` defaults to disabling selected constraints only in the baked clip. Loop mode
prerolls one period and closes the endpoint. It refuses a bone simultaneously driven by another
constraint family; arbitrary mixed-constraint inversion and key reduction are not implemented.
Baked results match simulation at the requested sample times; use a sufficient fps for motion.

Lint findings are advisory. Loop checks default to idle/breathe/walk/run/loop names; pass `loop`
explicitly for other clips. Hidden slots can be intentional. Jump thresholds use world units
and degrees. Structural validity remains a separate result.

## Source checks

The shared authoring/runtime code is in `src/core`; MCP adapters in `src/mcp`; Python's bridge
and module in `src/editor/scripting`. Run `npm ci`, `npm test`, and `npm run web:build` after
changes. Regenerate the tool reference with `node site/docs/generate.js` after tool changes.
