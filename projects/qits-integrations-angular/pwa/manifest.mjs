/**
 * The web manifest an app's `qits-pwa.json` describes (ticket qits-2152): the config, its defaults,
 * and the manifest `qits-angular pwa --write` writes, its colours resolved from the app's theme.
 *
 * A manifest cannot name a CSS variable, so `themeColor` and `backgroundColor` are semantic token
 * names (`accent`, `surface`) resolved at build time to their light value, through the same theme
 * reader the `qits/theme-colors` lint rule uses.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chain, loadTheme } from '../eslint/rules/theme-colors.mjs';

/** The committed config, beside `angular.json`. */
export const DEFAULT_CONFIG = 'qits-pwa.json';

/** Every field's default; `name` and `shortName` have none. */
export const DEFAULTS = Object.freeze({
  startUrl: './',
  scope: './',
  display: 'standalone',
  icons: [],
  themeColor: 'accent',
  backgroundColor: 'surface',
  theme: 'src/styles.css',
  output: 'public/manifest.webmanifest',
  shell: 'app-root',
});

/** A failure the command reports as one line and exit 1. */
export class PwaError extends Error {}

/**
 * Reads `config` (relative to `root`) and fills in the defaults. Throws a {@link PwaError} naming the
 * file when it is missing, is not JSON, or lacks `name` / `shortName`.
 */
export function readConfig(root, config = DEFAULT_CONFIG) {
  let text;
  try {
    text = readFileSync(resolve(root, config), 'utf8');
  } catch {
    throw new PwaError(`${config} not found (the app opts in to the PWA checks by adding it)`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new PwaError(`${config} is not JSON: ${error.message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new PwaError(`${config} must hold an object`);
  for (const field of ['name', 'shortName']) {
    if (typeof json[field] !== 'string' || !json[field].trim())
      throw new PwaError(`${config} has no "${field}"`);
  }
  const icons = json.icons ?? DEFAULTS.icons;
  if (!Array.isArray(icons)) throw new PwaError(`${config}: "icons" must be a list`);
  icons.forEach((icon, i) => {
    for (const field of ['src', 'sizes', 'type']) {
      if (typeof icon?.[field] !== 'string' || !icon[field])
        throw new PwaError(`${config}: icons[${i}] has no "${field}"`);
    }
  });
  return { ...DEFAULTS, ...json, icons };
}

/**
 * The light value of the semantic token `name` in `theme` (a `loadTheme()` result). Throws a
 * {@link PwaError} naming the field and token when it is not a semantic `@theme` colour, or leads to
 * no literal colour.
 */
export function resolveToken(theme, field, name) {
  const token = String(name).replace(/^--color-/, '');
  if (!theme.found) throw new PwaError(`${field}: the theme ${theme.display} was not found`);
  if (!theme.semantic.has(token))
    throw new PwaError(
      `${field}: "${token}" is not a semantic @theme colour of ${theme.display} (one of: ${[...theme.semantic].join(', ') || 'none'})`,
    );
  const { literal } = chain(theme, `var(--color-${token})`);
  if (!literal || /var\(/i.test(literal))
    throw new PwaError(
      `${field}: "${token}" does not resolve to a literal colour in ${theme.display}`,
    );
  return literal;
}

/** `value` with every object's keys sorted, so the same manifest is always the same text. */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}

/** The manifest object `config` (a `readConfig()` result) describes, its colours from the theme. */
export function buildManifest(root, config) {
  const theme = loadTheme(root, config.theme);
  const manifest = {
    name: config.name,
    short_name: config.shortName,
    ...(config.description !== undefined && { description: config.description }),
    start_url: config.startUrl,
    scope: config.scope,
    display: config.display,
    icons: config.icons.map(({ src, sizes, type, purpose }) => ({
      src,
      sizes,
      type,
      ...(purpose !== undefined && { purpose }),
    })),
    theme_color: resolveToken(theme, 'themeColor', config.themeColor),
    background_color: resolveToken(theme, 'backgroundColor', config.backgroundColor),
  };
  return sorted(manifest);
}

/** The manifest's text as `--write` writes it: sorted keys, two-space JSON, a final newline. */
export const manifestText = (manifest) => `${JSON.stringify(sorted(manifest), null, 2)}\n`;
