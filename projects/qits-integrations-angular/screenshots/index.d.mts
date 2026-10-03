import type { Plugin } from 'vite';

export interface ScreenshotReferencesOptions {
  /**
   * The record to write, absolute or relative to the project root. Default:
   * `node_modules/.cache/@qits/angular/screenshot-references.json`.
   */
  record?: string;
}

/**
 * A Vitest plugin: records, per spec file, every reference screenshot a `toMatchScreenshot` call
 * resolves during a browser run, and writes the record when the run ends.
 */
export declare function screenshotReferences(options?: ScreenshotReferencesOptions): Plugin;

export interface Orphan {
  /** The reference, relative to the root. */
  path: string;
  /** Its screenshot directory, relative to the root. */
  directory: string;
  /** The spec that owns it by place, or `null` when none does. */
  spec: string | null;
  reason: 'spec-gone' | 'no-spec' | 'unused';
}

export declare function findOrphans(options: { root: string; record: string }): {
  orphans: Orphan[];
  unchecked: { spec: string; why: string }[];
  recordProblem: string | null;
};

export declare function pruneOrphans(root: string, orphans: Orphan[]): void;

export declare const DEFAULT_RECORD: string;

export interface ScreenshotRecord {
  version: 1;
  screenshotDirectory: string;
  specs: Record<string, { sha256: string | null; complete: boolean; references: string[] }>;
}

export declare function readRecord(
  path: string,
): { record: ScreenshotRecord; problem?: undefined } | { record?: undefined; problem: string };
