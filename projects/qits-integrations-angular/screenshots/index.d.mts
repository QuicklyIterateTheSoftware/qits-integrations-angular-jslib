import type { Plugin } from 'vite';

export interface ScreenshotReferencesOptions {
  /**
   * The record to write, absolute or relative to the project root. Default:
   * `node_modules/.cache/@qits/angular/screenshot-references.json`.
   */
  record?: string;
  /**
   * Also write the screenshot freezes (ticket qits-1947): every passing `toMatchScreenshot` as
   * HTML, sent by `freezeScreenshots()` from `@qits/angular/testing/browser` (call it in the setup
   * file). `true` takes the defaults.
   */
  freezes?: boolean | ScreenshotFreezesOptions;
}

export interface ScreenshotFreezesOptions {
  /** Where the freezes and `manifest.json` go, relative to the root. Default {@link DEFAULT_FREEZE_DIRECTORY}. */
  dir?: string;
  /**
   * The specs whose freezes name the route the router matched. Default
   * {@link DEFAULT_ROUTE_SPECS}, the page specs; any other spec's freezes have `route: null`.
   */
  routeSpecs?: RegExp;
}

/**
 * Whether a run may replace a spec module's freezes: nothing failed, every test that did not pass
 * skipped itself (`it.skip`, `it.todo`, `skipIf`), and the run did not narrow the module's tests
 * (`-t`, tags, lines, ids, `.only`). `filtered`: the run narrowed this module.
 */
export declare function completeForFreezes(
  testModule: unknown,
  options?: { filtered?: boolean },
): boolean;

/** `src/testing/browser/freezes`. */
export declare const DEFAULT_FREEZE_DIRECTORY: string;

/** `/\.page\.browser\.spec\.[cm]?[jt]sx?$/`. */
export declare const DEFAULT_ROUTE_SPECS: RegExp;

/** A screenshot's name as its freeze's file name (without `.html`), as Vitest slugs it. */
export declare function freezeSlug(name: string): string;

/** `<dir>/manifest.json`. */
export interface FreezeManifest {
  /** The app's route tree, as `describeRoutes()` gives it. */
  routes: FreezeRoute[];
  freezes: {
    /** Relative to the freeze directory: `<spec>/<name>.html`. */
    file: string;
    /** Relative to the root. */
    spec: string;
    test: string;
    name: string;
    route: string | null;
    records: { provider: string; state: string; operationId: string }[];
  }[];
  /** Route pattern → the freezes (`file`) of page specs on that route. */
  byRoute: Record<string, string[]>;
}

export interface FreezeRoute {
  path: string;
  fullPath: string;
  redirectTo?: string;
  children?: FreezeRoute[];
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
