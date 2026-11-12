import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  DEFAULT_ROUTE_SPECS,
  FREEZE_COLOR_SCHEME_COMMAND,
  freezeScreenshots,
  renderedThroughRoutes,
} from './freeze-screenshots';
import {
  atShot,
  COLOR_SCHEMES,
  colorSchemesOption,
  SCREENSHOT_KINDS,
  SCREENSHOT_VIEWPORTS,
  shotColorSchemes,
  shotRequest,
  shotViewports,
  viewportName,
  viewportSize,
  vitestArgs,
} from './screenshot-options';

@Component({ selector: 'qits-stub-page', template: '<p>page</p>' })
class StubPage {}

@Component({ selector: 'qits-other-page', template: '<p>other</p>' })
class OtherPage {}

@Component({ selector: 'qits-stub-layout', imports: [RouterOutlet], template: '<router-outlet />' })
class StubLayout {}

/** The app's routes, as `app.routes.ts` gives them: a root page, and a layout above two pages. */
const routes: Routes = [
  { path: '', pathMatch: 'full', component: StubPage },
  {
    path: 'projects',
    component: StubLayout,
    data: { section: 'projects' },
    children: [
      { path: ':slug', component: StubPage },
      { path: ':slug/work', loadComponent: () => Promise.resolve(OtherPage) },
    ],
  },
];

/** The TestBed's router after opening `url` with `table` provided. */
async function routerAt(table: Routes, url: string): Promise<Router> {
  TestBed.configureTestingModule({ providers: [provideRouter(table)] });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return TestBed.inject(Router);
}

describe('renderedThroughRoutes', () => {
  it("holds for a page opened through the app's routes", async () => {
    // The router copies every route it is given: the match is the router's copy, not the element.
    const router = await routerAt(routes, '/projects/demo');
    expect(router.routerState.snapshot.root.firstChild?.routeConfig).not.toBe(routes[1]);
    expect(renderedThroughRoutes(router, routes)).toBe(true);
  });

  it('holds for the root page, whose route pattern is empty, and for a lazy page', async () => {
    const router = await routerAt(routes, '/');
    expect(renderedThroughRoutes(router, routes)).toBe(true);
    await router.navigateByUrl('/projects/demo/work');
    expect(renderedThroughRoutes(router, routes)).toBe(true);
  });

  it('holds for a copy of the table', async () => {
    expect(renderedThroughRoutes(await routerAt([...routes], '/projects/demo'), routes)).toBe(true);
  });

  it('fails for a stand-in route', async () => {
    const standIn: Routes = [{ path: 'projects/:slug', component: StubPage }];
    const router = await routerAt(standIn, '/projects/demo');
    expect(renderedThroughRoutes(router, standIn)).toBe(true);
    expect(renderedThroughRoutes(router, routes)).toBe(false);
  });

  it('fails for a stand-in layout with fewer children, or another component', async () => {
    const fewer: Routes = [
      { ...routes[1], children: [{ path: ':slug', component: StubPage }] } as (typeof routes)[1],
    ];
    expect(renderedThroughRoutes(await routerAt(fewer, '/projects/demo'), routes)).toBe(false);
  });

  it('fails for a stand-in page with the same path', async () => {
    const other: Routes = [{ path: '', pathMatch: 'full', component: OtherPage }];
    expect(renderedThroughRoutes(await routerAt(other, '/'), routes)).toBe(false);
  });

  it('fails without a router, and for a router that has not navigated', () => {
    expect(renderedThroughRoutes(undefined, routes)).toBe(false);
    expect(renderedThroughRoutes(null, routes)).toBe(false);
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    expect(renderedThroughRoutes(TestBed.inject(Router), routes)).toBe(false);
  });
});

describe('DEFAULT_ROUTE_SPECS', () => {
  it('names the page and layout specs under src/app/routes/', () => {
    const matches = (path: string) => DEFAULT_ROUTE_SPECS.test(path);
    expect(matches('/home/me/app/src/app/routes/projects/projects.page.browser.spec.ts')).toBe(
      true,
    );
    expect(matches('src/app/routes/projects/[slug]/work/work.layout.browser.spec.ts')).toBe(true);
    expect(matches('src/app/layout/shell/shell.layout.browser.spec.ts')).toBe(false);
    expect(matches('src/app/routes/projects/project-card.browser.spec.ts')).toBe(false);
    expect(matches('src/app/patterns/list/list.page.browser.spec.ts')).toBe(false);
  });
});

// Ticket qits-2046: the kind and the preset widths a toMatchScreenshot call gives. The matcher
// itself needs a browser run: vitest-run.test.mjs (screenshots/test) takes the shots.
describe('the screenshot options', () => {
  it('names the kinds and the preset sizes', () => {
    expect(SCREENSHOT_KINDS).toEqual(['DATA', 'NO_DATA', 'PENDING', 'ERROR']);
    expect(SCREENSHOT_VIEWPORTS).toEqual({
      PHONE: { width: 390, height: 844 },
      TABLET: { width: 1024, height: 768 },
      DESKTOP: { width: 1440, height: 900 },
    });
    // Against stock Tailwind v4: PHONE below sm, TABLET between md and xl, DESKTOP above xl.
    expect(SCREENSHOT_VIEWPORTS.PHONE.width).toBeLessThan(640);
    expect(SCREENSHOT_VIEWPORTS.TABLET.width).toBeGreaterThan(768);
    expect(SCREENSHOT_VIEWPORTS.TABLET.width).toBeLessThan(1280);
    expect(SCREENSHOT_VIEWPORTS.DESKTOP.width).toBeGreaterThan(1280);
    expect(Object.isFrozen(SCREENSHOT_VIEWPORTS.PHONE)).toBe(true);
  });

  it('reads the kind after a name or as the only argument, and strips its keys for Vitest', () => {
    for (const kind of SCREENSHOT_KINDS) {
      expect(shotRequest(['list', { kind, timeout: 9 }])).toEqual({
        name: 'list',
        options: { timeout: 9 },
        kind,
        viewports: undefined,
        reason: undefined,
        problem: undefined,
      });
    }
    const alone = shotRequest([{ kind: 'ERROR' }]);
    expect([alone.name, alone.options, alone.kind]).toEqual([undefined, {}, 'ERROR']);
    expect(vitestArgs(alone.name, alone.options)).toEqual([{}]);
    const none = shotRequest([]);
    expect([none.kind, none.options, none.problem]).toEqual([null, undefined, undefined]);
    expect(vitestArgs(none.name, none.options)).toEqual([]);
    expect(vitestArgs('list', undefined)).toEqual(['list']);
    const named = shotRequest(['list']);
    expect([named.name, named.kind, named.options]).toEqual(['list', null, undefined]);
  });

  it('names a kind outside the enum as a problem', () => {
    expect(shotRequest(['x', { kind: 'data' }]).problem).toBe(
      "its kind \"data\" is not one of 'DATA', 'NO_DATA', 'PENDING', 'ERROR'",
    );
    expect(shotRequest(['x', { kind: 'data' }]).kind).toBeNull();
  });

  it('takes an opt-out with a reason, in preset order, and refuses one without or with an unknown width', () => {
    const optOut = shotRequest([
      'hover',
      { kind: 'DATA', viewports: ['DESKTOP', 'TABLET'], reason: 'needs a fine pointer' },
    ]);
    expect(optOut.problem).toBeUndefined();
    expect(optOut.viewports).toEqual(['TABLET', 'DESKTOP']);
    expect(optOut.options).toEqual({});
    expect(shotRequest(['x', { kind: 'DATA', viewports: ['DESKTOP'] }]).problem).toMatch(
      /without a reason/,
    );
    expect(
      shotRequest(['x', { kind: 'DATA', viewports: ['DESKTOP'], reason: '  ' }]).problem,
    ).toMatch(/without a reason/);
    expect(shotRequest(['x', { kind: 'DATA', viewports: ['WATCH'], reason: 'r' }]).problem).toMatch(
      /its viewports name "WATCH", not one of 'PHONE', 'TABLET', 'DESKTOP'/,
    );
    expect(shotRequest(['x', { kind: 'DATA', viewports: [], reason: 'r' }]).problem).toMatch(
      /non-empty list/,
    );
    expect(shotRequest(['x', { kind: 'DATA', viewports: 'PHONE', reason: 'r' }]).problem).toMatch(
      /non-empty list/,
    );
  });

  it('takes every preset width in a viewport spec only, and keeps a tall test viewport', () => {
    expect(shotViewports({ viewports: undefined }, true)).toEqual(['PHONE', 'TABLET', 'DESKTOP']);
    expect(shotViewports({ viewports: ['DESKTOP'] }, true)).toEqual(['DESKTOP']);
    expect(shotViewports({ viewports: undefined }, false)).toBeUndefined();
    // Outside the viewport specs, an opt-out is ignored: one shot at the test's own viewport.
    expect(shotViewports({ viewports: ['DESKTOP'] }, false)).toBeUndefined();
    expect(viewportSize('PHONE', { height: 600 })).toEqual({ width: 390, height: 844 });
    expect(viewportSize('TABLET', { height: 3400 })).toEqual({ width: 1024, height: 3400 });
    expect(viewportName('menu/open', 'PHONE')).toBe('menu/open-phone');
    expect(viewportName('list', 'DESKTOP')).toBe('list-desktop');
  });
});

// Ticket qits-2083: the colour schemes an app takes its shots in, and a shot's opt-out of one. The
// switching itself needs a browser run: vitest-run.test.mjs (screenshots/test) takes the shots.
describe('the colour schemes', () => {
  it('names the schemes, LIGHT first, and the command', () => {
    expect(COLOR_SCHEMES).toEqual(['LIGHT', 'DARK']);
    expect(Object.isFrozen(COLOR_SCHEMES)).toBe(true);
    expect(FREEZE_COLOR_SCHEME_COMMAND).toBe('qitsColorScheme');
  });

  it('reads the option in scheme order, and refuses anything but a non-empty list of them', () => {
    expect(colorSchemesOption(undefined)).toBeUndefined();
    expect(colorSchemesOption(['DARK', 'LIGHT'])).toEqual(['LIGHT', 'DARK']);
    expect(colorSchemesOption(['DARK'])).toEqual(['DARK']);
    expect(() => colorSchemesOption([])).toThrow(
      "freezeScreenshots: the option colorSchemes must be a non-empty list of 'LIGHT', 'DARK', " +
        "such as colorSchemes: ['LIGHT', 'DARK'].",
    );
    expect(() => colorSchemesOption('DARK')).toThrow(/non-empty list/);
    expect(() => colorSchemesOption(['light'])).toThrow(
      /the option colorSchemes name "light", not one of 'LIGHT', 'DARK'/,
    );
  });

  it('refuses a bad option at setup, before it registers anything', () => {
    expect(() =>
      freezeScreenshots({ colorSchemes: ['SEPIA'] as unknown as readonly ['LIGHT'] }),
    ).toThrow(/freezeScreenshots: the option colorSchemes name "SEPIA"/);
  });

  it('takes an opt-out with a reason, strips it for Vitest, and refuses one without', () => {
    const optOut = shotRequest([
      'chart',
      {
        kind: 'DATA',
        colorSchemes: ['DARK', 'LIGHT'],
        reason: 'no dark palette yet',
        scale: 'css',
      },
    ]);
    expect(optOut.problem).toBeUndefined();
    expect(optOut.colorSchemes).toEqual(['LIGHT', 'DARK']);
    expect(optOut.reason).toBe('no dark palette yet');
    expect(optOut.options).toEqual({ scale: 'css' });
    expect(shotRequest(['x', { kind: 'DATA' }]).colorSchemes).toBeUndefined();
    expect(shotRequest(['x', { kind: 'DATA', colorSchemes: ['LIGHT'] }]).problem).toBe(
      'its colorSchemes leave schemes out without a reason (give { reason: "…" })',
    );
    // One reason covers both lists; without it, one problem names both.
    expect(
      shotRequest(['x', { kind: 'DATA', viewports: ['DESKTOP'], colorSchemes: ['LIGHT'] }]).problem,
    ).toBe(
      'its viewports and colorSchemes leave widths and schemes out without a reason (give { reason: "…" })',
    );
    const both = shotRequest([
      'x',
      { kind: 'DATA', viewports: ['DESKTOP'], colorSchemes: ['LIGHT'], reason: 'r' },
    ]);
    expect([both.problem, both.viewports, both.colorSchemes]).toEqual([
      undefined,
      ['DESKTOP'],
      ['LIGHT'],
    ]);
    expect(shotRequest(['x', { colorSchemes: [], reason: 'r' }]).problem).toBe(
      "its colorSchemes must be a non-empty list of 'LIGHT', 'DARK'",
    );
    expect(shotRequest(['x', { colorSchemes: ['DUSK'], reason: 'r' }]).problem).toBe(
      `its colorSchemes name "DUSK", not one of 'LIGHT', 'DARK'`,
    );
  });

  it("takes the app's schemes, the shot's own in their place, and none without the option", () => {
    expect(shotColorSchemes({ colorSchemes: undefined }, ['LIGHT', 'DARK'])).toEqual([
      'LIGHT',
      'DARK',
    ]);
    expect(shotColorSchemes({ colorSchemes: ['DARK'] }, ['LIGHT', 'DARK'])).toEqual(['DARK']);
    // In an app without the option, an opt-out is ignored: one shot, no switching.
    expect(shotColorSchemes({ colorSchemes: ['DARK'] }, undefined)).toBeUndefined();
  });

  it('names a shot with the scheme last, and a failure by width and scheme', () => {
    expect(viewportName('list', 'PHONE', 'DARK')).toBe('list-phone-dark');
    expect(viewportName('list', null, 'LIGHT')).toBe('list-light');
    expect(viewportName('list', 'TABLET')).toBe('list-tablet');
    const size = { width: 1024, height: 768 };
    const message = (at: Parameters<typeof atShot>[1]) =>
      (atShot(new Error('differs'), at) as Error).message;
    expect(message({ viewport: 'TABLET', size, scheme: 'DARK' })).toBe(
      'at TABLET (1024x768), DARK: differs',
    );
    expect(message({ viewport: 'TABLET', size })).toBe('at TABLET (1024x768): differs');
    expect(message({ scheme: 'DARK' })).toBe('at DARK: differs');
    expect((atShot('text', { scheme: 'LIGHT' }) as Error).message).toBe('at LIGHT: text');
  });
});
