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
