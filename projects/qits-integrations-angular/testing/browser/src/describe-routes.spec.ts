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
});
