/**
 * The record of a browser run: which reference screenshots each spec file asked for. The Vitest
 * plugin writes it, `qits-angular screenshots` reads it. Paths are relative to the project root,
 * with `/` as the separator.
 *
 *   {
 *     "version": 1,
 *     "screenshotDirectory": "__screenshots__",
 *     "specs": {
 *       "src/app/x/x.browser.spec.ts": {
 *         "sha256": "<hash of the spec file when the run ended>",
 *         "complete": true,            // every test in the file ran and passed
 *         "references": ["src/app/x/__screenshots__/x.browser.spec.ts/a-chromium-linux.png"]
 *       }
 *     }
 *   }
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';

export const RECORD_VERSION = 1;

/** Where the plugin writes the record and the CLI reads it, relative to the project root. */
export const DEFAULT_RECORD = 'node_modules/.cache/@qits/angular/screenshot-references.json';

export const DEFAULT_SCREENSHOT_DIRECTORY = '__screenshots__';

export const toPosix = (path) => path.split(sep).join('/');

/** The sha256 of a file, or `null` when it cannot be read. */
export function fileHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Reads a record. Returns `{ record }`, or `{ problem }` when the file is missing, is not JSON or
 * has another version.
 */
export function readRecord(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { problem: 'no recorded browser run' };
  }
  try {
    const record = JSON.parse(text);
    if (record?.version !== RECORD_VERSION || typeof record.specs !== 'object') {
      return { problem: `the record ${path} has another version; run the browser tests again` };
    }
    return { record };
  } catch {
    return { problem: `the record ${path} is not JSON; run the browser tests again` };
  }
}
