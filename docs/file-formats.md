# File formats

| File | What it is | Made by |
| --- | --- | --- |
| `.rigby` | The work file: a ZIP with `project.json` (the whole document) and `images/*.png`, plus `audio/*` for audio tracks. | *File ▸ Save* |
| `.json` | Skeleton JSON, format 3.8, 4.2 or 4.3. | *Export ▸ JSON + atlas* |
| `.skel` | Binary skeleton, formats 4.0–4.3 (exports are always 4.3). | *Export ▸ Binary .skel + atlas* |
| `.atlas` + `.png` / `.webp` / `.ktx2` | Texture atlas: the packed images and where each one sits. Pages are PNG (default), WebP, or KTX2 (Basis Universal ETC1S or UASTC, GPU-compressed; see [Export](export.md#texture-pages)). | Every export |
| `.scene.json` | A scene for runtimes: actors, clips and depths, naming the stage and character skeletons next to it. | *Export ▸ Scene for runtimes* |

## The `.rigby` work file

One self-contained file, like a `.blend`: bones, slots, skins, constraints, events, animations,
images, and the editor-only data (workspace, film output settings, poses, face controls, audio
tracks). Open it with *File ▸ Open*. Keep it in version control or back it up; exports can always be
made again from it.

## Skeleton JSON and `.skel`

The interchange formats runtimes load. Bones are listed so parents come first, slots are in draw
order, attachments live in skins, and animations hold timelines with keys relative to the setup
pose. Images come from the `.atlas` or from loose files in the skeleton's `images` folder. Atlas
pages can be PNG, WebP or KTX2: the editor and the MCP tools decode all three (KTX2 through the
Basis Universal transcoder), and honour the atlas `pma` line and the KTX2 premultiplied flag.
If an atlas names a missing PNG page and a same-name KTX2 page is present, the editor and MCP
tools use the compressed page after checking its dimensions and report the substitution. The
declared page always takes priority when present.

Imported Spine 4.0 animations use the source runtime's sampled Bézier interpolation and retain
setup values before the first key. Newly authored Rigby2D curves continue to use cubic interpolation.

Proportional path spacing follows Spine's fill fraction: `0` puts constrained bones at the path
start and `1` fills the path. Older Rigby2D previews treated this value as a gap fraction, so rigs
authored against that preview may need their proportional spacing adjusted. Existing files are not
changed automatically.

Atlas trimming leaves images used by meshes untrimmed to keep their UVs inside their region. WebP
pages use exact lossless encoding, including RGB values of transparent pixels; reading WebP in the
Node tools still requires FFmpeg.

The editor reads PNG, JPEG, WebP and Basis Universal KTX2 atlas pages. Node-based image extraction
and sprite-sheet exports support PNG and KTX2 pages, and WebP pages when FFmpeg is on PATH. The editor can export KTX2 pages with PNG fallbacks; the CLI supports `--texture ktx2` with ETC1S or UASTC, mipmaps, and optional PNG fallback. The KTX2 encoder and transcoder support Basis Universal textures. Some
binary attachment and animation options remain unsupported; these report an error instead of being
silently omitted. Exported data should be checked in its target runtime.

To check a collection with the editor's loader and WebGL renderer, install the development
dependencies and Playwright Chromium, then run:

```sh
node scripts/compatibility.mjs <input-directory> <report.json>
```

The report must be outside the input directory and must not already exist. The runner samples poses
and renders frames, but marks results requiring visual and motion review as unverified; it returns a
nonzero exit code when any entry is not verified.

## Scene manifest (`.scene.json`)

```json
{
  "rigbyScene": 1,
  "stage": "street.json",
  "focal": 1000,
  "depth": { "hills": 500 },
  "actors": [
    {
      "id": "nila", "name": "NILA", "bone": "NILA", "slot": "NILA",
      "skeleton": "street.nila.json", "skin": null, "flip": false, "ground": -276,
      "clips": { "meet": [{ "animation": "wave", "start": 0, "in": 0, "out": null, "speed": 1, "loops": 1, "blend": 0 }] }
    }
  ]
}
```

`stage` and `skeleton` are relative to the manifest; each skeleton's atlas has the same name with
`.atlas`. An actor stands on the stage bone `bone` (raised by `ground`, mirrored when `flip`) and is
drawn at the stage slot `slot`. Clips are listed per shot (stage animation): `in`/`out` in
animation seconds (`out` null = the end), `loops` 0 = until the next clip, `blend` = crossfade
seconds from the clip before. `depth` moves top-level stage bones for parallax: a layer at depth
`z` follows `focal / (focal + z)` of the camera bone's motion.

## Coordinates and units

- Units are pixels of the artwork at scale 1.
- Y points **up** (runtimes for Y-down engines, such as Godot, convert).
- Angles are in degrees, counterclockwise.
- Times are in seconds.
