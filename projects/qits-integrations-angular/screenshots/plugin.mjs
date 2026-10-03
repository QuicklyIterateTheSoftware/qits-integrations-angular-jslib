/**
 * The Vitest plugin that records, during a browser run, every reference screenshot a
 * `toMatchScreenshot` call resolves, per spec file. The run is the source of truth: a name made in
 * a loop, an `it.each` table or a template string is recorded exactly as Vitest resolves it.
 *
 * It wraps `browser.expect.toMatchScreenshot.resolveScreenshotPath` (Vitest's default, or the
 * app's own), which Vitest calls on the Node side for every comparison, and adds a reporter that
 * writes the record when the run ends.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_RECORD,
  DEFAULT_SCREENSHOT_DIRECTORY,
  RECORD_VERSION,
  fileHash,
  toPosix,
} from './record.mjs';

/** Vitest's own default (`@vitest/browser`, `defaultOptions.resolveScreenshotPath`). */
const vitestDefault = ({
  arg,
  ext,
  root,
  screenshotDirectory,
  testFileDirectory,
  testFileName,
  browserName,
}) =>
  resolve(
    root,
    testFileDirectory,
    screenshotDirectory,
    testFileName,
    `${arg}-${browserName}-${platform()}${ext}`,
  );

const WRAPPED = Symbol.for('qits.screenshotReferences.wrapped');

/** A file passed when every test in it ran and passed: a skip or a failure leaves names unseen. */
function complete(testModule) {
  if (testModule.state() !== 'passed') return false;
  if ((testModule.errors?.() ?? []).length > 0) return false;
  for (const test of testModule.children.allTests()) {
    if (test.result().state !== 'passed') return false;
  }
  return true;
}

/**
 * @param {{ record?: string }} [options] `record`: the file to write, relative to the project root
 *   (default `node_modules/.cache/@qits/angular/screenshot-references.json`).
 */
export function screenshotReferences(options = {}) {
  const recordOption = options.record ?? DEFAULT_RECORD;
  /** spec path (relative, posix) → Set of reference paths (relative, posix) */
  const seen = new Map();
  let root;
  let screenshotDirectory = DEFAULT_SCREENSHOT_DIRECTORY;
  let reporterAdded = false;

  const reporter = {
    onTestRunStart() {
      seen.clear();
    },
    onTestRunEnd(testModules) {
      if (root === undefined) return;
      const specs = {};
      for (const testModule of testModules) {
        const spec = toPosix(relative(root, testModule.moduleId));
        specs[spec] = {
          sha256: fileHash(testModule.moduleId),
          complete: complete(testModule),
          references: [...(seen.get(spec) ?? [])].sort(),
        };
      }
      const file = isAbsolute(recordOption) ? recordOption : join(root, recordOption);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ version: RECORD_VERSION, screenshotDirectory, specs }, null, 2)}\n`,
      );
    },
  };

  return {
    name: 'qits:screenshot-references',
    configureVitest({ vitest, project }) {
      const browser = project.config.browser;
      if (!browser?.enabled) return;
      root ??= project.config.root;
      screenshotDirectory = browser.screenshotDirectory ?? DEFAULT_SCREENSHOT_DIRECTORY;

      browser.expect ??= {};
      const matcher = (browser.expect.toMatchScreenshot ??= {});
      const inner = matcher.resolveScreenshotPath ?? vitestDefault;
      if (!inner[WRAPPED]) {
        const wrapped = (data) => {
          const path = inner(data);
          const spec = toPosix(join(data.testFileDirectory, data.testFileName));
          const references = seen.get(spec) ?? new Set();
          references.add(toPosix(relative(data.root, path)));
          seen.set(spec, references);
          return path;
        };
        wrapped[WRAPPED] = true;
        matcher.resolveScreenshotPath = wrapped;
      }

      // Vitest builds its reporters from the resolved config after every configureVitest hook.
      if (!reporterAdded) {
        reporterAdded = true;
        vitest.config.reporters.push(reporter);
      }
    },
  };
}
