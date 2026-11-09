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
   * {@link DEFAULT_ROUTE_SPECS}, the page and layout specs under `src/app/routes/`; any other
   * spec's freezes have `route: null`.
   */
  routeSpecs?: RegExp;
  /**
   * The routes directory the manifest's declared outcomes are scoped by, relative to the root, as
   * the lint rules' `routes` option. Default `src/app/routes`.
   */
  routes?: string;
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

/**
 * `/(^|\/)src\/app\/routes\/.*\.(page|layout)\.browser\.spec\.[cm]?[jt]sx?$/`: the page and
 * layout specs under `src/app/routes/`, which open the page through the app's routes.
 */
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
    /** The `<interaction>:<outcome>` marks visible in the shot, sorted. */
    triggers: string[];
  }[];
  /** Route pattern → the freezes (`file`) of page specs on that route. */
  byRoute: Record<string, string[]>;
  outcomes: {
    /** Read from the source at the end of the run, sorted by route, interaction and outcome. */
    declared: DeclaredOutcome[];
    /** What the browser tests reached, sorted by spec and test, in order within a test. */
    fired: FiredOutcome[];
  };
}

/** One entry of an `outcomes()` call, as `declaredOutcomes()` reads it. */
export interface DeclaredOutcome {
  /** The page's route, a layout's (its whole subtree), or `null` for an app-wide declaration. */
  route: string | null;
  interaction: string;
  outcome: string;
  kind: 'exit' | 'stay';
  /** The exit's path pattern; `null` for a stay. */
  to: string | null;
  /** A layout's or an app-wide declaration: checked once, for its scope, not per page. */
  global: boolean;
  /** The declaring file, relative to the root. */
  file: string;
}

/** One outcome a browser test reached. */
export interface FiredOutcome {
  spec: string;
  test: string;
  /** The route the router had matched when it was reached; `null` unless a page spec. */
  route: string | null;
  interaction: string;
  outcome: string;
  kind: 'exit' | 'stay';
  /** The first freeze of the test whose shot came after it, or `null`. */
  freeze: string | null;
}

/**
 * Reads the app's `outcomes()` declarations with its own `typescript` (resolved from `root`; throws
 * naming the package when it is missing). `routes`: default `src/app/routes`.
 */
export declare function declaredOutcomes(options: { root: string; routes?: string }): {
  declared: DeclaredOutcome[];
  unreadable: { file: string; line: number; why: string }[];
};

/** The outcome gaps `qits-angular screenshots --check` names, one message each. */
export declare function outcomeGaps(input: {
  declared: DeclaredOutcome[];
  unreadable: { file: string; line: number; why: string }[];
  manifest?: FreezeManifest;
}): string[];

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
