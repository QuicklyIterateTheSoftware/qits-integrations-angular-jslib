import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { DEFAULT_ROUTE_SPECS, renderedThroughRoutes } from './freeze-screenshots';

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
