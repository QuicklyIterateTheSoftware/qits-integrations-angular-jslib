import { APP_BASE_HREF } from '@angular/common';
import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from './outcome-recorder';
import { exit, outcomes, stay } from './outcomes';
import { QitsExit } from './qits-exit.directive';
import { QitsTriggers } from './qits-triggers.directive';

/**
 * The directives in a real browser: a link's default action is the browser's to take, so whether
 * the directive prevented it is only meaningful where there is one.
 */

@Component({ template: '' })
class Blank {}

@Component({
  imports: [QitsExit, QitsTriggers],
  template: `
    <a id="created" [qitsExit]="create.created" [exitParams]="{ slug: slug(), id: 7 }">Open</a>
    <a id="cancelled" [qitsExit]="create.cancelled" target="_blank">Back</a>
    <button type="button" [qitsTriggers]="[create.created, create.refused]">Create</button>
  `,
})
class Host {
  readonly slug = signal('demo');
  readonly create = outcomes('create-work-item', {
    created: exit('projects/:slug/work/detail/:id'),
    cancelled: exit('projects'),
    refused: stay(),
  });
}

describe('QitsExit and QitsTriggers', () => {
  let fixture: ComponentFixture<Host>;
  let records: OutcomeRecord[];
  /** Whether the app prevented each click's default; the browser's default is then cancelled too. */
  let prevented: boolean[];
  const keep = (event: Event) => {
    prevented.push(event.defaultPrevented);
    event.preventDefault();
  };

  beforeEach(async () => {
    records = [];
    prevented = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
    document.addEventListener('click', keep);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'projects', component: Blank },
          { path: 'projects/:slug/work/detail/:id', component: Blank },
        ]),
        { provide: APP_BASE_HREF, useValue: '/app/' },
      ],
    });
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
  });

  afterEach(() => {
    ɵsetOutcomeRecorder(null);
    document.removeEventListener('click', keep);
  });

  const link = (id: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(`#${id}`)!;

  it('renders a real href under the base href, and the exit’s mark', () => {
    expect(link('created').getAttribute('href')).toBe('/app/projects/demo/work/detail/7');
    expect(link('created').getAttribute('data-qits-outcome')).toBe('create-work-item:created');
    expect(link('cancelled').getAttribute('href')).toBe('/app/projects');
  });

  it('keeps the href in step with its params', async () => {
    fixture.componentInstance.slug.set('other one');
    await fixture.whenStable();
    expect(link('created').getAttribute('href')).toBe('/app/projects/other%20one/work/detail/7');
  });

  it('navigates and records on a plain click', async () => {
    link('created').click();
    await fixture.whenStable();

    expect(prevented).toEqual([true]);
    expect(TestBed.inject(Router).url).toBe('/projects/demo/work/detail/7');
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

  it('leaves a modified or middle click to the browser, and records nothing', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      link('created').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
      );
    }
    link('created').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 }),
    );
    await fixture.whenStable();

    expect(prevented).toEqual([false, false, false, false, false]);
    expect(navigate).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('leaves a link with another target to the browser', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    link('cancelled').click();
    await fixture.whenStable();

    expect(prevented).toEqual([false]);
    expect(navigate).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('marks any element with the outcomes it triggers, in order', () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    expect(button.getAttribute('data-qits-outcome')).toBe(
      'create-work-item:created create-work-item:refused',
    );
  });
});

@Component({
  imports: [QitsExit],
  template: `
    <a
      id="query"
      [qitsExit]="open.detail"
      [exitParams]="{ slug: 'demo', id: 7 }"
      [exitQueryParams]="{ tab: 'work', q: 'a b' }"
      exitFragment="open"
      >Detail</a
    >
    <a id="list" [qitsExit]="open.list" #list="qitsExit">List {{ list.isActive() }}</a>
    <a id="list-exact" [qitsExit]="open.list" [exitActiveExact]="true">List only</a>
    <a id="project" [qitsExit]="open.project" [exitParams]="{ slug: 'demo' }">Project</a>
    <a id="other" [qitsExit]="open.project" [exitParams]="{ slug: 'other' }">Other</a>
  `,
})
class ActiveHost {
  readonly open = outcomes('open-project', {
    detail: exit('projects/:slug/work/detail/:id'),
    list: exit('projects'),
    project: exit('projects/:slug'),
  });
}

describe('QitsExit query, fragment and active state', () => {
  let fixture: ComponentFixture<ActiveHost>;
  let records: OutcomeRecord[];
  let router: Router;

  beforeEach(async () => {
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank },
          { path: 'projects', component: Blank },
          { path: 'projects/:slug', component: Blank },
          { path: 'projects/:slug/work/detail/:id', component: Blank },
        ]),
        { provide: APP_BASE_HREF, useValue: '/app/' },
      ],
    });
    fixture = TestBed.createComponent(ActiveHost);
    router = TestBed.inject(Router);
    await router.navigateByUrl('/projects/demo');
    await fixture.whenStable();
  });

  afterEach(() => ɵsetOutcomeRecorder(null));

  const link = (id: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(`#${id}`)!;

  it('renders the query and fragment in the href, and a plain click goes to that URL', async () => {
    const url = '/projects/demo/work/detail/7?tab=work&q=a%20b#open';
    expect(link('query').getAttribute('href')).toBe(`/app${url}`);

    link('query').click();
    await fixture.whenStable();

    expect(router.url).toBe(url);
    expect(records).toEqual([
      {
        interaction: 'open-project',
        outcome: 'detail',
        kind: 'exit',
        to: 'projects/:slug/work/detail/:id',
        url,
      },
    ]);
  });

  it('marks the current route’s link and its parent’s with aria-current, and no other', () => {
    expect(link('project').getAttribute('aria-current')).toBe('page');
    expect(link('list').getAttribute('aria-current')).toBe('page');
    expect(link('other').hasAttribute('aria-current')).toBe(false);
    expect(link('query').hasAttribute('aria-current')).toBe(false);
  });

  it('keeps a parent’s link inactive below it with exitActiveExact', async () => {
    expect(link('list-exact').hasAttribute('aria-current')).toBe(false);
    await router.navigateByUrl('/projects?page=2#top');
    await fixture.whenStable();
    expect(link('list-exact').getAttribute('aria-current')).toBe('page');
  });

  it('exposes isActive() through #x="qitsExit"', async () => {
    expect(link('list').textContent).toBe('List true');
    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(link('list').textContent).toBe('List false');
    expect(link('list').hasAttribute('aria-current')).toBe(false);
  });

  it('moves aria-current with the navigation', async () => {
    link('other').click();
    await fixture.whenStable();

    expect(router.url).toBe('/projects/other');
    expect(link('other').getAttribute('aria-current')).toBe('page');
    expect(link('project').hasAttribute('aria-current')).toBe(false);
    expect(link('query').hasAttribute('aria-current')).toBe(false);
  });
});
