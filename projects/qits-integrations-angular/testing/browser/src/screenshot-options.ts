/**
 * What a screenshot says about itself beside its name (ticket qits-2046): the state it shows
 * (`kind`) and, for a shot taken at the preset widths, the widths it leaves out (`viewports`, with
 * a `reason`). Both are options of Vitest's own `toMatchScreenshot`, not a wrapper: the matcher
 * keeps its one call shape, which the lint rule `qits/screenshot-kind` checks, and
 * `freezeScreenshots()` strips the three keys before it calls Vitest's matcher, so Vitest never
 * sees them.
 *
 * Neither the name nor the recorded answers can stand in for a kind: a domain status called
 * `pending` that shows content is a happy path, and a refused write carries the same recordings as
 * the happy path (non-2xx answers are never recorded). So the spec says it.
 */
import type { ScreenshotComparatorRegistry } from 'vitest/browser';

/**
 * The state a screenshot shows, for a reader that opens a route on its happy path (the UI builder,
 * qits-2047):
 *
 * - `DATA`: the happy path, content shown. A domain status named "pending" or "failed" that shows
 *   content is `DATA`, and so is a form with no read (a create form).
 * - `NO_DATA`: the read answered, with nothing to show (an empty list).
 * - `PENDING`: waiting: a read in flight, or a write waiting on a timer.
 * - `ERROR`: a read that failed, and a refused write: it shows a refusal, not the happy path.
 */
export type ScreenshotKind = 'DATA' | 'NO_DATA' | 'PENDING' | 'ERROR';

/** Every {@link ScreenshotKind}, happy path first. */
export const SCREENSHOT_KINDS: readonly ScreenshotKind[] = Object.freeze([
  'DATA',
  'NO_DATA',
  'PENDING',
  'ERROR',
]);

/** A preset width a page shot is taken at (`freezeScreenshots({ viewportSpecs })`). */
export type ScreenshotViewport = 'PHONE' | 'TABLET' | 'DESKTOP';

/** A preset's size, in CSS pixels. */
export interface ScreenshotViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The preset sizes, in the order the shots are taken. Chosen against stock Tailwind v4
 * breakpoints: PHONE below `sm` (640); TABLET above `md` (768), so a shell shows its side
 * navigation, and below `xl` (1280); DESKTOP above `xl`.
 */
export const SCREENSHOT_VIEWPORTS: Readonly<Record<ScreenshotViewport, ScreenshotViewportSize>> =
  Object.freeze({
    PHONE: Object.freeze({ width: 390, height: 844 }),
    TABLET: Object.freeze({ width: 1024, height: 768 }),
    DESKTOP: Object.freeze({ width: 1440, height: 900 }),
  });

const VIEWPORT_ORDER = Object.keys(SCREENSHOT_VIEWPORTS) as ScreenshotViewport[];

declare module 'vitest/browser' {
  // The augmentation goes through `vitest/browser`, a re-export of `@vitest/browser/context`
  // where the interface lives: `vitest` is the peer every consumer resolves, `@vitest/browser` is
  // not. The type parameter is Vitest's own, unused here: declarations merge only with identical
  // type parameters (TS2428).
  interface ScreenshotMatcherOptions<
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match Vitest's declaration
    ComparatorName extends keyof ScreenshotComparatorRegistry = keyof ScreenshotComparatorRegistry,
  > {
    /**
     * The state the shot shows (ticket qits-2046), recorded as the freeze's `kind`. Required by
     * `freezeScreenshots({ requireKind: true })` and by the lint rule `qits/screenshot-kind`.
     */
    kind?: ScreenshotKind;
    /**
     * In a spec `freezeScreenshots({ viewportSpecs })` matches, the preset widths to take, a
     * non-empty subset of {@link SCREENSHOT_VIEWPORTS}, in place of all three; needs `reason`.
     * Ignored elsewhere.
     */
    viewports?: readonly ScreenshotViewport[];
    /** Why `viewports` leaves widths out (`'needs a fine pointer'`). Required with it. */
    reason?: string;
  }
}

/** One `toMatchScreenshot` call, read: what Vitest gets, and what the freeze records. */
export interface ShotRequest {
  /** The name the spec gave, or `undefined` for Vitest's default. */
  readonly name: string | undefined;
  /** Vitest's options without `kind`, `viewports` and `reason`, or `undefined` when none were given. */
  readonly options: Record<string, unknown> | undefined;
  readonly kind: ScreenshotKind | null;
  /** The widths asked for, in preset order, or `undefined` for all of them. */
  readonly viewports: readonly ScreenshotViewport[] | undefined;
  readonly reason: string | undefined;
  /** Why the call is malformed (a kind or width outside the enum, `viewports` without a reason). */
  readonly problem: string | undefined;
}

const OWN_KEYS = ['kind', 'viewports', 'reason'];

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/**
 * Reads a `toMatchScreenshot(nameOrOptions?, options?)` call's arguments as Vitest does (an object
 * first argument is the options), and takes this library's keys out of the options.
 */
export function shotRequest(args: readonly unknown[]): ShotRequest {
  const name = typeof args[0] === 'string' ? args[0] : undefined;
  const given = typeof args[0] === 'object' && args[0] !== null ? args[0] : args[1];
  const raw =
    typeof given === 'object' && given !== null ? (given as Record<string, unknown>) : undefined;
  const options = raw
    ? Object.fromEntries(Object.entries(raw).filter(([key]) => !OWN_KEYS.includes(key)))
    : undefined;
  const problems: string[] = [];

  let kind: ScreenshotKind | null = null;
  if (raw?.['kind'] !== undefined) {
    if (SCREENSHOT_KINDS.includes(raw['kind'] as ScreenshotKind)) {
      kind = raw['kind'] as ScreenshotKind;
    } else {
      problems.push(
        `its kind ${JSON.stringify(raw['kind'])} is not one of ${quoted(SCREENSHOT_KINDS)}`,
      );
    }
  }

  let viewports: ScreenshotViewport[] | undefined;
  const reason = typeof raw?.['reason'] === 'string' ? raw['reason'] : undefined;
  if (raw?.['viewports'] !== undefined) {
    const list = raw['viewports'];
    const unknown = Array.isArray(list)
      ? list.filter((v) => !VIEWPORT_ORDER.includes(v as ScreenshotViewport))
      : [list];
    if (!Array.isArray(list) || list.length === 0) {
      problems.push(`its viewports must be a non-empty list of ${quoted(VIEWPORT_ORDER)}`);
    } else if (unknown.length > 0) {
      problems.push(
        `its viewports name ${unknown.map((v) => JSON.stringify(v)).join(', ')}, not one of ` +
          quoted(VIEWPORT_ORDER),
      );
    } else {
      viewports = VIEWPORT_ORDER.filter((v) => list.includes(v));
    }
    if (reason === undefined || reason.trim() === '') {
      problems.push('its viewports leave widths out without a reason (give { reason: "…" })');
    }
  }

  return {
    name,
    options,
    kind,
    viewports,
    reason,
    problem: problems.length > 0 ? problems.join('; ') : undefined,
  };
}

/** The widths a shot is taken at: `undefined` for one shot at the test's own viewport. */
export function shotViewports(
  request: Pick<ShotRequest, 'viewports'>,
  inViewportSpec: boolean,
): readonly ScreenshotViewport[] | undefined {
  if (!inViewportSpec) return undefined;
  return request.viewports ?? VIEWPORT_ORDER;
}

/**
 * The size a preset width is taken at: the preset's width, and the larger of its height and the
 * test's own, so a test that set a tall viewport to show a whole page is not cropped.
 */
export function viewportSize(
  viewport: ScreenshotViewport,
  current: { readonly height: number },
): ScreenshotViewportSize {
  const preset = SCREENSHOT_VIEWPORTS[viewport];
  return { width: preset.width, height: Math.max(preset.height, current.height) };
}

/** The name the shot at `viewport` is compared under: `<name>-phone`, `-tablet`, `-desktop`. */
export function viewportName(name: string, viewport: ScreenshotViewport): string {
  return `${name}-${viewport.toLowerCase()}`;
}

/** The arguments Vitest's matcher is called with: `name` (when there is one) and the options. */
export function vitestArgs(name: string | undefined, options: Record<string, unknown> | undefined) {
  const args: unknown[] = [];
  if (name !== undefined) args.push(name);
  if (options !== undefined) args.push(options);
  return args;
}
