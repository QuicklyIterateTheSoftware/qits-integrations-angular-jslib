/**
 * The file checks of `qits-angular pwa --check` (ticket qits-2152), steps 1-4: the committed
 * manifest is fresh, the built one is installable, the index links it, and the worker caches the
 * app shell. Each returns the failures it found, one line each; none means it passed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PwaError, buildManifest } from './manifest.mjs';

/** The displays a browser installs an app for. */
export const INSTALLABLE_DISPLAYS = ['standalone', 'fullscreen', 'minimal-ui'];

/** The icon sizes an installable manifest must have as PNGs. */
export const REQUIRED_ICON_SIZES = ['192x192', '512x512'];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size from its IHDR chunk, or undefined when `bytes` is not a PNG. */
export function pngSize(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const isPng = (icon) =>
  icon?.type === 'image/png' || /\.png$/i.test(String(icon?.src ?? '').split(/[?#]/)[0]);
const sizesOf = (icon) =>
  String(icon?.sizes ?? '')
    .split(/\s+/)
    .filter(Boolean);
/** A manifest URL as a path inside the build output: no query or fragment, no leading `/` or `./`. */
const local = (url) =>
  posix.normalize(String(url).split(/[?#]/)[0].replace(/^\/+/, '')).replace(/^(\.\/)+/, '');

/**
 * Step 1: the committed manifest (`config.output`) holds what `--write` would write now. Compared
 * as JSON, so a formatter's whitespace does not make it stale.
 */
export function checkFresh(root, config) {
  let expected;
  try {
    expected = buildManifest(root, config);
  } catch (error) {
    if (error instanceof PwaError) return [`fresh: ${error.message}`];
    throw error;
  }
  let committed;
  try {
    committed = JSON.parse(readFileSync(resolve(root, config.output), 'utf8'));
  } catch {
    return [`fresh: ${config.output} is missing or not JSON, run qits-angular pwa --write`];
  }
  return isDeepStrictEqual(committed, expected)
    ? []
    : [`fresh: ${config.output} is stale, run qits-angular pwa --write`];
}

/**
 * Step 2: `<dist>/<the output's file name>` parses and is installable: a name, `start_url`, an
 * installable `display`, and a 192x192 and a 512x512 PNG icon; every icon is in `dist`, and each
 * PNG's IHDR size is one of its `sizes`.
 */
export function checkManifest(dist, config) {
  const name = basename(config.output);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dist, name), 'utf8'));
  } catch (error) {
    return [
      error.code === 'ENOENT'
        ? `manifest: ${name} is not in ${dist}`
        : `manifest: ${name} is not JSON: ${error.message}`,
    ];
  }
  const failures = [];
  if (!manifest.name && !manifest.short_name)
    failures.push(`manifest: ${name} has neither name nor short_name`);
  if (!manifest.start_url) failures.push(`manifest: ${name} has no start_url`);
  if (!INSTALLABLE_DISPLAYS.includes(manifest.display))
    failures.push(
      `manifest: ${name} has display ${JSON.stringify(manifest.display ?? null)}, not one of ${INSTALLABLE_DISPLAYS.join(', ')}`,
    );
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  for (const size of REQUIRED_ICON_SIZES) {
    if (!icons.some((icon) => isPng(icon) && sizesOf(icon).includes(size)))
      failures.push(`manifest: ${name} has no ${size} PNG icon`);
  }
  for (const icon of icons) {
    const path = join(dist, local(icon?.src ?? ''));
    if (!icon?.src || !existsSync(path)) {
      failures.push(`manifest: icon ${icon?.src ?? '(no src)'} is not in ${dist}`);
      continue;
    }
    if (!isPng(icon)) continue;
    const size = pngSize(readFileSync(path));
    if (!size) failures.push(`manifest: icon ${icon.src} is not a PNG`);
    else if (
      !sizesOf(icon).includes('any') &&
      !sizesOf(icon).includes(`${size.width}x${size.height}`)
    )
      failures.push(
        `manifest: icon ${icon.src} is ${size.width}x${size.height}, its sizes say ${icon.sizes}`,
      );
  }
  return failures;
}

/** The app's index in `dist`: `index.html`, or `index.csr.html` for an SSR build. */
export function findIndex(dist) {
  return ['index.html', 'index.csr.html'].find((file) => existsSync(join(dist, file)));
}

/** Each tag's attributes, lower-cased names. */
function attributes(tag) {
  const found = {};
  for (const m of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
    found[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return found;
}

/** Step 3: the index has a `<link rel="manifest">` to the manifest. */
export function checkLinked(dist, config) {
  const index = findIndex(dist);
  if (!index) return [`linked: neither index.html nor index.csr.html is in ${dist}`];
  const html = readFileSync(join(dist, index), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const name = basename(config.output);
  const linked = [...html.matchAll(/<link\b([^>]*)>/gi)]
    .map((m) => attributes(m[1]))
    .some(
      (link) =>
        (link.rel ?? '').toLowerCase().split(/\s+/).includes('manifest') &&
        posix.basename(local(link.href ?? '')) === name,
    );
  return linked ? [] : [`linked: ${index} has no <link rel="manifest" href="${name}">`];
}

/**
 * Step 4: `ngsw-worker.js` and `ngsw.json` are built, `ngsw.json`'s `index` is `/index.html` (or
 * `/index.csr.html`, under the base href when there is one), and
 * a `prefetch` asset group holds it, so the shell is cached at install.
 */
export function checkWorker(dist) {
  const failures = [];
  if (!existsSync(join(dist, 'ngsw-worker.js')))
    failures.push(`worker: ngsw-worker.js is not in ${dist}`);
  let control;
  try {
    control = JSON.parse(readFileSync(join(dist, 'ngsw.json'), 'utf8'));
  } catch (error) {
    failures.push(
      error.code === 'ENOENT'
        ? `worker: ngsw.json is not in ${dist} (add "serviceWorker": "ngsw-config.json" to the production build)`
        : `worker: ngsw.json is not JSON: ${error.message}`,
    );
    return failures;
  }
  // `/index.html`, under the base href when the app has one (`/app/index.html`).
  const index = control.index;
  if (typeof index !== 'string' || !/^\/(?:.*\/)?index(?:\.csr)?\.html$/.test(index)) {
    failures.push(`worker: ngsw.json has index ${JSON.stringify(index ?? null)}, not /index.html`);
    return failures;
  }
  const prefetched = (control.assetGroups ?? []).some(
    (group) => group.installMode === 'prefetch' && (group.urls ?? []).includes(index),
  );
  if (!prefetched) failures.push(`worker: no prefetch asset group in ngsw.json holds ${index}`);
  return failures;
}
