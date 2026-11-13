import type { Consumed } from '../consume';
import type { QitsFieldMark, QitsFieldPath } from './field-path';

interface Agent {
  agentId: string;
  runtimeStatus: 'RUNNING' | 'STOPPED';
  owner?: { name: string; team: { slug: string } | null } | null;
  tags: string[];
  createdAt: Date;
  restart: () => void;
  history: { at: string }[];
}

interface Deep {
  a: { b: { c: { d: { e: { f: string } } } } };
}

describe('QitsFieldPath', () => {
  it('names the fields, nested ones through null and undefined', () => {
    expectTypeOf<QitsFieldPath<Agent>>().toEqualTypeOf<
      | 'agentId'
      | 'runtimeStatus'
      | 'owner'
      | 'owner.name'
      | 'owner.team'
      | 'owner.team.slug'
      | 'tags'
      | 'createdAt'
      | 'restart'
      | 'history'
    >();
  });

  it('takes arrays, dates and functions whole, without stepping into them', () => {
    const tags: QitsFieldPath<Agent> = 'tags';
    void tags;
    // @ts-expect-error -- no stepping into an array's elements
    const element: QitsFieldPath<Agent> = 'history.at';
    // @ts-expect-error -- no `[]` steps
    const brackets: QitsFieldPath<Agent> = 'history[].at';
    // @ts-expect-error -- an array's own members are not fields
    const length: QitsFieldPath<Agent> = 'tags.length';
    // @ts-expect-error -- a Date is a leaf
    const time: QitsFieldPath<Agent> = 'createdAt.getTime';
    // @ts-expect-error -- a string is a leaf
    const chars: QitsFieldPath<Agent> = 'agentId.length';
    void [element, brackets, length, time, chars];
  });

  it('stops at five keys', () => {
    const five: QitsFieldPath<Deep> = 'a.b.c.d.e';
    void five;
    // @ts-expect-error -- six keys deep
    const six: QitsFieldPath<Deep> = 'a.b.c.d.e.f';
    void six;
  });

  it('steps through a nullable value itself', () => {
    expectTypeOf<QitsFieldPath<Agent | null | undefined>>().toEqualTypeOf<QitsFieldPath<Agent>>();
  });

  it('names only consumed fields of a Consumed value', () => {
    type Seen = Consumed<Agent, ['agentId', 'owner.name']>;
    expectTypeOf<QitsFieldPath<Seen>>().toEqualTypeOf<'agentId' | 'owner' | 'owner.name'>();
    // @ts-expect-error -- runtimeStatus was not consumed
    const status: QitsFieldPath<Seen> = 'runtimeStatus';
    // @ts-expect-error -- owner.team was not consumed
    const team: QitsFieldPath<Seen> = 'owner.team';
    void [status, team];
  });
});

describe('QitsFieldMark', () => {
  it('is a path or the paths a value is derived from', () => {
    const path: QitsFieldMark<Agent> = 'owner.name';
    const derived: QitsFieldMark<Agent> = { derived: ['tags', 'runtimeStatus'] };
    // @ts-expect-error -- not a field of Agent
    const wrong: QitsFieldMark<Agent> = { derived: ['tags', 'status'] };
    void [path, derived, wrong];
  });
});
