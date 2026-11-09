/// <reference types="node" />
/**
 * The route ledger (ticket qits-1946): which routes each recorded answer is shown on, so a pact
 * interaction can name them (`comments.references.qits-trigger.route`).
 *
 * The browser specs know the route: the golden-master guard (`@qits/angular/testing/browser`)
 * notes, for every recording a spec flushes, the route pattern the router matched. The pact specs
 * run elsewhere (jsdom, `ng test`) and cannot see a browser run, so the two meet in a committed
 * JSON file:
 *
 *   {
 *     "src/app/routes/projects/repositories.page.browser.spec.ts": [
 *       { "provider": "qits-projects-service", "state": "a project exists",
 *         "operationId": "listProjectRepositories", "route": "projects/:slug/repositories" }
 *     ]
 *   }
 *
 * One section per browser spec file, keyed by its path relative to the project root.
 * {@link goldenMasterRoutes} is the Vitest browser command a spec file sends its records to; it
 * only stages them, and its reporter (added by its `plugin`) writes the ledger when the run ends,
 * replacing only the sections of spec files that ran completely (ticket qits-1966), the way the
 * screenshot freezes are written. A file that failed, was skipped or ran in part keeps its
 * section. {@link routeLedger} reads the file for the pact specs. Node-side only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { withLock } from './file-lock';

/** One recorded answer shown on one route, as the guard notes it and the ledger keeps it. */
export interface RouteRecord {
  /** The provider's repository name (`qits-projects-service`). */
  readonly provider: string;
  readonly state: string;
  readonly operationId: string;
  /** The matched route pattern (`projects/:slug/repositories`). */
  readonly route: string;
}

/** The ledger file: each browser spec's records, by the spec's path relative to the root. */
export type RouteLedgerFile = Record<string, RouteRecord[]>;

/**
 * A Vitest browser command, as far as this one needs its context: the running spec file. A
 * `BrowserCommand<[records: RouteRecord[]]>` of `vitest/node`, without needing Vitest's types.
 */
export type RouteLedgerCommand = (
  context: { readonly testPath: string | undefined },
  records: readonly RouteRecord[],
) => void;

/** Routes for one interaction, by the provider's repository name, state and operation. */
export type RouteLookup = (provider: string, state: string, operationId: string) => string[];

const keyOf = (r: RouteRecord) => [r.provider, r.state, r.operationId, r.route].join('\u0000');

const isRecord = (value: unknown): value is RouteRecord => {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return ['provider', 'state', 'operationId', 'route'].every(
    (key) => typeof r[key] === 'string' && r[key] !== '',
  );
};

/** `records` sorted, without duplicates, each with the four keys in a fixed order. */
function normal(records: readonly unknown[]): RouteRecord[] {
  const byKey = new Map<string, RouteRecord>();
  for (const r of records) {
    if (!isRecord(r)) continue;
    byKey.set(keyOf(r), {
      provider: r.provider,
      state: r.state,
      operationId: r.operationId,
      route: r.route,
    });
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

function read(ledgerPath: string): RouteLedgerFile {
  if (!existsSync(ledgerPath)) return {};
  const text = readFileSync(ledgerPath, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${ledgerPath} is not a route ledger: expected an object of spec sections`);
  }
  return parsed as RouteLedgerFile;
}

/**
 * A test module as the ledger's reporter needs it: the shape of Vitest's `TestModule` (Vitest 4
 * and 5) it reads, without needing Vitest's types.
 */
export interface RouteLedgerTestModule {
  /** The spec file's absolute path. */
  readonly moduleId: string;
  state(): string;
  errors?(): readonly unknown[];
  readonly children: { allTests(): Iterable<{ result(): { readonly state: string } }> };
}

/** The Vitest reporter that writes the ledger at the end of a run. */
export interface RouteLedgerReporter {
  onTestRunStart(): void;
  onTestRunEnd(testModules: readonly RouteLedgerTestModule[]): void;
}

/** What the ledger's plugin reads from the context of Vite's `configureVitest` hook. */
export interface RouteLedgerVitestContext {
  readonly vitest: { readonly config: { readonly reporters: unknown[] } };
}

/** The Vite plugin that adds the ledger's reporter to the Vitest run. */
export interface RouteLedgerPlugin {
  readonly name: 'qits:route-ledger';
  configureVitest(context: RouteLedgerVitestContext): void;
}

/** {@link goldenMasterRoutes}: the browser command, its reporter, and the plugin that adds it. */
export type GoldenMasterRoutes = RouteLedgerCommand & {
  readonly reporter: RouteLedgerReporter;
  readonly plugin: RouteLedgerPlugin;
};

/**
 * A file ran completely when it passed and every test in it ran and passed: a skip or a failure
 * leaves routes unseen. The same rule as `complete()` in `@qits/angular/screenshots`.
 */
function complete(testModule: RouteLedgerTestModule): boolean {
  if (testModule.state() !== 'passed') return false;
  if ((testModule.errors?.() ?? []).length > 0) return false;
  for (const test of testModule.children.allTests()) {
    if (test.result().state !== 'passed') return false;
  }
  return true;
}

/**
 * The browser command that keeps the ledger at `ledgerPath` (relative to `root`, default the cwd),
 * with the reporter that writes it. Called with the records of a spec file
 * (`takeRouteRecords()` from `@qits/angular/testing/browser`), the command only stages them for
 * that file, replacing what an earlier call staged for it; it writes nothing. When the run ends,
 * the reporter rewrites the section of every spec file that ran completely and nothing else:
 *
 * - The section's key is the spec's path relative to `root`, with `/` separators.
 * - Its records are sorted and without duplicates; a file that ran completely and staged nothing
 *   (or an empty list) loses its section.
 * - A file that failed (in a test or in a hook such as `beforeAll`), was skipped or ran in part
 *   (`-t`, `.only`) keeps its section as it was, so a broken run never empties the ledger.
 * - Sections of spec files that no longer exist (relative to `root`) are dropped.
 * - Keys are sorted, the JSON is indented by two spaces and ends in a newline, and the file is
 *   written only when that text changed, so a run that shows nothing new leaves it untouched.
 *
 * The write holds `<ledger>.lock`, so runs in other processes never interleave with it.
 *
 * Register the command under `browser.commands` and put `.plugin` in the Vitest config's `plugins`:
 * without the plugin, nothing is ever written.
 */
export function goldenMasterRoutes(
  ledgerPath: string,
  root: string = process.cwd(),
): GoldenMasterRoutes {
  const base = resolve(root);
  const file = resolve(base, ledgerPath);
  const specOf = (path: string) => {
    const absolute = isAbsolute(path) ? path : resolve(base, path);
    return relative(base, absolute).split(sep).join('/');
  };
  /** spec path (relative, posix) → its staged records */
  const staged = new Map<string, RouteRecord[]>();

  const command: RouteLedgerCommand = (context, records) => {
    const testPath = context.testPath;
    if (!testPath) {
      throw new Error('goldenMasterRoutes: the command was called outside a test file');
    }
    staged.set(specOf(testPath), normal(records));
  };

  const reporter: RouteLedgerReporter = {
    onTestRunStart() {
      staged.clear();
    },
    onTestRunEnd(testModules) {
      const ran = new Set<string>();
      for (const testModule of testModules) {
        if (complete(testModule)) ran.add(specOf(testModule.moduleId));
      }
      mkdirSync(dirname(file), { recursive: true });
      withLock(`${file}.lock`, () => {
        const ledger = read(file);
        const next: RouteLedgerFile = {};
        const keys = new Set(Object.keys(ledger));
        for (const spec of ran) keys.add(spec);
        for (const key of [...keys].sort()) {
          if (ran.has(key)) {
            const section = staged.get(key) ?? [];
            if (section.length) next[key] = section;
          } else if (existsSync(resolve(base, key))) {
            next[key] = normal(Array.isArray(ledger[key]) ? ledger[key] : []);
          }
        }
        const text = `${JSON.stringify(next, null, 2)}\n`;
        const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
        if (current === text) return;
        if (current === undefined && Object.keys(next).length === 0) return;
        writeFileSync(file, text);
      });
    },
  };

  let reporterAdded = false;
  const plugin: RouteLedgerPlugin = {
    name: 'qits:route-ledger',
    // Vitest builds its reporters from the resolved config after every configureVitest hook.
    configureVitest({ vitest }) {
      if (reporterAdded) return;
      reporterAdded = true;
      vitest.config.reporters.push(reporter);
    },
  };

  return Object.assign(command, { reporter, plugin });
}

/**
 * The routes the ledger at `ledgerPath` names for each (provider, state, operationId), across every
 * spec's section: sorted, without duplicates, `[]` when none does or there is no ledger. The file
 * is read on every call, so a rewritten one counts at once.
 */
export function routeLedger(ledgerPath: string): RouteLookup {
  return (provider, state, operationId) => {
    const routes = new Set<string>();
    for (const section of Object.values(read(ledgerPath))) {
      if (!Array.isArray(section)) continue;
      for (const r of section) {
        if (
          isRecord(r) &&
          r.provider === provider &&
          r.state === state &&
          r.operationId === operationId
        ) {
          routes.add(r.route);
        }
      }
    }
    return [...routes].sort();
  };
}
