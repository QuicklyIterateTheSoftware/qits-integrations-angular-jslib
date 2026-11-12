import { Component } from '@angular/core';
import type { Routes } from '@angular/router';
import { describeRoutes } from './describe-routes';

@Component({ template: '' })
class Page {}

describe('describeRoutes', () => {
  it('joins the parents into fullPath, skips empty paths and never loads a lazy route', () => {
    const load = vi.fn(() => Promise.resolve(Page));
    const routes: Routes = [
      { path: '', pathMatch: 'full', redirectTo: 'projects' },
      {
        path: 'projects/:slug',
        component: Page,
        children: [
          { path: '', loadComponent: load },
          { path: 'repositories', loadComponent: load },
          { path: '', children: [{ path: 'work/:id', loadComponent: load }] },
        ],
      },
      { path: 'lazy', loadChildren: () => Promise.resolve([]) },
      { path: 'old', redirectTo: () => 'projects' },
      { path: '**', component: Page },
    ];
    expect(describeRoutes(routes)).toEqual([
      { path: '', fullPath: '', redirectTo: 'projects' },
      {
        path: 'projects/:slug',
        fullPath: 'projects/:slug',
        children: [
          { path: '', fullPath: 'projects/:slug' },
          { path: 'repositories', fullPath: 'projects/:slug/repositories' },
          {
            path: '',
            fullPath: 'projects/:slug',
            children: [{ path: 'work/:id', fullPath: 'projects/:slug/work/:id' }],
          },
        ],
      },
      { path: 'lazy', fullPath: 'lazy' },
      { path: 'old', fullPath: 'old' },
      { path: '**', fullPath: '**' },
    ]);
    expect(load).not.toHaveBeenCalled();
    // JSON as the browser command sends it: no functions, no components.
    expect(JSON.parse(JSON.stringify(describeRoutes(routes)))).toEqual(describeRoutes(routes));
  });

  // Ticket qits-2049: a route entered from outside the app (an idp redirect, an old bookmarked
  // address) says so with `data: { qitsEntry: true }`.
  it('records entry: true only from a route data of qitsEntry: true, never otherwise', () => {
    const routes: Routes = [
      { path: 'auth/callback', component: Page, data: { qitsEntry: true } },
      { path: 'other', component: Page, data: { qitsEntry: false } },
      { path: 'plain', component: Page, data: { other: 'x' } },
      { path: 'none', component: Page },
    ];
    expect(describeRoutes(routes)).toEqual([
      { path: 'auth/callback', fullPath: 'auth/callback', entry: true },
      { path: 'other', fullPath: 'other' },
      { path: 'plain', fullPath: 'plain' },
      { path: 'none', fullPath: 'none' },
    ]);
  });

  // Ticket qits-2076: a route that renders nothing of its own (a layout's '' child, a :tab child
  // that only feeds the layout a parameter) says so; a grouping route over real pages does not.
  it('records rendersNothing on a route with nothing to render, whose children render nothing too', () => {
    const load = vi.fn(() => Promise.resolve(Page));
    const routes: Routes = [
      {
        path: 'settings',
        component: Page,
        children: [
          { path: '', children: [] },
          { path: ':tab', children: [], data: { qitsEntry: true } },
        ],
      },
      { path: 'group', children: [{ path: 'page', component: Page }] },
      { path: 'nested', children: [{ path: '', children: [{ path: 'leaf' }] }] },
      { path: 'lazy', loadComponent: load },
      { path: 'lazy-children', loadChildren: () => Promise.resolve([]) },
      { path: 'old', redirectTo: 'settings' },
      { path: 'older', redirectTo: () => 'settings' },
      { path: '**' },
    ];
    expect(describeRoutes(routes)).toEqual([
      {
        path: 'settings',
        fullPath: 'settings',
        children: [
          { path: '', fullPath: 'settings', rendersNothing: true },
          { path: ':tab', fullPath: 'settings/:tab', entry: true, rendersNothing: true },
        ],
      },
      {
        path: 'group',
        fullPath: 'group',
        children: [{ path: 'page', fullPath: 'group/page' }],
      },
      {
        path: 'nested',
        fullPath: 'nested',
        rendersNothing: true,
        children: [
          {
            path: '',
            fullPath: 'nested',
            rendersNothing: true,
            children: [{ path: 'leaf', fullPath: 'nested/leaf', rendersNothing: true }],
          },
        ],
      },
      { path: 'lazy', fullPath: 'lazy' },
      { path: 'lazy-children', fullPath: 'lazy-children' },
      { path: 'old', fullPath: 'old', redirectTo: 'settings' },
      { path: 'older', fullPath: 'older' },
      { path: '**', fullPath: '**' },
    ]);
    expect(load).not.toHaveBeenCalled();
  });
});
