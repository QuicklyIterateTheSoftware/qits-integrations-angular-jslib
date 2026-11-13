/**
 * `qits-angular pwa --write | --check`: the installable offline shell's build half (ticket
 * qits-2152).
 *
 * - `--write` writes the web manifest from `qits-pwa.json`, its colours resolved from the app's
 *   theme tokens (`manifest.mjs`).
 * - `--check --dist <dir>` fails a build that would not install or start offline: the committed
 *   manifest is stale, the built one is not installable, the index does not link it, the worker
 *   does not cache the shell (`checks.mjs`), or the app does not start offline in Chromium
 *   (`offline.mjs`).
 *
 * A repository without `qits-pwa.json` has not opted in; it runs neither.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkFresh, checkLinked, checkManifest, checkWorker, findIndex } from './checks.mjs';
import {
  DEFAULTS,
  DEFAULT_CONFIG,
  PwaError,
  buildManifest,
  manifestText,
  readConfig,
} from './manifest.mjs';
import { checkOfflineStart } from './offline.mjs';

/** Seconds the offline start waits at each step, unless `--timeout` says otherwise. */
export const DEFAULT_TIMEOUT = 60;

export const USAGE = `Usage: qits-angular pwa --write | --check --dist <dir> [options]

The installable offline shell of an app that opts in with a committed
${DEFAULT_CONFIG} beside angular.json (see the @qits/angular README).

--write writes the web manifest (${DEFAULTS.output} unless the config's
"output" says otherwise). Its theme_color and background_color are the
config's semantic token names ("${DEFAULTS.themeColor}", "${DEFAULTS.backgroundColor}" by default), resolved to
their light value through the app's theme (${DEFAULTS.theme} and its
@imports). A token that is not a semantic @theme colour, or that leads to
no literal colour, exits 1 and names it.

--check fails (exit 1) a build that does not install or start offline, one
line per failure:
  fresh          the committed manifest is what --write writes now
  manifest       <dir>/<manifest> parses, has a name, start_url, an
                 installable display and 192x192 and 512x512 PNG icons
                 whose files are in <dir> at their stated sizes
  linked         index.html (index.csr.html) links it with rel="manifest"
  worker         ngsw-worker.js and ngsw.json are built, and a prefetch
                 asset group holds the index
  offline start  served from 127.0.0.1 in Playwright's Chromium, a worker
                 takes control and caches the shell, and offline the
                 shell element (config "shell", default ${DEFAULTS.shell}) has a child.
                 Needs playwright and Chromium: the app recipe's renderer image.

  --write              Write the manifest.
  --check              Check a build; needs --dist.
  --dist <dir>         The built browser output (e.g. dist/<app>/browser).
  --config <file>      The config (default: ${DEFAULT_CONFIG}).
  --root <dir>         The project root (default: the current directory).
  --timeout <seconds>  How long the offline start waits at each step
                       (default: ${DEFAULT_TIMEOUT}).
`;

/**
 * Runs the command. `args` are the arguments after `pwa`. Resolves the exit code.
 *
 * `io.offlineStart` replaces step 5 (the node tests, which have no browser, pass a stand-in).
 *
 * @param {string[]} args
 * @param {{ cwd?: string, out?: (line: string) => void, err?: (line: string) => void,
 *   offlineStart?: typeof checkOfflineStart }} [io]
 * @returns {Promise<number>}
 */
export async function pwa(args, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  let mode;
  let root = io.cwd ?? process.cwd();
  let config = DEFAULT_CONFIG;
  let dist;
  let timeout = DEFAULT_TIMEOUT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--write' || arg === '--check') {
      if (mode && mode !== arg) {
        err('qits-angular pwa: give --write or --check, not both');
        return 2;
      }
      mode = arg;
    } else if (arg === '--root' && i + 1 < args.length) root = resolve(root, args[++i]);
    else if (arg === '--config' && i + 1 < args.length) config = args[++i];
    else if (arg === '--dist' && i + 1 < args.length) dist = args[++i];
    else if (arg === '--timeout' && i + 1 < args.length) {
      timeout = Number(args[++i]);
      if (!(timeout > 0)) {
        err(`qits-angular pwa: --timeout takes a number of seconds, not ${args[i]}`);
        return 2;
      }
    } else if (arg === '--help' || arg === '-h') {
      out(USAGE);
      return 0;
    } else {
      err(`qits-angular pwa: unknown argument ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  if (!mode) {
    err(USAGE);
    return 2;
  }
  if (mode === '--check' && !dist) {
    err('qits-angular pwa: --check needs --dist <dir>, the built browser output');
    return 2;
  }

  let settings;
  try {
    settings = readConfig(root, config);
  } catch (error) {
    if (!(error instanceof PwaError)) throw error;
    err(`qits-angular pwa: ${error.message}`);
    return 1;
  }

  if (mode === '--write') {
    let text;
    try {
      text = manifestText(buildManifest(root, settings));
    } catch (error) {
      if (!(error instanceof PwaError)) throw error;
      err(`qits-angular pwa: ${error.message}`);
      return 1;
    }
    const output = resolve(root, settings.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text);
    out(`wrote ${settings.output}`);
    return 0;
  }

  const directory = resolve(root, dist);
  if (!existsSync(directory)) {
    err(`qits-angular pwa: the build output ${dist} does not exist (build first)`);
    return 1;
  }
  // Without an index there is nothing to start; `linked` already names that.
  const offlineStart = findIndex(directory)
    ? (io.offlineStart ?? checkOfflineStart)
    : async () => [];
  const failures = [
    ...checkFresh(root, settings),
    ...checkManifest(directory, settings),
    ...checkLinked(directory, settings),
    ...checkWorker(directory),
    ...(await offlineStart({
      root,
      dist: directory,
      shell: settings.shell,
      timeout: timeout * 1000,
    })),
  ];
  for (const failure of failures) err(failure);
  if (failures.length > 0) return 1;
  out(`${dist} installs and starts offline`);
  return 0;
}
