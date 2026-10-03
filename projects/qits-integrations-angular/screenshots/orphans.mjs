/**
 * Finds reference screenshots that no screenshot test uses any more. Vitest writes references, but
 * never deletes one, so a deleted spec or a renamed screenshot leaves its image behind.
 *
 * A reference is `<dir>/<screenshotDirectory>/<spec file name>/<name>-<browser>-<platform>.png`
 * (Vitest's default layout). Its owner is the spec `<dir>/<spec file name>`. It is an orphan when:
 *
 * - `spec-gone`: the owner does not exist. This needs no test run.
 * - `no-spec`: it lies directly in the screenshot directory, so no spec owns it.
 * - `unused`: the record of a browser run says the owner ran completely (every test passed), its
 *   file has not changed since, and it did not ask for this reference.
 *
 * A reference whose owner exists but has no such record is not judged: its spec is `unchecked`.
 */
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_SCREENSHOT_DIRECTORY, fileHash, readRecord } from './record.mjs';

/** Directories never searched: dependencies, build output, and dot-directories (`.git`, …). */
const SKIP = new Set(['node_modules', 'dist', 'tmp', 'out-tsc', 'coverage']);

/** Every file under `dir`, relative to it, with `/` separators. */
function filesUnder(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...filesUnder(join(dir, entry.name), path));
    else files.push(path);
  }
  return files;
}

/** Every screenshot directory under `root`, relative to it. */
function screenshotDirectories(root, name, prefix = '') {
  const found = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === name) found.push(path);
    else found.push(...screenshotDirectories(root, name, path));
  }
  return found;
}

/**
 * @param {{ root: string, record: string }} options `record`: the record's path, absolute or
 *   relative to `root`.
 * @returns {{
 *   orphans: {
 *     path: string,
 *     directory: string,
 *     spec: string | null,
 *     reason: 'spec-gone' | 'no-spec' | 'unused',
 *   }[],
 *   unchecked: { spec: string, why: string }[],
 *   recordProblem: string | null,
 * }}
 */
export function findOrphans({ root, record: recordPath }) {
  const { record, problem } = readRecord(
    isAbsolute(recordPath) ? recordPath : join(root, recordPath),
  );
  const directoryName = record?.screenshotDirectory ?? DEFAULT_SCREENSHOT_DIRECTORY;
  const orphans = [];
  const unchecked = [];

  for (const directory of screenshotDirectories(root, directoryName).sort()) {
    const parent = directory.slice(0, -directoryName.length).replace(/\/$/, '');
    const byOwner = new Map();
    for (const file of filesUnder(join(root, directory)).sort()) {
      const path = `${directory}/${file}`;
      const slash = file.indexOf('/');
      if (slash < 0) {
        orphans.push({ path, directory, spec: null, reason: 'no-spec' });
        continue;
      }
      const spec = (parent ? `${parent}/` : '') + file.slice(0, slash);
      if (!byOwner.has(spec)) byOwner.set(spec, []);
      byOwner.get(spec).push(path);
    }

    for (const [spec, paths] of byOwner) {
      if (!existsSync(join(root, spec))) {
        for (const path of paths) orphans.push({ path, directory, spec, reason: 'spec-gone' });
        continue;
      }
      const entry = record?.specs?.[spec];
      const why = !record
        ? problem
        : !entry
          ? 'the recorded browser run did not run it'
          : !entry.complete
            ? 'not every test in it passed in the recorded browser run'
            : entry.sha256 !== fileHash(join(root, spec))
              ? 'it changed since the recorded browser run'
              : null;
      if (why) {
        unchecked.push({ spec, why });
        continue;
      }
      const used = new Set(entry.references);
      for (const path of paths) {
        if (!used.has(path)) orphans.push({ path, directory, spec, reason: 'unused' });
      }
    }
  }
  return { orphans, unchecked, recordProblem: record ? null : problem };
}

/**
 * Deletes the orphans, then every directory between an orphan and its screenshot directory (that
 * one too) which is left empty.
 */
export function pruneOrphans(root, orphans) {
  const directories = new Set();
  for (const { path, directory } of orphans) {
    rmSync(join(root, path), { force: true });
    for (
      let dir = path.slice(0, path.lastIndexOf('/'));
      ;
      dir = dir.slice(0, dir.lastIndexOf('/'))
    ) {
      directories.add(dir);
      if (dir === directory || !dir.includes('/')) break;
    }
  }
  // Deepest first, so a parent is empty by the time it is tried.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    const path = join(root, directory);
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  }
}
