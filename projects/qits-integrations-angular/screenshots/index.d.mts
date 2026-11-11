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

/** The state a shot says it shows (`ScreenshotKind` in `@qits/angular/testing/browser`). */
export type FreezeKind = 'DATA' | 'NO_DATA' | 'PENDING' | 'ERROR';

/** A preset width a shot was taken at (`ScreenshotViewport` there). */
export type FreezeViewport = 'PHONE' | 'TABLET' | 'DESKTOP';

/** `['DATA', 'NO_DATA', 'PENDING', 'ERROR']`. */
export declare const SCREENSHOT_KINDS: readonly FreezeKind[];

/** `['PHONE', 'TABLET', 'DESKTOP']`, the order a shot is taken at them. */
export declare const SCREENSHOT_VIEWPORTS: readonly FreezeViewport[];

/**
 * A shot's freeze file, relative to the freeze directory: `<spec>/<slug>.html`, or
 * `<spec>/<slug>-<viewport>.html` (lower case) for a shot at a preset width.
 */
export declare function freezeFile(
  spec: string,
  name: string,
  viewport?: FreezeViewport | null,
): string;

/** `<dir>/manifest.json`. */
export interface FreezeManifest {
  /** The app's route tree, as `describeRoutes()` gives it. */
  routes: FreezeRoute[];
  freezes: {
    /**
     * Relative to the freeze directory: `<spec>/<name>.html`, or `<spec>/<name>-<viewport>.html`
     * for a shot at a preset width.
     */
    file: string;
    /** Relative to the root. */
    spec: string;
    test: string;
    /** The name the spec gave (without the `-<viewport>` suffix), or Vitest's default. */
    name: string;
    /**
     * The state the shot said it shows (ticket qits-2046), `null` when it gave none. Optional for a
     * reader: a manifest written before the field has none.
     */
    kind?: FreezeKind | null;
    /**
     * The preset width the shot was taken at (a spec `viewportSpecs` matches), `null` at the test's
     * own viewport. Optional for a reader, as `kind`.
     */
    viewport?: FreezeViewport | null;
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
  kind: 'exit' | 'stay' | 'returnTo' | 'external';
  /** The exit's path pattern, the external's site name; `null` for a stay or a return. */
  to: string | null;
  /** A layout's or an app-wide declaration: checked once, for its scope, not per page. */
  global: boolean;
  /** `false` for an interaction no element triggers: no screenshot is asked to show it. */
  triggered: boolean;
  /**
   * The declaring file, relative to the root; a library declaration's as
   * `@qits/angular/src/lib/…`.
   */
  file: string;
}

/** One of the library's own declarations, as `outcomes.json` ships it. */
export interface LibraryOutcome extends DeclaredOutcome {
  /** The exports whose import into an app brings the declaration in. */
  provides: string[];
}

/** One outcome a browser test reached. */
export interface FiredOutcome {
  spec: string;
  test: string;
  /** The route the router had matched when it was reached; `null` unless a page spec. */
  route: string | null;
  interaction: string;
  outcome: string;
  kind: 'exit' | 'stay' | 'returnTo' | 'external';
  /**
   * The first freeze of the test whose shot came after it (its DESKTOP freeze when the shot was
   * taken at the preset widths), or `null`.
   */
  freeze: string | null;
}

/**
 * Reads the app's `outcomes()` declarations with its own `typescript` (resolved from `root`; throws
 * naming the package when it is missing). `routes`: default `src/app/routes`. The library's own
 * declarations join them when the app imports an export that `provides` them.
 */
export declare function declaredOutcomes(options: { root: string; routes?: string }): {
  declared: DeclaredOutcome[];
  unreadable: { file: string; line: number; why: string }[];
};

/** The library's own declarations, as this copy of the package ships them. */
export declare function libraryOutcomes(): LibraryOutcome[];

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
