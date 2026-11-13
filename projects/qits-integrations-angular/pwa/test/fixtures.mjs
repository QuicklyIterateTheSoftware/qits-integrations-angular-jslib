// Fixture apps for the pwa command's tests, under <repo>/tmp (git-ignored).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A valid, single-colour RGB PNG of `width` x `height`. */
export function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x40)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A fresh directory under <repo>/tmp, and a writer into it. */
export function tempApp(prefix) {
  mkdirSync('tmp', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'tmp', prefix));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, write };
}

export const ICONS = [
  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
];

/** The config every fixture starts from. */
export const CONFIG = {
  name: 'Offline Demo',
  shortName: 'Demo',
  description: 'An app that starts offline',
  icons: ICONS,
};

/**
 * An app opted in: a theme whose semantic tokens are declared in a local token file it imports
 * (`--color-accent` through a palette step and a plain variable, `--color-surface` through
 * `light-dark()`, dark overrides that must not count), the icons in `public/`, and `qits-pwa.json`.
 */
export function opted(prefix, config = CONFIG) {
  const app = tempApp(prefix);
  app.write('package.json', JSON.stringify({ name: 'pwa-demo' }));
  app.write('angular.json', '{}');
  app.write(
    'src/styles.css',
    ["@import 'tailwindcss';", "@import './tokens.css';", '', 'body { margin: 0; }', ''].join('\n'),
  );
  app.write(
    'src/tokens.css',
    [
      '@theme {',
      '  --color-brand-700: #1D4ED8;',
      '}',
      '@theme inline {',
      '  --color-surface: var(--surface);',
      '  --color-fg: var(--fg);',
      '  --color-accent: var(--accent);',
      '  --color-ghost: var(--nowhere);',
      '}',
      ':root {',
      '  --surface: light-dark(#ffffff, #111827);',
      '  --fg: #111827;',
      '  --accent: var(--color-brand-700);',
      '}',
      '@media (prefers-color-scheme: dark) {',
      '  :root { --accent: #93c5fd; }',
      '}',
      '',
    ].join('\n'),
  );
  app.write('public/icons/icon-192.png', png(192, 192));
  app.write('public/icons/icon-512.png', png(512, 512));
  app.write('qits-pwa.json', JSON.stringify(config, null, 2));
  return app;
}

/** An `ngsw.json` that prefetches `index` and `extra`, as `ngsw-config` writes it. */
export const ngswJson = (index = '/index.html', extra = ['/main.js']) =>
  JSON.stringify({
    configVersion: 1,
    index,
    assetGroups: [
      {
        name: 'app',
        installMode: 'prefetch',
        updateMode: 'prefetch',
        urls: [index, '/manifest.webmanifest', ...extra],
        patterns: [],
        cacheQueryOptions: { ignoreVary: true },
      },
    ],
    dataGroups: [],
    hashTable: {},
    navigationUrls: [],
  });

/** The `index.html` of a built app shell that links the manifest. */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Offline Demo</title>
    <base href="/" />
    <link rel="manifest" href="manifest.webmanifest" />
  </head>
  <body>
    <app-root></app-root>
    <script src="main.js" type="module"></script>
  </body>
</html>
`;
