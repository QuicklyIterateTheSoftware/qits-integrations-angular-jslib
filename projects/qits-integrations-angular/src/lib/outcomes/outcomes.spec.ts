import { Component, DOCUMENT, Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type UrlTree } from '@angular/router';
import type { InteractionName, RoutePath } from '@qits/angular';
import { outcomeMark } from './outcome-mark';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from './outcome-recorder';
import {
  exit,
  external,
  outcomes,
  QITS_LEAVE_APP,
  returnTo,
  stay,
  type ExitGoOptions,
  type PathParams,
} from './outcomes';

/*
 * The app's side of the typing seam, as a generated `route-paths.ts` and an app's interactions
 * write it. A module augmentation is global to the program, so every spec compiled with this one
 * sees these names (the outcomes browser specs keep to them); the library build excludes specs.
 * The library's own interactions (`sign-in`, `sign-in-failed`, `session-guard`, `session-expired`)
 * are in the list because its sign-in sources are compiled into the same program.
 */
declare module '@qits/angular' {
  interface QitsApp {
    routePath: '' | 'projects' | 'projects/:slug' | 'projects/:slug/work/detail/:id';
    interaction:
      | 'create-work-item'
      | 'open-project'
      | 'sign-in'
      | 'sign-in-failed'
      | 'session-guard'
      | 'session-expired';
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

  it('go adds the query and fragment it is given, and forwards the rest as behaviour', async () => {
    const create = setUp();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl');

    await expect(
      create.created.go(
        { slug: 'a b', id: 7 },
        {
          queryParams: { tab: 'work', q: 'x y' },
          fragment: 'open',
          replaceUrl: true,
          state: { from: 'list' },
        },
      ),
    ).resolves.toBe(true);

    const url = '/projects/a%20b/work/detail/7?tab=work&q=x%20y#open';
    expect(navigate).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      replaceUrl: true,
      state: { from: 'list' },
    });
    expect(router.serializeUrl(navigate.mock.calls[0][0] as UrlTree)).toBe(url);
    expect(router.url).toBe(url);
    expect(router.lastSuccessfulNavigation()?.extras.state).toEqual({ from: 'list' });
    expect(records).toEqual([
      {
        interaction: 'create-work-item',
        outcome: 'created',
        kind: 'exit',
        to: 'projects/:slug/work/detail/:id',
        url,
      },
    ]);
  });

  it('go takes a query or a fragment alone, and keeps url() path-only', async () => {
    const create = setUp();
    const router = TestBed.inject(Router);
    await create.cancelled.go(undefined, { queryParams: { page: 2 } });
    expect(router.url).toBe('/projects?page=2');
    await create.home.go({}, { fragment: 'top' });
    expect(router.url).toBe('/#top');
    expect(records.map((record) => record.url)).toEqual(['/projects?page=2', '/#top']);
    expect(create.cancelled.url()).toBe('/projects');
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

describe('returnTo and external', () => {
  let records: OutcomeRecord[];
  const assign = vi.fn();

  beforeEach(() => {
    records = [];
    assign.mockReset();
    ɵsetOutcomeRecorder((record) => records.push(record));
  });

  afterEach(() => ɵsetOutcomeRecorder(null));

  /** The declarations, leaving the app through `assign` only. */
  function declare() {
    setUp();
    const injector = Injector.create({
      providers: [{ provide: QITS_LEAVE_APP, useValue: assign }],
      parent: TestBed.inject(Injector),
    });
    return runInInjectionContext(injector, () =>
      outcomes(
        'open-project',
        { back: returnTo(), idp: external('idp'), refused: stay() },
        { triggered: false },
      ),
    );
  }

  it('declare frozen specs', () => {
    expect(returnTo()).toEqual({ kind: 'returnTo' });
    expect(Object.isFrozen(returnTo())).toBe(true);
    expect(external('idp')).toEqual({ kind: 'external', to: 'idp' });
    expect(Object.isFrozen(external('idp'))).toBe(true);
  });

  it('give entries that name themselves', () => {
    const open = declare();
    expect(Object.isFrozen(open.back)).toBe(true);
    expect(open.back).toMatchObject({
      interaction: 'open-project',
      outcome: 'back',
      kind: 'returnTo',
      to: null,
    });
    expect(open.idp).toMatchObject({
      interaction: 'open-project',
      outcome: 'idp',
      kind: 'external',
      to: 'idp',
    });
  });

  it('returnTo go records, then navigates to the URL it is handed', async () => {
    const open = declare();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    await expect(open.back.go('/projects/demo?tab=work', { replaceUrl: true })).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledWith('/projects/demo?tab=work', { replaceUrl: true });
    expect(records).toEqual([
      {
        interaction: 'open-project',
        outcome: 'back',
        kind: 'returnTo',
        to: null,
        url: '/projects/demo?tab=work',
      },
    ]);
  });

  it.each([
    'https://elsewhere.example/',
    '//elsewhere.example/x',
    '/\\elsewhere.example/x',
    '/\t/elsewhere.example/x',
    'javascript:alert(1)',
    'projects',
    '',
  ])('returnTo go takes %j for the root', async (url) => {
    const open = declare();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    await open.back.go(url);
    expect(navigate).toHaveBeenCalledWith('/', undefined);
    expect(records.map((record) => record.url)).toEqual(['/']);
  });

  it('external leave records, then leaves for the href', () => {
    const open = declare();
    open.idp.leave('https://idp.example/idp/authorize?state=s');
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://idp.example/idp/authorize?state=s');
    expect(records).toEqual([
      {
        interaction: 'open-project',
        outcome: 'idp',
        kind: 'external',
        to: 'idp',
        url: 'https://idp.example/idp/authorize?state=s',
      },
    ]);
  });

  it('QITS_LEAVE_APP assigns the DOCUMENT location by default', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { location: { assign } } }],
    });
    TestBed.inject(QITS_LEAVE_APP)('https://idp.example/');
    expect(assign).toHaveBeenCalledExactlyOnceWith('https://idp.example/');
  });

  it('external leave goes through a provided QITS_LEAVE_APP, and still records', () => {
    const leave = vi.fn();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: QITS_LEAVE_APP, useValue: leave }],
    });
    const open = TestBed.runInInjectionContext(() =>
      outcomes('open-project', { idp: external('idp') }),
    );
    open.idp.leave('https://idp.example/idp/authorize');
    expect(leave).toHaveBeenCalledExactlyOnceWith('https://idp.example/idp/authorize');
    expect(assign).not.toHaveBeenCalled();
    expect(records).toEqual([
      {
        interaction: 'open-project',
        outcome: 'idp',
        kind: 'external',
        to: 'idp',
        url: 'https://idp.example/idp/authorize',
      },
    ]);
  });

  it('type their entries', () => {
    const open = declare();
    expectTypeOf(open.idp.to).toEqualTypeOf<'idp'>();
    expectTypeOf(open.back.to).toEqualTypeOf<null>();
    void (() => {
      // @ts-expect-error -- a return takes the URL to go back to
      void open.back.go();
      // @ts-expect-error -- an external is left, not gone to
      void open.idp.go('/');
    });
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
    expectTypeOf<InteractionName>().toEqualTypeOf<
      | 'create-work-item'
      | 'open-project'
      | 'sign-in'
      | 'sign-in-failed'
      | 'session-guard'
      | 'session-expired'
    >();
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
      // @ts-expect-error -- a query is the options' queryParams, not a param
      void create.cancelled.go({ tab: 'work' }, {});
    });
  });

  it('takes the query and fragment in go()’s options', () => {
    const create = setUp();
    expectTypeOf<Parameters<typeof create.cancelled.go>[1]>().toEqualTypeOf<
      ExitGoOptions | undefined
    >();
    void (() => {
      void create.cancelled.go(undefined, { queryParams: { tab: 'work' } });
      void create.cancelled.go({}, { fragment: 'top' });
      void create.created.go({ slug: 'demo', id: 1 }, { queryParams: null, replaceUrl: true });
      // @ts-expect-error -- a fragment is a string
      void create.cancelled.go(undefined, { fragment: 1 });
    });
  });

  it('refuses an unknown interaction', () => {
    void (() => {
      // @ts-expect-error -- not an interaction of the app
      outcomes('delete-everything', { done: stay() });
    });
  });
});
