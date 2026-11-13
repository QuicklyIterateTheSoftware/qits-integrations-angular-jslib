import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { QitsOperationIdentity } from '../resources/operation';
import {
  DATA_QITS_DERIVED,
  DATA_QITS_FIELD,
  DATA_QITS_ITEM,
  DATA_QITS_SOURCE,
  itemMark,
  sourceMark,
} from './data-marks';
import type { QitsFieldMark } from './field-path';
import { QitsEntity } from './qits-entity.directive';
import { QitsEntityList } from './qits-entity-list.directive';
import { QitsField } from './qits-field.directive';

interface Agent {
  agentId: string | null;
  runtimeStatus: string;
  owner?: { name: string } | null;
  tags: string[];
}

const read = (operationId: string): { operation: QitsOperationIdentity } => ({
  operation: { provider: 'qits-agents-service', operationId, method: 'GET' },
});

const alpha: Agent = {
  agentId: 'a-1',
  runtimeStatus: 'RUNNING',
  owner: { name: 'Ada' },
  tags: ['x'],
};

@Component({
  imports: [QitsEntityList, QitsEntity, QitsField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div id="parent">
      <ul id="list" [qitsEntityList]="list()">
        <li id="row" [qitsEntity]="agent()" entityKey="agentId">
          <span id="name" [fieldOf]="agent()" [qitsField]="mark()">{{ agent().owner?.name }}</span>
        </li>
      </ul>
      <section id="detail" [qitsEntity]="agent()" entityKey="agentId" [entitySource]="detail()">
        <b>detail</b>
      </section>
    </div>
  `,
})
class Host {
  readonly list = signal(read('listAgents'));
  readonly detail = signal<{ operation: QitsOperationIdentity } | undefined>(read('getAgent'));
  readonly agent = signal<Agent>(alpha);
  readonly mark = signal<QitsFieldMark<Agent>>('owner.name');
}

function render() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const el = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const update = (change: (host: Host) => void) => {
    change(fixture.componentInstance);
    fixture.detectChanges();
  };
  return { el, update };
}

describe('data marks', () => {
  it('spells the marks', () => {
    expect(sourceMark(read('listAgents').operation)).toBe('qits-agents-service#listAgents');
    expect(itemMark('agentId', 'a-1')).toBe('agentId=a-1');
    expect(itemMark('n', 0)).toBe('n=0');
    expect(itemMark('agentId', null)).toBeNull();
    expect(itemMark('agentId', undefined)).toBeNull();
  });

  it('adds attributes to the host elements and no element', () => {
    const { el } = render();
    expect(el('parent').children).toHaveLength(2);
    expect(el('list').tagName).toBe('UL');
    expect(el('list').children).toHaveLength(1);
    expect(el('row').tagName).toBe('LI');
    expect(el('row').children).toHaveLength(1);
    expect(el('name').tagName).toBe('SPAN');
    expect(el('name').children).toHaveLength(0);
    expect(el('name').textContent).toBe('Ada');
    expect(el('detail').tagName).toBe('SECTION');
    expect(el('detail').children).toHaveLength(1);
  });

  it('marks the list with its source', () => {
    const { el } = render();
    expect(el('list').getAttribute(DATA_QITS_SOURCE)).toBe('qits-agents-service#listAgents');
    expect(el('list').hasAttribute(DATA_QITS_ITEM)).toBe(false);
  });

  it('marks a row with its item and no source', () => {
    const { el } = render();
    expect(el('row').getAttribute(DATA_QITS_ITEM)).toBe('agentId=a-1');
    expect(el('row').hasAttribute(DATA_QITS_SOURCE)).toBe(false);
  });

  it('marks a detail root with its item and its source on the same element', () => {
    const { el } = render();
    expect(el('detail').getAttribute(DATA_QITS_ITEM)).toBe('agentId=a-1');
    expect(el('detail').getAttribute(DATA_QITS_SOURCE)).toBe('qits-agents-service#getAgent');
  });

  it('leaves the item off while the key is nullish', () => {
    const { el, update } = render();
    update((host) => host.agent.set({ ...alpha, agentId: null }));
    expect(el('row').hasAttribute(DATA_QITS_ITEM)).toBe(false);
    expect(el('detail').hasAttribute(DATA_QITS_ITEM)).toBe(false);
  });

  it('marks a field with its path', () => {
    const { el } = render();
    expect(el('name').getAttribute(DATA_QITS_FIELD)).toBe('owner.name');
    expect(el('name').hasAttribute(DATA_QITS_DERIVED)).toBe(false);
  });

  it('marks derived content with its paths, deduplicated, and no field', () => {
    const { el, update } = render();
    update((host) => host.mark.set({ derived: ['tags', 'runtimeStatus', 'tags', 'owner.name'] }));
    expect(el('name').getAttribute(DATA_QITS_DERIVED)).toBe('tags runtimeStatus owner.name');
    expect(el('name').hasAttribute(DATA_QITS_FIELD)).toBe(false);
  });

  it('follows its inputs', () => {
    const { el, update } = render();
    update((host) => {
      host.list.set(read('searchAgents'));
      host.agent.set({ ...alpha, agentId: 'a-2' });
      host.mark.set('runtimeStatus');
      host.detail.set(undefined);
    });
    expect(el('list').getAttribute(DATA_QITS_SOURCE)).toBe('qits-agents-service#searchAgents');
    expect(el('row').getAttribute(DATA_QITS_ITEM)).toBe('agentId=a-2');
    expect(el('name').getAttribute(DATA_QITS_FIELD)).toBe('runtimeStatus');
    expect(el('detail').hasAttribute(DATA_QITS_SOURCE)).toBe(false);
    update((host) => host.mark.set({ derived: ['tags'] }));
    expect(el('name').hasAttribute(DATA_QITS_FIELD)).toBe(false);
    expect(el('name').getAttribute(DATA_QITS_DERIVED)).toBe('tags');
    update((host) => host.mark.set('agentId'));
    expect(el('name').getAttribute(DATA_QITS_FIELD)).toBe('agentId');
    expect(el('name').hasAttribute(DATA_QITS_DERIVED)).toBe(false);
  });
});
