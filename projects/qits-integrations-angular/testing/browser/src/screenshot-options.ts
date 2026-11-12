/**
 * What a screenshot says about itself beside its name (ticket qits-2046): the state it shows
 * (`kind`) and, for a shot taken at the preset widths, the widths it leaves out (`viewports`, with
 * a `reason`); in an app that takes its shots in both colour schemes, the schemes it leaves out
 * (`colorSchemes`, ticket qits-2083, with the same `reason`). All are options of Vitest's own
 * `toMatchScreenshot`, not a wrapper: the matcher keeps its one call shape, which the lint rule
 * `qits/screenshot-kind` checks, and `freezeScreenshots()` strips the four keys before it calls
 * Vitest's matcher, so Vitest never sees them.
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

/**
 * A colour scheme a shot is taken in (`freezeScreenshots({ colorSchemes })`, ticket qits-2083):
 * `prefers-color-scheme` emulated as `light` / `dark`, and the theme attribute on `<html>` set to
 * the same word.
 */
export type ColorScheme = 'LIGHT' | 'DARK';

/** Every {@link ColorScheme}, in the order the shots are taken: LIGHT first. */
export const COLOR_SCHEMES: readonly ColorScheme[] = Object.freeze(['LIGHT', 'DARK']);

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
    /**
     * In an app that gives `freezeScreenshots({ colorSchemes })` (ticket qits-2083), the schemes to
     * take, a non-empty subset of {@link COLOR_SCHEMES}, in place of the app's; needs `reason`.
     * Ignored in an app without the option.
     */
    colorSchemes?: readonly ColorScheme[];
    /**
     * Why `viewports` leaves widths out (`'needs a fine pointer'`), or `colorSchemes` schemes. Required
     * with either; one reason covers both.
     */
    reason?: string;
  }
}

/** One `toMatchScreenshot` call, read: what Vitest gets, and what the freeze records. */
export interface ShotRequest {
  /** The name the spec gave, or `undefined` for Vitest's default. */
  readonly name: string | undefined;
  /**
   * Vitest's options without `kind`, `viewports`, `colorSchemes` and `reason`, or `undefined` when
   * none were given.
   */
  readonly options: Record<string, unknown> | undefined;
  readonly kind: ScreenshotKind | null;
  /** The widths asked for, in preset order, or `undefined` for all of them. */
  readonly viewports: readonly ScreenshotViewport[] | undefined;
  /** The schemes asked for, in {@link COLOR_SCHEMES} order, or `undefined` for the app's. */
  readonly colorSchemes: readonly ColorScheme[] | undefined;
  readonly reason: string | undefined;
  /**
   * Why the call is malformed (a kind, width or scheme outside its enum, `viewports` or
   * `colorSchemes` without a reason).
   */
  readonly problem: string | undefined;
}

const OWN_KEYS = ['kind', 'viewports', 'colorSchemes', 'reason'];

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

  const reason = typeof raw?.['reason'] === 'string' ? raw['reason'] : undefined;
  const viewports = subset(raw?.['viewports'], 'viewports', VIEWPORT_ORDER, problems);
  const colorSchemes = subset(raw?.['colorSchemes'], 'colorSchemes', COLOR_SCHEMES, problems);
  const lists = (['viewports', 'colorSchemes'] as const).filter((key) => raw?.[key] !== undefined);
  if (lists.length > 0 && (reason === undefined || reason.trim() === '')) {
    const what = { viewports: 'widths', colorSchemes: 'schemes' };
    problems.push(
      `its ${lists.join(' and ')} leave ${lists.map((key) => what[key]).join(' and ')} out ` +
        'without a reason (give { reason: "…" })',
    );
  }

  return {
    name,
    options,
    kind,
    viewports,
    colorSchemes,
    reason,
    problem: problems.length > 0 ? problems.join('; ') : undefined,
  };
}

/**
 * An opt-out list (`viewports`, `colorSchemes`) read against its enum, in the enum's order, or
 * `undefined` when not given or malformed (the problem is pushed onto `problems`).
 */
function subset<T extends string>(
  list: unknown,
  key: string,
  order: readonly T[],
  problems: string[],
): T[] | undefined {
  if (list === undefined) return undefined;
  const unknown = Array.isArray(list) ? list.filter((v) => !order.includes(v as T)) : [list];
  if (!Array.isArray(list) || list.length === 0) {
    problems.push(`its ${key} must be a non-empty list of ${quoted(order)}`);
  } else if (unknown.length > 0) {
    problems.push(
      `its ${key} name ${unknown.map((v) => JSON.stringify(v)).join(', ')}, not one of ` +
        quoted(order),
    );
  } else {
    return order.filter((v) => list.includes(v));
  }
  return undefined;
}

/**
 * Reads `freezeScreenshots({ colorSchemes })` (ticket qits-2083): `undefined` (no scheme switching)
 * when not given, else the schemes in {@link COLOR_SCHEMES} order. Throws on anything but a
 * non-empty list of them.
 */
export function colorSchemesOption(value: unknown): readonly ColorScheme[] | undefined {
  if (value === undefined) return undefined;
  const problems: string[] = [];
  const schemes = subset(value, 'colorSchemes', COLOR_SCHEMES, problems);
  if (!schemes) {
    throw new Error(
      `freezeScreenshots: ${problems[0].replace(/^its /, 'the option ')}, such as ` +
        "colorSchemes: ['LIGHT', 'DARK'].",
    );
  }
  return Object.freeze(schemes);
}

/**
 * The schemes a shot is taken in: `undefined` in an app without `colorSchemes` (one shot, no
 * switching, the shot's own `colorSchemes` ignored), else the shot's `colorSchemes` when it gave
 * them, otherwise the app's. An opt-out may name a scheme the app does not take: it is taken all the
 * same, since the shot asked for it by name.
 */
export function shotColorSchemes(
  request: Pick<ShotRequest, 'colorSchemes'>,
  appSchemes: readonly ColorScheme[] | undefined,
): readonly ColorScheme[] | undefined {
  if (!appSchemes) return undefined;
  return request.colorSchemes ?? appSchemes;
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

/**
 * The name the shot at `viewport` is compared under: `<name>-phone`, `-tablet`, `-desktop`; in a
 * colour scheme (ticket qits-2083) the scheme is the last suffix, `<name>[-<viewport>]-light`,
 * `-dark`. `viewport` is `null` for a shot at the test's own viewport.
 */
export function viewportName(
  name: string,
  viewport: ScreenshotViewport | null,
  colorScheme: ColorScheme | null = null,
): string {
  const width = viewport ? `-${viewport.toLowerCase()}` : '';
  const scheme = colorScheme ? `-${colorScheme.toLowerCase()}` : '';
  return `${name}${width}${scheme}`;
}

/** The arguments Vitest's matcher is called with: `name` (when there is one) and the options. */
export function vitestArgs(name: string | undefined, options: Record<string, unknown> | undefined) {
  const args: unknown[] = [];
  if (name !== undefined) args.push(name);
  if (options !== undefined) args.push(options);
  return args;
}

/**
 * The error a failure at one preset width or colour scheme throws: the same error, its message
 * naming the width and the scheme: `at TABLET (1024x768): `, `at TABLET (1024x768), DARK: `, or
 * `at DARK: ` for a scheme at the test's own viewport.
 */
export function atShot(
  error: unknown,
  at: {
    viewport?: ScreenshotViewport | null;
    size?: { width: number; height: number } | null;
    scheme?: ColorScheme | null;
  },
): unknown {
  const parts: string[] = [];
  if (at.viewport && at.size) parts.push(`${at.viewport} (${at.size.width}x${at.size.height})`);
  if (at.scheme) parts.push(at.scheme);
  const prefix = `at ${parts.join(', ')}: `;
  if (error instanceof Error) {
    try {
      error.message = prefix + error.message;
      return error;
    } catch {
      // a read-only message: wrap it instead
    }
  }
  return new Error(prefix + String(error), { cause: error });
}
