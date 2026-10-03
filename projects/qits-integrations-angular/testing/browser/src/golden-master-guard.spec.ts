import { HttpClient, HttpEventType, HttpResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  assertRecorded,
  fromGoldenMasters,
  goldenMasterAdvice,
  goldenMastersRequired,
  guardGoldenMasters,
  isRecorded,
  recorded,
} from './golden-master-guard';

/** A golden master body as the Node side sends it: fresh JSON on every read. */
const LIST = '{"entries":[{"project":{"id":"p1","slug":"demo","tags":["a"]}}],"total":1}';
interface List {
  entries: { project: { id: string; slug: string; tags: string[] } }[];
  total: number;
}
const read = async (_state?: string, _operationId?: string): Promise<List> => JSON.parse(LIST);

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

  it('refuses a bare value', () => {
    expect(() => recorded('text')).toThrow(/only a JSON object or array/);
    expect(() => recorded(null)).toThrow(/only a JSON object or array/);
  });

  it('wraps a reader', async () => {
    const goldenMaster = fromGoldenMasters(read);
    const list = await goldenMaster<List>();
    expect(isRecorded(list.entries)).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
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
