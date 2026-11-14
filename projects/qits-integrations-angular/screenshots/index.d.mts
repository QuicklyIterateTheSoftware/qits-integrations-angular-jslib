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

/** A colour scheme a shot was taken in (`ColorScheme` there, ticket qits-2083). */
export type FreezeColorScheme = 'LIGHT' | 'DARK';

/** `['LIGHT', 'DARK']`, the order a shot is taken in them. */
export declare const COLOR_SCHEMES: readonly FreezeColorScheme[];

/**
 * `'qitsColorScheme'`: the browser command `freezeScreenshots({ colorSchemes })` emulates
 * `prefers-color-scheme` through (`'light'`, `'dark'`, {@link RESET_COLOR_SCHEME} to reset;
 * Playwright only). `screenshotReferences({ freezes })` registers it.
 */
export declare const FREEZE_COLOR_SCHEME_COMMAND: string;

/**
 * `'reset'`: what the browser sends `qitsColorScheme` to reset the emulation. Never `null`: Vitest
 * 5's browser tester throws on a `null` first argument of any command.
 */
export declare const RESET_COLOR_SCHEME: string;

/**
 * The page and layout shots (`route` not `null`) that lack a scheme of `manifest.colorSchemes`,
 * one message each (`<spec> '<name>' [<viewport>]: missing DARK`): grouped by spec, test, name and
 * viewport, a group misses each scheme none of its freezes was taken in, unless one of them opted
 * out (`colorSchemeReason`). Empty without `colorSchemes` in the manifest.
 */
export declare function colorSchemeGaps(manifest: FreezeManifest | undefined): string[];

/** What a page's network was at a shot (`ShotNetwork` there, ticket qits-2151). */
export type FreezeNetwork = 'ONLINE' | 'OFFLINE';

/** An outbox entry's state at a shot (`ShotOutboxState` there). */
export type FreezeOutboxState = 'PENDING' | 'SENDING' | 'CONFLICT' | 'FAILED';

/** `['ONLINE', 'OFFLINE']`. */
export declare const NETWORKS: readonly FreezeNetwork[];

/** `['PENDING', 'SENDING', 'CONFLICT', 'FAILED']`. */
export declare const OUTBOX_STATES: readonly FreezeOutboxState[];

/**
 * `'qitsOfflineOptOut'`: the browser command a spec's `offlineShotsNotTaken()` is sent through
 * (ticket qits-2151). `screenshotReferences({ freezes })` registers it.
 */
export declare const OFFLINE_OPT_OUT_COMMAND: string;

/** One outbox entry at a shot (ticket qits-2151; `recordId`, `currentVersion` qits-2153). */
export interface FreezeOutboxEntry {
  operation: string;
  state: FreezeOutboxState;
  /** The record the write touches, as a string; `null` when it names none. */
  recordId: string | null;
  /** Only on a `CONFLICT` entry: the server's version, as a string; `null` when it named none. */
  currentVersion?: string | null;
}

/** An operation whose shown value came from the local store at a shot (ticket qits-2153). */
export interface FreezeCachedRead {
  operation: string;
  /** When the shown value was stored, an ISO instant. */
  cachedAt: string;
}

/**
 * The page's offline layer at a shot (ticket qits-2151), as `freezeScreenshots({ offline: true })`
 * records it. Operations are named `<provider>#<operationId>`.
 */
export interface FreezeConnectivity {
  /** As `navigator.onLine` said at the shot. */
  network: FreezeNetwork;
  /** The outbox, oldest first. */
  outbox: FreezeOutboxEntry[];
  /** The live `offline: 'cache'` resources' operations, sorted. */
  cacheResources: string[];
  /**
   * The operations whose shown value came from the local store at the shot (ticket qits-2153), one
   * each (the latest `cachedAt` when several resources show one), sorted by operation.
   */
  cached: FreezeCachedRead[];
  /** The live `offline: 'queue'` mutations' operations, sorted. */
  queueMutations: string[];
}

/** One spec's `offlineShotsNotTaken()` (ticket qits-2151). */
export interface FreezeOfflineOptOut {
  /** Relative to the root. */
  spec: string;
  reason: string;
  /** Covers the offline shot of the spec's routes. */
  network: boolean;
  /** Covers the pending and conflict shots of these operations, sorted. */
  operations: string[];
}

/**
 * The offline shots a manifest with `offline: true` misses (ticket qits-2151), one message each, per
 * route (freezes with a `route`): `<route>: no offline shot` when a freeze lists a `cacheResources`
 * entry and none was taken `OFFLINE`; `<route>: no pending shot of <operation>` / `no conflict shot
 * of <operation>` for each `queueMutations` operation no freeze's outbox holds `PENDING` /
 * `CONFLICT`. An opt-out from a spec with a freeze on the route silences them (`network` the
 * offline gap, `operations` theirs, neither every gap). Empty without `offline: true`.
 */
export declare function offlineGaps(manifest: FreezeManifest | undefined): string[];

/** `['DATA', 'NO_DATA', 'PENDING', 'ERROR']`. */
export declare const SCREENSHOT_KINDS: readonly FreezeKind[];

/** `['PHONE', 'TABLET', 'DESKTOP']`, the order a shot is taken at them. */
export declare const SCREENSHOT_VIEWPORTS: readonly FreezeViewport[];

/**
 * A shot's freeze file, relative to the freeze directory: `<spec>/<slug>.html`, or
 * `<spec>/<slug>-<viewport>.html` (lower case) for a shot at a preset width; a shot in a colour
 * scheme takes it as the last suffix, `<spec>/<slug>[-<viewport>]-light.html`, `-dark`.
 */
export declare function freezeFile(
  spec: string,
  name: string,
  viewport?: FreezeViewport | null,
  colorScheme?: FreezeColorScheme | null,
): string;

/** `<dir>/manifest.json`. */
export interface FreezeManifest {
  /** The app's route tree, as `describeRoutes()` gives it. */
  routes: FreezeRoute[];
  /**
   * The app's `freezeScreenshots({ colorSchemes })` (ticket qits-2083), as the run's shots carried
   * it, kept from the previous manifest by a run that froze nothing. Absent without the option.
   */
  colorSchemes?: FreezeColorScheme[] | null;
  /**
   * `true` when the run's shots carried `freezeScreenshots({ offline: true })` (ticket qits-2151),
   * kept from the previous manifest by a run that froze nothing. Absent without the option.
   */
  offline?: true;
  freezes: {
    /**
     * Relative to the freeze directory: `<spec>/<name>.html`, or `<spec>/<name>-<viewport>.html`
     * for a shot at a preset width; `<spec>/<name>[-<viewport>]-<scheme>.html` in a colour scheme.
     */
    file: string;
    /** Relative to the root. */
    spec: string;
    test: string;
    /** The name the spec gave (without the `-<viewport>` and `-<scheme>` suffixes), or Vitest's default. */
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
    /**
     * The colour scheme the shot was taken in (ticket qits-2083), `null` for one taken without it.
     * Written only when the manifest has `colorSchemes`; a reader takes a missing one as `null`.
     */
    colorScheme?: FreezeColorScheme | null;
    /**
     * The shot's `reason` when it named its own `colorSchemes` (an opt-out of a scheme), else
     * `null`. Written and read as `colorScheme`.
     */
    colorSchemeReason?: string | null;
    /**
     * The page's offline layer at the shot (ticket qits-2151), `null` for an entry kept from a run
     * without the option. Written only when the manifest has `offline`; a reader takes a missing one
     * as `null`.
     */
    connectivity?: FreezeConnectivity | null;
    route: string | null;
    records: { provider: string; state: string; operationId: string }[];
    /** The `<interaction>:<outcome>` marks visible in the shot, sorted. */
    triggers: string[];
    /**
     * The `data-qits-*` data marks visible in the shot (ticket qits-2141), deduplicated and
     * sorted. Written only when the freeze shows a mark; a missing key reads as `[]`.
     */
    dataMarks?: {
      source: string | null;
      item: string | null;
      field: string | null;
      derived: string[];
    }[];
  }[];
  /** Route pattern → the freezes (`file`) of page specs on that route. */
  byRoute: Record<string, string[]>;
  /**
   * The specs' `offlineShotsNotTaken()` (ticket qits-2151), sorted by spec, kept per spec as the
   * freezes are. Written only when the manifest has `offline`.
   */
  offlineOptOuts?: FreezeOfflineOptOut[];
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
   * taken at the preset widths, and of its colour schemes the first taken, LIGHT unless the shot
   * left it out), or `null`.
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

/**
 * The outcome gaps `qits-angular screenshots --check` names, one message each. With `freezesDir`
 * (the directory holding the manifest and the frozen HTML), also each page route that renders a
 * layout's or app-wide trigger none of its own screenshots shows (ticket qits-2225).
 */
export declare function outcomeGaps(input: {
  declared: DeclaredOutcome[];
  unreadable: { file: string; line: number; why: string }[];
  manifest?: FreezeManifest;
  freezesDir?: string;
}): string[];

/**
 * The full paths of the forwards in `manifest.routes` (ticket qits-2076): routes that render a
 * component (not `rendersNothing`, no string `redirectTo`, `path` not `**`), whose declared entries
 * for exactly their full path (any `global`; `route: null` never counts) exist and are all `exit()`s
 * with `triggered: false`, and every descendant of which is `rendersNothing`.
 */
export declare function forwardRoutes(
  manifest: FreezeManifest | undefined,
  declared: DeclaredOutcome[],
): Set<string>;

/**
 * The page routes (ticket qits-2076): the checked routes (no children, no `redirectTo`, `path` not
 * `**`) minus the `rendersNothing` ones and minus every route in a forward's subtree. The set any
 * rule about the states a page shows must iterate. The forwards are read from the manifest's
 * `forward: true` flags; given `declared`, they are computed with {@link forwardRoutes} instead.
 */
export declare function pageRoutes(
  manifest: FreezeManifest | undefined,
  declared?: DeclaredOutcome[],
): FreezeRoute[];

export interface FreezeRoute {
  path: string;
  fullPath: string;
  redirectTo?: string;
  /** `true` when the route is entered from outside the app (`data: QITS_ENTRY`, ticket qits-2049). */
  entry?: true;
  /**
   * `true` when the route renders nothing of its own (ticket qits-2076): no component, lazy load or
   * redirect, a `path` other than `**`, and children (if any) that render nothing either.
   */
  rendersNothing?: true;
  /**
   * `true` on a forward (ticket qits-2076, {@link forwardRoutes}): written by the freeze writer at
   * the end of the run, on the forward itself and never on its `rendersNothing` descendants.
   */
  forward?: true;
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
  /**
   * `unschemed`: a spec whose other tests skipped themselves, in a run that took its shots in colour
   * schemes, did not ask for it, and its name ends in none of those schemes.
   */
  reason: 'spec-gone' | 'no-spec' | 'unused' | 'unschemed';
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
  /**
   * The colour schemes (lower case) the run's freeze payloads carried, `null` for none; absent when
   * the run sent no freeze payload or the plugin has no `freezes` option.
   */
  colorSchemes?: string[] | null;
  specs: Record<
    string,
    {
      sha256: string | null;
      complete: boolean;
      /** On a spec whose tests that did not pass all skipped themselves: how many skipped. */
      skipped?: number;
      references: string[];
    }
  >;
}

export declare function readRecord(
  path: string,
): { record: ScreenshotRecord; problem?: undefined } | { record?: undefined; problem: string };
