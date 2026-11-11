import { HttpClient, HttpEventType, HttpResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  assertRecorded,
  clearRouteRecords,
  clearTestRecords,
  currentRoutePattern,
  currentTestRecords,
  fromGoldenMasterTexts,
  fromGoldenMasters,
  goldenMasterAdvice,
  goldenMastersRequired,
  guardGoldenMasters,
  isRecorded,
  recorded,
  recordedText,
  takeRouteRecords,
} from './golden-master-guard';

/** A golden master body as the Node side sends it: fresh JSON on every read. */
const LIST = '{"entries":[{"project":{"id":"p1","slug":"demo","tags":["a"]}}],"total":1}';
interface List {
  entries: { project: { id: string; slug: string; tags: string[] } }[];
  total: number;
}
const read = async (_state?: string, _operationId?: string): Promise<List> => JSON.parse(LIST);

/** A golden master text body (ticket qits-2058), as the Node side's `text()` sends it. */
const PAGE = '<!doctype html>\n<h1>Demo</h1>\n';
const readText = async (_state?: string, _operationId?: string): Promise<string> => PAGE;

describe('recorded', () => {
  it('registers the body and everything inside it', () => {
    const list = recorded(JSON.parse(LIST) as List);
    expect(isRecorded(list)).toBe(true);
    expect(isRecorded(list.entries)).toBe(true);
    expect(isRecorded(list.entries[0].project)).toBe(true);
    expect(isRecorded(list.entries[0].project.tags)).toBe(true);
  });

  it('does not register a copy, a spread or a slice', () => {
    const list = recorded(JSON.parse(LIST) as List);
    expect(isRecorded({ ...list })).toBe(false);
    expect(isRecorded(list.entries.slice(0, 1))).toBe(false);
    expect(isRecorded(structuredClone(list))).toBe(false);
    expect(isRecorded(JSON.parse(LIST))).toBe(false);
  });

  it('freezes the body, so a change in place throws', () => {
    const list = recorded(JSON.parse(LIST) as List);
    expect(() => (list.total = 2)).toThrow(TypeError);
    expect(() => list.entries.push(list.entries[0])).toThrow(TypeError);
    expect(() => list.entries.splice(0, 1)).toThrow(TypeError);
    expect(() => (list.entries[0].project.slug = 'other')).toThrow(TypeError);
    expect(() => delete (list as Partial<List>).total).toThrow(TypeError);
    expect(list.entries[0].project.slug).toBe('demo');
  });

  it('refuses a bare value, and points a string at recordedText', () => {
    expect(() => recorded('text')).toThrow(/only a JSON object or array/);
    expect(() => recorded('text')).toThrow(
      /recordedText\(…\) or wrap the text reader with fromGoldenMasterTexts\(…\)/,
    );
    expect(() => recorded(null)).toThrow(/only a JSON object or array/);
  });

  it('wraps a reader', async () => {
    const goldenMaster = fromGoldenMasters(read);
    const list = await goldenMaster<List>();
    expect(isRecorded(list.entries)).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it('registers a text by value (ticket qits-2058)', () => {
    const page = recordedText('<p>registered by value</p>');
    expect(page).toBe('<p>registered by value</p>');
    expect(isRecorded(page)).toBe(true);
    expect(isRecorded(['<p>registered', 'by value</p>'].join(' '))).toBe(true); // equal is enough
    expect(isRecorded('<p>never registered</p>')).toBe(false);
    expect(assertRecorded(page, 'text')).toBe(page);
    expect(() => assertRecorded('<p>never registered</p>', 'text')).toThrow(
      /the text is not a golden master recording \(a string\)/,
    );
  });

  it('refuses anything but a string as a text', () => {
    expect(() => recordedText({ html: '' } as unknown as string)).toThrow(
      /only a string can be a text recording, not an object/,
    );
    expect(() => recordedText(null as unknown as string)).toThrow(TypeError);
  });

  it('wraps a text reader', async () => {
    const goldenMasterText = fromGoldenMasterTexts(readText);
    expect(await goldenMasterText()).toBe(PAGE);
    expect(isRecorded(PAGE)).toBe(true);
    const notText = fromGoldenMasterTexts(async () => ({ html: PAGE }));
    await expect(notText()).rejects.toThrow(/only a string can be a text recording/);
  });

  it('asserts a recording for data that does not come over HTTP', async () => {
    const list = await fromGoldenMasters(read)<List>();
    expect(assertRecorded(list.entries[0], 'event')).toBe(list.entries[0]);
    expect(() => assertRecorded({ id: 'p1' }, 'event')).toThrow(
      /the event is not a golden master recording/,
    );
    expect(() => assertRecorded({ id: 'p1' }, 'event')).toThrow(goldenMasterAdvice());
  });
});

describe('guardGoldenMasters', () => {
  let http: HttpTestingController;
  let client: HttpClient;
  let unguard: () => void;
  let answers: unknown[];
  let errors: unknown[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    unguard = guardGoldenMasters({ when: () => true });
    answers = [];
    errors = [];
    client.get('/api/projects', { params: { limit: 20 } }).subscribe({
      next: (body) => answers.push(body),
      error: (error) => errors.push(error),
    });
  });

  afterEach(() => {
    unguard();
    http.verify();
  });

  const request = () => http.expectOne('/api/projects?limit=20');

  it('passes a recorded body', async () => {
    const list = await fromGoldenMasters(read)<List>();
    request().flush(list);
    expect(answers).toEqual([list]);
    expect(answers[0]).toBe(list);
  });

  it('passes a part of a recorded body', async () => {
    const list = await fromGoldenMasters(read)<List>();
    request().flush(list.entries);
    expect(answers[0]).toBe(list.entries);
  });

  it('fails a spread copy, naming the method and URL', async () => {
    const list = await fromGoldenMasters(read)<List>();
    const req = request();
    expect(() => req.flush({ ...list, total: 2 })).toThrow(
      /GET \/api\/projects\?limit=20 was answered 200 with a body that is not a golden master recording \(an object\)/,
    );
    req.flush(null, { status: 500, statusText: 'Server Error' });
    expect(answers).toEqual([]);
  });

  it('fails a slice of a recorded list', async () => {
    const list = await fromGoldenMasters(read)<List>();
    const req = request();
    expect(() => req.flush(list.entries.slice(0, 1))).toThrow(/an array of 1/);
    req.flush(null, { status: 500, statusText: 'Server Error' });
  });

  it('names the provider, state and operation a copy came from, and the fix', async () => {
    const goldenMaster = fromGoldenMasters(read, (state?: string, operationId?: string) => ({
      provider: 'qits-projects-service',
      state,
      operationId,
    }));
    const list = await goldenMaster<List>('a project exists', 'listProjects');
    const req = request();
    let message = '';
    try {
      req.flush(list.entries.slice(0, 1));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "(an array of 1, copied from 'a project exists' / listProjects of qits-projects-service)",
    );
    expect(message).toContain(
      'add a provider state to qits-projects-service (ProviderStates + golden-master recorder)',
    );
    expect(message).toContain(
      "add a pact interaction for it in the consumer’s pact spec next to the store (provider state '<new state>', operationId 'listProjects')",
    );
    expect(message).toContain("Then answer with goldenMaster('<new state>', 'listProjects').");
    req.flush(null, { status: 500, statusText: 'Server Error' });
  });

  it('fails a literal', () => {
    const req = request();
    expect(() => req.flush({ entries: [], total: 0 })).toThrow(/not a golden master recording/);
    expect(() => req.flush('[]')).toThrow(/\(a string\)/);
    expect(() => req.flush({ total: 0 })).toThrow(goldenMasterAdvice());
    req.flush(null, { status: 500, statusText: 'Server Error' });
  });

  it('fails a 2xx answer with no body unless it says 204', () => {
    const req = request();
    expect(() => req.flush(null)).toThrow(/answered 204 with no body/);
    expect(() => req.flush(null)).toThrow(
      /record an empty state in the provider \(for example 'no projects exist'\)/,
    );
    expect(() => req.flush(null, { status: 200, statusText: 'OK' })).toThrow(/with no body/);
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(answers).toEqual([null]);
  });

  it('allows a 500 with any body', () => {
    request().flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    expect(answers).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('checks a response sent as an event', async () => {
    const req = request();
    req.event({ type: HttpEventType.Sent });
    expect(() => req.event(new HttpResponse({ body: { total: 0 }, status: 200 }))).toThrow(
      /not a golden master recording/,
    );
    const list = await fromGoldenMasters(read)<List>();
    req.event(new HttpResponse({ body: list, status: 200 }));
    expect(answers).toEqual([list]);
    req.flush(null, { status: 500, statusText: 'Server Error' });
  });

  it('passes a recorded text to a text request, and the app receives the string', async () => {
    const page = await fromGoldenMasterTexts(readText)();
    const texts: string[] = [];
    client.get('/api/page', { responseType: 'text' }).subscribe((body) => texts.push(body));
    http.expectOne('/api/page').flush(page);
    expect(texts).toEqual([PAGE]);
    request().flush(null, { status: 500, statusText: 'Server Error' });
  });

  it('refuses a text no golden master recorded', () => {
    client.get('/api/page', { responseType: 'text' }).subscribe({ error: () => undefined });
    const req = http.expectOne('/api/page');
    expect(() => req.flush('<h1>Hand written</h1>')).toThrow(
      /GET \/api\/page was answered 200 with a body that is not a golden master recording \(a string\)/,
    );
    recordedText('');
    expect(() => req.flush('')).toThrow(/with no body/); // still an empty answer
    req.flush(null, { status: 500, statusText: 'Server Error' });
    request().flush(null, { status: 500, statusText: 'Server Error' });
  });

  it('checks nothing once removed', () => {
    unguard();
    request().flush({ total: 0 });
    expect(answers).toEqual([{ total: 0 }]);
  });
});

describe('guardGoldenMasters by default', () => {
  it('checks every browser spec except the UI components', () => {
    expect(goldenMastersRequired('/w/app/src/app/routes/x/x.page.browser.spec.ts')).toBe(true);
    expect(goldenMastersRequired('/w/app/src/app/routes/shell.layout.browser.spec.ts')).toBe(true);
    expect(
      goldenMastersRequired('/w/app/src/app/patterns/project-list.patterns.browser.spec.ts'),
    ).toBe(true);
    expect(goldenMastersRequired('/w/app/src/app/ui/card.component.browser.spec.ts')).toBe(false);
    expect(goldenMastersRequired('/w/app/src/app/ui/forms/field.browser.spec.ts')).toBe(false);
    expect(goldenMastersRequired('C:\\w\\app\\src\\app\\ui\\card.browser.spec.ts')).toBe(false);
    expect(goldenMastersRequired('/w/app/src/app/routes/x/x.page.spec.ts')).toBe(false);
  });

  it('takes other globs from syntheticAllowed', () => {
    const allowed = ['src/app/widgets/**', '**/*.demo.browser.spec.ts'];
    expect(goldenMastersRequired('/w/app/src/app/widgets/chip.browser.spec.ts', allowed)).toBe(
      false,
    );
    expect(goldenMastersRequired('/w/app/src/app/x/chip.demo.browser.spec.ts', allowed)).toBe(
      false,
    );
    expect(goldenMastersRequired('/w/app/src/app/ui/card.browser.spec.ts', allowed)).toBe(true);
    expect(goldenMastersRequired('/w/app/other-src/app/widgets/x.browser.spec.ts', allowed)).toBe(
      true,
    );
  });

  describe('on the running test file', () => {
    let http: HttpTestingController;
    let unguard: () => void = () => undefined;
    const runningAs = (testPath: string) => {
      const state = expect.getState();
      vi.spyOn(expect, 'getState').mockReturnValue({ ...state, testPath });
    };
    const answer = () => {
      TestBed.inject(HttpClient).get('/api/x').subscribe();
      http.expectOne('/api/x').flush({ hand: 'written' });
    };

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting()],
      });
      http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => {
      unguard();
      vi.restoreAllMocks();
    });

    it('checks a patterns spec', () => {
      runningAs('/w/app/src/app/patterns/list.patterns.browser.spec.ts');
      unguard = guardGoldenMasters();
      expect(answer).toThrow(/not a golden master recording/);
    });

    it('leaves a UI component spec alone', () => {
      runningAs('/w/app/src/app/ui/card.component.browser.spec.ts');
      unguard = guardGoldenMasters();
      expect(answer).not.toThrow();
    });

    it('takes syntheticAllowed', () => {
      runningAs('/w/app/src/app/ui/card.component.browser.spec.ts');
      unguard = guardGoldenMasters({ syntheticAllowed: ['src/app/widgets/**'] });
      expect(answer).toThrow(/not a golden master recording/);
    });
  });

  it('leaves this spec file alone, as it is not a browser spec', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    const unguard = guardGoldenMasters();
    try {
      let answer: unknown;
      TestBed.inject(HttpClient)
        .get('/api/x')
        .subscribe((body) => (answer = body));
      http.expectOne('/api/x').flush({ hand: 'written' });
      expect(answer).toEqual({ hand: 'written' });
    } finally {
      unguard();
    }
  });
});

@Component({ template: '' })
class Page {}

const projects = fromGoldenMasters(read, (state?: string, operationId?: string) => ({
  provider: 'qits-projects-service',
  state,
  operationId,
}));

const routed = async (url: string) => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        {
          path: 'projects/:slug',
          children: [{ path: 'repositories', component: Page }],
        },
        { path: '', component: Page },
      ]),
    ],
  });
  await (await RouterTestingHarness.create()).navigateByUrl(url);
};

const pages = fromGoldenMasterTexts(
  async (state: string, operationId: string) => `<p>${state} / ${operationId}</p>`,
  (state, operationId) => ({ provider: 'qits-projects-service', state, operationId }),
);

/** Answers a text request (`responseType: 'text'`) with `body`, as a primitive string. */
const answerText = (body: string) => {
  TestBed.inject(HttpClient)
    .get('/api/page', { responseType: 'text' })
    .subscribe({ error: () => undefined });
  TestBed.inject(HttpTestingController).expectOne('/api/page').flush(body);
};

const answer = (body: object | null, opts?: { status?: number; statusText?: string }) => {
  TestBed.inject(HttpClient)
    .get('/api/x')
    .subscribe({ error: () => undefined });
  TestBed.inject(HttpTestingController).expectOne('/api/x').flush(body, opts);
};

describe('route records', () => {
  let unguard: () => void;

  beforeEach(() => {
    clearRouteRecords();
    unguard = guardGoldenMasters({ when: () => true });
  });
  afterEach(() => unguard());

  it('notes the matched route of a recording with a full source', async () => {
    await routed('/projects/demo/repositories');
    const list = await projects<List>('a project exists', 'listProjects');
    answer(list);
    answer(list.entries);
    expect(takeRouteRecords()).toEqual([
      {
        provider: 'qits-projects-service',
        state: 'a project exists',
        operationId: 'listProjects',
        route: 'projects/:slug/repositories',
      },
    ]);
    expect(takeRouteRecords()).toEqual([]);
  });

  it('notes them sorted, and also while the guard checks nothing', async () => {
    unguard();
    unguard = guardGoldenMasters({ when: () => false });
    await routed('/projects/demo/repositories');
    answer(await projects<List>('b state', 'listProjects'));
    answer(await projects<List>('a state', 'listProjects'));
    answer({ hand: 'written' });
    expect(takeRouteRecords().map((r) => r.state)).toEqual(['a state', 'b state']);
  });

  it('notes nothing without a router, a matched path, a body or a full source', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    answer(await projects<List>('a project exists', 'listProjects'));
    expect(takeRouteRecords()).toEqual([]);
    TestBed.resetTestingModule();

    await routed('/');
    answer(await projects<List>('a project exists', 'listProjects'));
    expect(takeRouteRecords()).toEqual([]);
    TestBed.resetTestingModule();

    await routed('/projects/demo/repositories');
    answer(null, { status: 204, statusText: 'No Content' });
    answer(await fromGoldenMasters(read)<List>());
    answer(await projects<List>('a project exists', 'listProjects'), {
      status: 500,
      statusText: 'Server Error',
    });
    expect(takeRouteRecords()).toEqual([]);
  });

  it('notes a response sent as an event', async () => {
    await routed('/projects/demo/repositories');
    const list = await projects<List>('a project exists', 'listProjects');
    TestBed.inject(HttpClient).get('/api/x').subscribe();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/x')
      .event(new HttpResponse({ body: list, status: 200 }));
    expect(takeRouteRecords().map((r) => r.route)).toEqual(['projects/:slug/repositories']);
  });

  it('notes the matched route of a recorded text (ticket qits-2058)', async () => {
    await routed('/projects/demo/repositories');
    const page = await pages('a project exists', 'getReadme');
    answerText(page);
    answerText(page);
    expect(takeRouteRecords()).toEqual([
      {
        provider: 'qits-projects-service',
        state: 'a project exists',
        operationId: 'getReadme',
        route: 'projects/:slug/repositories',
      },
    ]);
  });

  it('forgets them on clear', async () => {
    await routed('/projects/demo/repositories');
    answer(await projects<List>('a project exists', 'listProjects'));
    clearRouteRecords();
    expect(takeRouteRecords()).toEqual([]);
  });

  it('drops, with a warning, the routes noted in another spec file or outside one', async () => {
    await routed('/projects/demo/repositories');
    const state = expect.getState();
    const getState = vi.spyOn(expect, 'getState');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      getState.mockReturnValue({ ...state, testPath: '/w/app/src/app/other.page.browser.spec.ts' });
      answer(await projects<List>('a state', 'listProjects'));
      getState.mockReturnValue({ ...state, testPath: undefined });
      answer(await projects<List>('b state', 'listProjects'));
      getState.mockRestore();
      answer(await projects<List>('c state', 'listProjects'));
      expect(takeRouteRecords().map((r) => r.state)).toEqual(['c state']);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        expect.stringContaining(
          'noted in /w/app/src/app/other.page.browser.spec.ts, not in ' +
            `${state.testPath}: qits-projects-service 'a state' / listProjects on ` +
            'projects/:slug/repositories.',
        ),
        expect.stringContaining('noted in no spec file, not in '),
      ]);
      expect(takeRouteRecords()).toEqual([]); // the dropped ones are forgotten too
    } finally {
      getState.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('route records when a spec file starts', () => {
  let unguard: () => void = () => undefined;
  afterAll(() => unguard());

  it('are left behind by the file before, untaken', async () => {
    unguard = guardGoldenMasters({ when: () => true });
    await routed('/projects/demo/repositories');
    answer(await projects<List>('a project exists', 'listProjects'));
  });

  describe('the next file', () => {
    // As a setup file installs it: while the file is collected, so its beforeAll runs first.
    const unguardNext = guardGoldenMasters({ when: () => true });
    afterAll(() => unguardNext());

    it('starts with none', () => {
      expect(takeRouteRecords()).toEqual([]);
    });
  });
});

describe('test records', () => {
  let unguard: () => void;

  beforeEach(() => {
    clearTestRecords();
    clearRouteRecords();
    unguard = guardGoldenMasters({ when: () => true });
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });
  afterEach(() => unguard());

  it('keeps the recorded answers of the test without a router, sorted and unique', async () => {
    answer(await projects<List>('b state', 'listProjects'));
    answer(await projects<List>('a state', 'listProjects'));
    answer(await projects<List>('a state', 'listProjects'));
    answer(await fromGoldenMasters(read)<List>());
    answer(null, { status: 204, statusText: 'No Content' });
    const failed = await projects<List>('c state', 'listProjects');
    answer(failed, { status: 500, statusText: 'Server Error' });
    const records = [
      { provider: 'qits-projects-service', state: 'a state', operationId: 'listProjects' },
      { provider: 'qits-projects-service', state: 'b state', operationId: 'listProjects' },
    ];
    expect(currentTestRecords()).toEqual(records);
    expect(currentTestRecords()).toEqual(records); // reading does not forget them
    expect(takeRouteRecords()).toEqual([]); // no router: the route ledger is untouched
    expect(currentRoutePattern()).toBeNull();
    clearTestRecords();
    expect(currentTestRecords()).toEqual([]);
  });

  it('keeps a recorded text the test answered with (ticket qits-2058)', async () => {
    answerText(await pages('a state', 'getReadme'));
    expect(currentTestRecords()).toEqual([
      { provider: 'qits-projects-service', state: 'a state', operationId: 'getReadme' },
    ]);
  });
});
