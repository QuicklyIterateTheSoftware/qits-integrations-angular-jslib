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
 */
import type { Routes } from '@angular/router';
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

/** The browser command each freeze is sent to; `screenshotReferences({ freezes })` registers it. */
export const FREEZE_COMMAND = 'qitsFreeze';

/** The browser command the route tree is sent to, once per spec file. */
export const FREEZE_ROUTES_COMMAND = 'qitsFreezeRoutes';

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
        const freeze = freezeShot(shotTarget(chai.util.flag(this, 'object')), document, {
          renameClasses,
          dropInlineStyles,
        });
        const payload: ScreenshotFreezePayload = {
          name,
          test,
          html: freeze.html,
          route: currentRoutePattern(),
          records: currentTestRecords(),
          assets: freeze.assets,
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
