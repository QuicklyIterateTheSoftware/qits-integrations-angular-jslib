import { HttpClient, HttpEventType, HttpResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  assertRecorded,
  fromGoldenMasters,
  guardGoldenMasters,
  isRecorded,
  PAGE_AND_LAYOUT_SPECS,
  recorded,
} from './golden-master-guard';

/** A golden master body as the Node side sends it: fresh JSON on every read. */
const LIST = '{"entries":[{"project":{"id":"p1","slug":"demo","tags":["a"]}}],"total":1}';
interface List {
  entries: { project: { id: string; slug: string; tags: string[] } }[];
  total: number;
}
const read = async (): Promise<List> => JSON.parse(LIST);

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

  it('fails a literal', () => {
    const req = request();
    expect(() => req.flush({ entries: [], total: 0 })).toThrow(/not a golden master recording/);
    expect(() => req.flush('[]')).toThrow(/\(a string\)/);
    req.flush(null, { status: 500, statusText: 'Server Error' });
  });

  it('fails a 2xx answer with no body unless it says 204', () => {
    const req = request();
    expect(() => req.flush(null)).toThrow(/answered 204 with no body/);
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
  it('checks page and layout screenshot specs only', () => {
    expect(PAGE_AND_LAYOUT_SPECS.test('src/app/routes/x/x.page.browser.spec.ts')).toBe(true);
    expect(PAGE_AND_LAYOUT_SPECS.test('src/app/routes/shell.layout.browser.spec.ts')).toBe(true);
    expect(PAGE_AND_LAYOUT_SPECS.test('src/app/ui/card.component.browser.spec.ts')).toBe(false);
    expect(PAGE_AND_LAYOUT_SPECS.test('src/app/routes/x/x.page.spec.ts')).toBe(false);
  });

  it('leaves this spec file alone, as it is neither', () => {
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
