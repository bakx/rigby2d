// SPDX-License-Identifier: MIT OR Apache-2.0
// Export ▸ JSON / binary .skel + atlas: the texture page options (PNG, WebP or KTX2), then the save picker.
import { KTX2_DEFAULTS } from '../core/ktx2.js';
import { t } from './i18n.js';
import { button, checkbox, dialog, fieldRow, fields, hint } from './ui.js';
import { h, select } from './widgets.js';

/** The last choice, kept for the session. */
const last = { format: 'png', pma: false, ...KTX2_DEFAULTS, fallback: 'none' };

const FORMATS = [
  ['png', 'PNG'],
  ['webp', 'WebP'],
  ['ktx2', 'KTX2 (Basis Universal, GPU compressed)'],
];

/** `kind` is 'json' (with its format `version`) or 'skel'. The export itself runs in app.js. */
export function openExportDialog(app, kind, version) {
  const choice = { ...last };
  const { body, close, setFooter } = dialog({
    title: kind === 'skel' ? t('Export binary skeleton') : t('Export skeleton JSON {version}', { version }),
    subtitle: t('The skeleton with its .atlas and texture pages, for a game runtime.'),
    className: 'export-dialog',
  });
  const set = (key) => (v) => {
    choice[key] = v;
    draw();
  };
  const number = (key, min, max) =>
    h('input', {
      type: 'number',
      class: 'frame-input',
      min,
      max,
      value: choice[key],
      onkeydown: (e) => e.stopPropagation(),
      onchange: (e) => set(key)(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min)))),
    });

  function draw() {
    const ktx2 = choice.format === 'ktx2';
    body.replaceChildren(
      fields(
        ...fieldRow(t('Texture format'), select(FORMATS, choice.format, set('format'))),
        ...(ktx2
          ? [
              ...fieldRow(t('Codec'), select([['etc1s', t('ETC1S (smallest, lossy)')], ['uastc', t('UASTC (near lossless, larger)')]], choice.codec, set('codec'))),
              ...fieldRow(t('Quality'), number('quality', 1, 255), h('span', { class: 'ui-field-label' }, '1–255')),
              ...fieldRow(t('Fallback pages'), select([['none', t('None')], ['png', 'PNG'], ['webp', 'WebP']], choice.fallback, set('fallback'))),
            ]
          : []),
      ),
      h(
        'div',
        { class: 'checks' },
        checkbox(t('Premultiplied alpha (pma)'), choice.pma, set('pma')),
        ktx2 ? checkbox(t('Mipmaps'), choice.mipmaps, set('mipmaps')) : null,
        ktx2 && choice.codec === 'uastc' ? checkbox(t('Zstandard supercompression'), choice.zstd, set('zstd')) : null,
      ),
      hint(
        ktx2
          ? t('Runtimes transcode KTX2 pages to ASTC, BC7 or ETC2; use premultiplied alpha.')
          : t('Pages larger than 8192 px overflow into <name>_2.<ext>.'),
      ),
    );
  }
  draw();
  setFooter([
    button(t('Cancel'), { onclick: () => close() }),
    button(t('Export…'), {
      kind: 'primary',
      icon: 'download',
      onclick: () => {
        Object.assign(last, choice);
        close();
        const texture = { ...choice };
        if (kind === 'skel') app.exportSkeletonBinary(texture);
        else app.exportSkeletonJson(version, texture);
      },
    }),
  ]);
}
