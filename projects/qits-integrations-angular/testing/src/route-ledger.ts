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
 * {@link goldenMasterRoutes} is the Vitest browser command that rewrites one spec's section after
 * that spec ran; {@link routeLedger} reads the file for the pact specs. Node-side only.
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
 * The browser command that keeps the ledger at `ledgerPath` (relative to `root`, default the cwd):
 * called with the records of the spec that just ran (`takeRouteRecords()` from
 * `@qits/angular/testing/browser`), it rewrites that spec's section and nothing else.
 *
 * - The section's key is the running spec's path relative to `root`, with `/` separators.
 * - Its records are sorted and without duplicates; an empty list removes the section.
 * - Sections of spec files that no longer exist (relative to `root`) are dropped.
 * - Keys are sorted, the JSON is indented by two spaces and ends in a newline, and the file is
 *   written only when that text changed, so a run that shows nothing new leaves it untouched.
 *
 * Each call reads and writes synchronously, so calls from several spec files in one process never
 * interleave, and holds `<ledger>.lock` while it does, so neither do runs in other processes.
 *
 * A spec run with a filter (`-t`, `.only`) notes only what its tests showed, and that replaces the
 * section: run whole spec files before committing the ledger.
 */
export function goldenMasterRoutes(
  ledgerPath: string,
  root: string = process.cwd(),
): RouteLedgerCommand {
  const base = resolve(root);
  const file = resolve(base, ledgerPath);
  return (context, records) => {
    const testPath = context.testPath;
    if (!testPath) {
      throw new Error('goldenMasterRoutes: the command was called outside a test file');
    }
    const absolute = isAbsolute(testPath) ? testPath : resolve(base, testPath);
    const spec = relative(base, absolute).split(sep).join('/');
    mkdirSync(dirname(file), { recursive: true });
    withLock(`${file}.lock`, () => {
      const ledger = read(file);
      const next: RouteLedgerFile = {};
      const section = normal(records);
      const keys = new Set(Object.keys(ledger));
      if (section.length) keys.add(spec);
      for (const key of [...keys].sort()) {
        if (key === spec) {
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
  };
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
