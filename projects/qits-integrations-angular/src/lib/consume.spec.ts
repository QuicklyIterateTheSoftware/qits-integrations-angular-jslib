import { consume, NOTHING, type Consumed } from './consume';

interface Project {
  id?: string;
  name?: string;
  slug?: string;
  dns?: { domain?: string; type?: string } | null;
}
interface List {
  entries?: { project?: Project; tags?: string[][] }[];
  total: number;
}

type Result =
  | { data: List; error: undefined; response: { status: number } }
  | { data: undefined; error: { message?: string }; response: { status: number } };

const answer = (): Promise<Result> =>
  Promise.resolve({
    data: { entries: [{ project: { id: '1', name: 'a' } }], total: 1 },
    error: undefined,
    response: { status: 200 },
  });

describe('Consumed', () => {
  it('keeps the listed fields, with their optional and nullable modifiers', () => {
    type P = Consumed<Project, ['name', 'dns.domain']>;
    expectTypeOf<P>().toEqualTypeOf<{ name?: string; dns?: { domain?: string } | null }>();
    const p = {} as P;
    // @ts-expect-error -- slug is not listed
    void p.slug;
  });

  it('picks fields of array elements, nested arrays too', () => {
    type L = Consumed<List, ['entries[].project.id', 'entries[].tags[][]']>;
    expectTypeOf<L>().toEqualTypeOf<{
      entries?: { project?: { id?: string }; tags?: string[][] }[];
    }>();
    const l = {} as L;
    // @ts-expect-error -- name is not listed
    void l.entries?.[0].project?.name;
    // @ts-expect-error -- total is not listed
    void l.total;
  });

  it('keeps array elements without their fields', () => {
    type L = Consumed<List, ['entries[]']>;
    expectTypeOf<L>().toEqualTypeOf<{ entries?: Record<never, never>[] }>();
    const l = {} as L;
    // @ts-expect-error -- no field of an element is listed
    void l.entries?.[0].project;
  });

  it('keeps a whole value', () => {
    expectTypeOf<Consumed<List, ['entries']>>().toEqualTypeOf<{ entries?: List['entries'] }>();
  });

  it('keeps nothing for an empty list', () => {
    expectTypeOf<Consumed<Project, typeof NOTHING>>().toEqualTypeOf<Record<never, never>>();
  });
});

describe('consume', () => {
  it('returns the answer unchanged, narrowed to the listed paths', async () => {
    const { data, error, response } = await consume(answer(), ['entries[].project.name']);
    expect(data?.entries?.[0].project?.name).toBe('a');
    expect(error).toBeUndefined();
    expect(response.status).toBe(200);
    // @ts-expect-error -- id is not listed
    void data?.entries?.[0].project?.id;
  });

  it('narrows the error to nothing unless told otherwise', async () => {
    const narrowed = await consume(answer(), NOTHING);
    if (narrowed.error) {
      // @ts-expect-error -- the store reads nothing from an error
      void narrowed.error.message;
    }
    const told = await consume(answer(), NOTHING, ['message']);
    if (told.error) void told.error.message;
  });
});
