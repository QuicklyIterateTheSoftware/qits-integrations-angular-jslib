/**
 * Freezes every passing screenshot as HTML (ticket qits-1947). Call {@link freezeScreenshots} once
 * in the browser specs' setup file, beside `guardGoldenMasters()`; the Node side is the `freezes`
 * option of `screenshotReferences()` in `@qits/angular/screenshots`, which registers the commands
 * this sends to and writes the files.
 *
 * The hook is chai's own: `toMatchScreenshot` is overwritten once on `chai.Assertion.prototype`, so
 * every `expect.element(…).toMatchScreenshot(…)` runs Vitest's matcher first and, when it passed,
 * freezes the element it compared. `expect.element` resolves the element before the matcher runs
 * (the `object` flag), and the screenshot is stable by then, so the freeze is the DOM the PNG shows.
 * A failing shot fails the test, and nothing is frozen for it.
 *
 * A page or layout spec under the routes directory ({@link DEFAULT_ROUTE_SPECS}, ticket qits-1998)
 * must show the page through the app's own routes: a shot it takes on a TestBed without the app's
 * router, or on a stand-in route table, fails the test, and nothing is frozen for it.
 */
import { TestBed } from '@angular/core/testing';
import { ROUTES, Router, type Route, type Routes } from '@angular/router';
import { beforeAll, beforeEach, chai, expect } from 'vitest';
import { describeRoutes, type RouteDescription } from './describe-routes';
import {
  DEFAULT_DROPPED_INLINE_STYLES,
  DEFAULT_RENAMED_CLASSES,
  type DroppedInlineStyle,
  freezeShot,
} from './freeze-shot';
import {
  clearTestRecords,
  currentRoutePattern,
  currentTestRecords,
  type TestRecord,
} from './golden-master-guard';
import { outcomeRecords } from './record-outcomes';
import { visibleTriggers } from './visible-triggers';

/** The browser command each freeze is sent to; `screenshotReferences({ freezes })` registers it. */
export const FREEZE_COMMAND = 'qitsFreeze';

/** The browser command the route tree is sent to, once per spec file. */
export const FREEZE_ROUTES_COMMAND = 'qitsFreezeRoutes';

/**
 * The specs whose shots must show the app's routes: the page and layout specs under
 * `src/app/routes/`, as the Node side's `DEFAULT_ROUTE_SPECS` (`@qits/angular/screenshots`) names
 * the specs whose freezes keep their route.
 */
export const DEFAULT_ROUTE_SPECS =
  /(^|\/)src\/app\/routes\/.*\.(page|layout)\.browser\.spec\.[cm]?[jt]sx?$/;

/** What the browser sends the Node side for one passing screenshot. */
export interface ScreenshotFreezePayload {
  /** The screenshot's name as the spec gave it, or Vitest's default `<test name> <n>`. */
  readonly name: string;
  /** The test's full name (`describe > it`). */
  readonly test: string;
  readonly html: string;
  /** The route pattern the TestBed's router had matched, or `null`. */
  readonly route: string | null;
  /** The recorded answers the test had flushed when the shot was taken. */
  readonly records: TestRecord[];
  /** Same-origin paths the HTML refers to as `qits-freeze-asset:<path>`. */
  readonly assets: string[];
  /**
   * How many outcomes the test had reached when the shot was taken (`outcomeRecords()`; `0`
   * without `recordOutcomes()`): the Node side links each outcome to the first shot after it.
   */
  readonly outcomes: number;
  /** The `<interaction>:<outcome>` trigger marks visible in the shot, sorted (`visibleTriggers`). */
  readonly triggers: string[];
}

/** Options for {@link freezeScreenshots}. */
export interface FreezeScreenshotsOptions {
  /**
   * The app's route tree (`routes` from `app.routes.ts`). Sent once per spec file as
   * {@link describeRoutes} gives it; the manifest names it `routes`. No lazy route is loaded.
   */
  readonly routes?: Routes;
  /**
   * Whole class names a page-wide counter numbers, renumbered in each freeze in order of
   * appearance. Default {@link DEFAULT_RENAMED_CLASSES} (xterm's `xterm-dom-renderer-owner-<n>`);
   * giving it replaces the default, so spread the default in to keep it.
   */
  readonly renameClasses?: readonly RegExp[];
  /**
   * Inline style properties measured at run time, dropped from the elements a selector matches.
   * Default {@link DEFAULT_DROPPED_INLINE_STYLES} (the `transform` on xterm's accessibility rows);
   * giving it replaces the default.
   */
  readonly dropInlineStyles?: readonly DroppedInlineStyle[];
  /**
   * The specs whose shots must show the page through the app's routes, matched against the test
   * file's path. Default {@link DEFAULT_ROUTE_SPECS}, the page and layout specs under
   * `src/app/routes/`. With `routes` given, a shot passes when the router's top matched route is
   * one of `routes` ({@link renderedThroughRoutes}); without it, when the router has
   * matched a route pattern at all. Any other shot fails its test, and nothing is frozen for it.
   */
  readonly routeSpecs?: RegExp;
}

/** The key Angular gives a named outlet's componentless route (`standardizeConfig`). */
const PRIMARY_OUTLET = 'primary';

/**
 * Whether `copy`, a route in the router's config, is the router's copy of `original`. The `Router`
 * never keeps the objects it is given: its constructor runs `resetConfig`, which copies every route
 * shallowly (`standardizeConfig`, children included), so a copy is told by its values: every key
 * but `children` holds the same value (the same component class, `loadComponent` function, `data`
 * object, guard array), and the children are copies of the original's, in order. The router's own
 * bookkeeping (`_loadedRoutes`, `_injector`, …) is ignored, and so is the empty outlet component
 * `standardizeConfig` adds to a componentless route of a named outlet.
 */
function copyOf(copy: Route, original: Route): boolean {
  if (copy === original) return true;
  const keys = new Set(
    [...Object.keys(copy), ...Object.keys(original)].filter((k) => !k.startsWith('_')),
  );
  for (const key of keys) {
    if (key === 'children') continue;
    const a = (copy as Record<string, unknown>)[key];
    const b = (original as Record<string, unknown>)[key];
    if (a === b) continue;
    const addedOutlet =
      key === 'component' &&
      b === undefined &&
      original.outlet !== undefined &&
      original.outlet !== PRIMARY_OUTLET;
    if (!addedOutlet) return false;
  }
  const children = copy.children ?? [];
  const originals = original.children ?? [];
  return children.length === originals.length && children.every((c, i) => copyOf(c, originals[i]));
}

/**
 * Whether `router` shows a route of `routes`, the app's route tree: its top matched route
 * (`routerState.snapshot.root.firstChild.routeConfig`) is an element of `routes`, or the router's
 * copy of one (the router copies every route it is given, see {@link copyOf}): the same values
 * all the way down its children. So it holds for a page opened through the app's routes (a root
 * page matched at `''` included, and `provideRouter([...routes])`), and fails for a stand-in table
 * (a route the app's tree does not hold, a layout with fewer children, another component or
 * `loadComponent`), a router that has matched nothing, and no router.
 */
export function renderedThroughRoutes(
  router: Pick<Router, 'routerState'> | null | undefined,
  routes: Routes,
): boolean {
  const top = router?.routerState.snapshot.root.firstChild?.routeConfig;
  return top != null && routes.some((route) => copyOf(top, route));
}

/**
 * The TestBed's router, or undefined without one. `ROUTES` is asked first, as the guard's
 * `currentRoutePattern()` does: `Router` is `providedIn: 'root'`, so injecting it would make one.
 */
function testBedRouter(): Router | undefined {
  try {
    if (!TestBed.inject(ROUTES, null)) return undefined;
    return TestBed.inject(Router, null) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Why a shot does not show the app's routes, or undefined when it does. */
function notThroughRoutes(routes: Routes | undefined): string | undefined {
  if (!routes) {
    return currentRoutePattern() === null
      ? 'the TestBed has no router that matched a route'
      : undefined;
  }
  const router = testBedRouter();
  if (!router) return 'the TestBed has no router';
  if (renderedThroughRoutes(router, routes)) return undefined;
  if (!router.routerState.snapshot.root.firstChild) return 'the router has matched no route';
  return "the router matched a route that is not one of the app's routes (a stand-in route table)";
}

/** The spec's path relative to the project root when the browser run knows it, else as given. */
async function specName(testPath: string): Promise<string> {
  try {
    const { server } = await import('vitest/browser');
    const root = server.config.root.split('\\').join('/').replace(/\/+$/, '');
    if (root && testPath.startsWith(`${root}/`)) return testPath.slice(root.length + 1);
  } catch {
    // not in a browser run: keep the path as it is
  }
  return testPath;
}

const INSTALLED = Symbol.for('qits.freezeScreenshots');

type Command = (...args: unknown[]) => Promise<unknown>;

/**
 * A browser command by name. `vitest/browser` is imported only here, when a shot is frozen: a
 * static import would make every import of this entry (the guard too) need a browser run.
 */
const command = async (name: string): Promise<Command> => {
  const { commands } = await import('vitest/browser');
  const found = (commands as unknown as Record<string, Command | undefined>)[name];
  if (!found) {
    throw new Error(
      `freezeScreenshots: the browser command ${name} is not registered. Pass the freezes option to ` +
        "screenshotReferences() (from '@qits/angular/screenshots') in the Vitest config.",
    );
  }
  return found;
};

interface Task {
  readonly result?: { readonly repeatCount?: number };
}

/** Per test, how many shots it took, to name an unnamed one as Vitest does. */
const counters = new WeakMap<Task, { repeat: number; current: number }>();

/**
 * Freezes every passing `toMatchScreenshot` as HTML and sends it to the Node side, with the route
 * and the recorded answers the test showed. Also clears the current test's records before every
 * test, and sends `options.routes` once per spec file. Call it once, in the setup file.
 */
export function freezeScreenshots(options: FreezeScreenshotsOptions = {}): void {
  const renameClasses = options.renameClasses ?? DEFAULT_RENAMED_CLASSES;
  const dropInlineStyles = options.dropInlineStyles ?? DEFAULT_DROPPED_INLINE_STYLES;
  const routeSpecs = options.routeSpecs ?? DEFAULT_ROUTE_SPECS;
  beforeEach(() => clearTestRecords());
  if (options.routes) {
    const routes: RouteDescription[] = describeRoutes(options.routes);
    let sent = false;
    beforeAll(async () => {
      if (sent) return;
      sent = true;
      await (
        await command(FREEZE_ROUTES_COMMAND)
      )(routes);
    });
  }

  const proto = chai.Assertion.prototype as unknown as Record<PropertyKey, unknown>;
  if (proto[INSTALLED]) return;
  if (typeof proto['toMatchScreenshot'] !== 'function') {
    throw new Error(
      'freezeScreenshots: expect has no toMatchScreenshot; it needs a Vitest browser run.',
    );
  }
  proto[INSTALLED] = true;
  chai.util.overwriteMethod(
    chai.Assertion.prototype,
    'toMatchScreenshot',
    (original: (...args: unknown[]) => unknown) =>
      async function (this: Chai.AssertionStatic, ...args: unknown[]) {
        const test = expect.getState().currentTestName ?? '';
        const name = typeof args[0] === 'string' ? args[0] : `${test} ${count(this)}`;
        await original.apply(this, args);
        const testPath = (expect.getState().testPath ?? '').split('\\').join('/');
        const why = routeSpecs.test(testPath) ? notThroughRoutes(options.routes) : undefined;
        if (why) {
          throw new Error(
            `freezeScreenshots: ${await specName(testPath)} took the screenshot '${name}' in ` +
              `'${test}' without the app's routes: ${why}. A page or layout spec under the ` +
              "routes directory shows the page where the app shows it: open the page through the app's " +
              'routes (openRoute(), or provideRouter(routes) with the routes from app.routes.ts) and ' +
              'navigate to its URL before the shot. Nothing was frozen for it.',
          );
        }
        const target = shotTarget(chai.util.flag(this, 'object'));
        // On the live DOM, before the serializer: the HTML cannot tell a hidden mark from a shown one.
        const triggers = visibleTriggers(target, document);
        const freeze = freezeShot(target, document, { renameClasses, dropInlineStyles });
        const payload: ScreenshotFreezePayload = {
          name,
          test,
          html: freeze.html,
          route: currentRoutePattern(),
          records: currentTestRecords(),
          assets: freeze.assets,
          outcomes: outcomeRecords().length,
          triggers,
        };
        await (
          await command(FREEZE_COMMAND)
        )(payload);
      },
  );
}

/** The shot's number in its test, counted as Vitest counts it for the default name. */
function count(assertion: object): number {
  const task = chai.util.flag(assertion, 'vitest-test') as Task | undefined;
  if (!task) return 1;
  const repeat = task.result?.repeatCount ?? 0;
  let counter = counters.get(task);
  if (!counter || counter.repeat !== repeat) counters.set(task, (counter = { repeat, current: 0 }));
  return ++counter.current;
}

/** The screenshotted element: an element, a locator's element, or `null` for the page. */
function shotTarget(subject: unknown): Element | null {
  if (subject instanceof Element) return subject;
  const locator = subject as { element?: unknown } | null;
  if (locator && typeof locator === 'object' && typeof locator.element === 'function') {
    try {
      return (locator as { element(): Element }).element();
    } catch {
      return null;
    }
  }
  return null;
}
