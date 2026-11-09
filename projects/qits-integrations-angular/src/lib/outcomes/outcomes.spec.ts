import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { InteractionName, RoutePath } from '@qits/angular';
import { outcomeMark } from './outcome-mark';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from './outcome-recorder';
import { exit, outcomes, stay, type PathParams } from './outcomes';

/*
 * The app's side of the typing seam, as a generated `route-paths.ts` and an app's interactions
 * write it. A module augmentation is global to the program, so every spec compiled with this one
 * sees these names (the outcomes browser specs keep to them); the library build excludes specs.
 */
declare module '@qits/angular' {
  interface QitsApp {
    routePath: '' | 'projects' | 'projects/:slug' | 'projects/:slug/work/detail/:id';
    interaction: 'create-work-item' | 'open-project';
  }
}

@Component({ template: '' })
class Blank {}

function setUp() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: '', component: Blank },
        { path: 'projects', component: Blank },
        { path: 'projects/:slug', component: Blank },
        { path: 'projects/:slug/work/detail/:id', component: Blank },
      ]),
    ],
  });
  return TestBed.runInInjectionContext(() =>
    outcomes('create-work-item', {
      created: exit('projects/:slug/work/detail/:id'),
      cancelled: exit('projects'),
      home: exit(''),
      refused: stay(),
    }),
  );
}

describe('outcomes', () => {
  let records: OutcomeRecord[];

  beforeEach(() => {
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
  });

  afterEach(() => ɵsetOutcomeRecorder(null));

  it('gives each declared outcome a frozen entry that names itself', () => {
    const create = setUp();
    expect(Object.isFrozen(create)).toBe(true);
    expect(Object.isFrozen(create.created)).toBe(true);
    expect(create.created).toMatchObject({
      interaction: 'create-work-item',
      outcome: 'created',
      kind: 'exit',
      to: 'projects/:slug/work/detail/:id',
    });
    expect(create.refused).toMatchObject({
      interaction: 'create-work-item',
      outcome: 'refused',
      kind: 'stay',
      to: null,
    });
  });

  it('builds absolute URLs, each param encoded', () => {
    const create = setUp();
    expect(create.created.url({ slug: 'demo', id: 7 })).toBe('/projects/demo/work/detail/7');
    expect(create.created.url({ slug: 'a b/c', id: '%' })).toBe(
      '/projects/a%20b%2Fc/work/detail/%25',
    );
    expect(create.cancelled.url()).toBe('/projects');
    expect(create.home.url()).toBe('/');
  });

  it('throws on a missing param', () => {
    const create = setUp();
    expect(() => create.created.url({ slug: 'demo' } as never)).toThrow(
      "outcomes: the path 'projects/:slug/work/detail/:id' needs the param 'id', and none was given.",
    );
  });

  it('go records, then navigates to the interpolated URL', async () => {
    const create = setUp();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl');

    await expect(create.created.go({ slug: 'demo', id: 7 }, { replaceUrl: true })).resolves.toBe(
      true,
    );

    expect(navigate).toHaveBeenCalledWith('/projects/demo/work/detail/7', { replaceUrl: true });
    expect(router.url).toBe('/projects/demo/work/detail/7');
    expect(records).toEqual([
      {
        interaction: 'create-work-item',
        outcome: 'created',
        kind: 'exit',
        to: 'projects/:slug/work/detail/:id',
        url: '/projects/demo/work/detail/7',
      },
    ]);
  });

  it('go takes no params when the path has none', async () => {
    const create = setUp();
    await create.cancelled.go();
    expect(TestBed.inject(Router).url).toBe('/projects');
  });

  it('reach records a stay and navigates nowhere', async () => {
    const create = setUp();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    create.refused.reach();
    expect(navigate).not.toHaveBeenCalled();
    expect(records).toEqual([
      { interaction: 'create-work-item', outcome: 'refused', kind: 'stay', to: null },
    ]);
  });

  it('records nothing, and still navigates, without a recorder', async () => {
    ɵsetOutcomeRecorder(null);
    const create = setUp();
    create.refused.reach();
    await create.cancelled.go();
    expect(records).toEqual([]);
    expect(TestBed.inject(Router).url).toBe('/projects');
  });

  it('needs an injection context', () => {
    expect(() => outcomes('open-project', { opened: exit('projects/:slug') })).toThrow(/NG0203/);
  });
});

describe('outcomeMark', () => {
  it('joins <interaction>:<outcome> with spaces, in the order given', () => {
    const create = setUp();
    expect(outcomeMark(create.created, create.refused)).toBe(
      'create-work-item:created create-work-item:refused',
    );
    expect(outcomeMark()).toBe('');
  });
});

describe('the typing seam', () => {
  it('takes the app’s names from QitsApp', () => {
    expectTypeOf<RoutePath>().toEqualTypeOf<
      '' | 'projects' | 'projects/:slug' | 'projects/:slug/work/detail/:id'
    >();
    expectTypeOf<InteractionName>().toEqualTypeOf<'create-work-item' | 'open-project'>();
  });

  it('parses the params of a path', () => {
    expectTypeOf<PathParams<'projects/:slug/work/detail/:id'>>().toEqualTypeOf<{
      readonly slug: string | number;
      readonly id: string | number;
    }>();
    expectTypeOf<PathParams<'projects'>>().toEqualTypeOf<Record<never, never>>();
  });

  it('refuses an unknown exit target', () => {
    // @ts-expect-error -- not a route path of the app
    exit('projects/:slug/settings');
    // @ts-expect-error -- a leading slash is not part of a route path
    exit('/projects');
  });

  it('refuses a missing or misspelled go() param', () => {
    const create = setUp();
    void (() => {
      // @ts-expect-error -- id is missing
      void create.created.go({ slug: 'demo' });
      // @ts-expect-error -- slgu is not a param of the path
      void create.created.go({ slgu: 'demo', id: 1 });
      // @ts-expect-error -- the path has params, so they are required
      void create.created.go();
      // @ts-expect-error -- the path has no params
      void create.cancelled.go({ slug: 'demo' });
    });
  });

  it('refuses an unknown interaction', () => {
    void (() => {
      // @ts-expect-error -- not an interaction of the app
      outcomes('delete-everything', { done: stay() });
    });
  });
});
