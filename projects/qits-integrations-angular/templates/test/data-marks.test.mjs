// node --test: the data-mark directives (ticket qits-2141) under Angular's template type checker.
// Fixture components are compiled with ngtsc (`strictTemplates`, no emit) against the library
// SOURCE (`@qits/angular` mapped to src/public-api.ts), in a throwaway tree under <repo>/tmp
// (git-ignored; inside the repo so `@angular/*` resolve from its node_modules). One program holds
// every fixture; each negative case is its own file, so each assertion knows which one fired.
import { after, before, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import ts from 'typescript';
import { NgtscProgram } from '@angular/compiler-cli';

const LIBRARY = resolve('projects/qits-integrations-angular/src/public-api.ts');

mkdirSync('tmp', { recursive: true });
const dir = mkdtempSync(join(process.cwd(), 'tmp', 'templates-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// What a store declares: a generated client call, its operation and the paths it consumes.
const MODELS = `
import { inject, Injectable } from '@angular/core';
import { qitsOperation, qitsResource } from '@qits/angular';

export interface Agent {
  agentId: string;
  runtimeStatus: 'RUNNING' | 'STOPPED';
  owner?: { name: string; email: string } | null;
  tags: string[];
}
export interface AgentList {
  entries: Agent[];
}
export interface Owner {
  ownerId: string;
  name: string;
}

type Answer<T> =
  | { data: T; error: undefined; response: Response }
  | { data: undefined; error: { message?: string }; response: Response };

declare function listAgents(options?: { query?: { q?: string } }): Promise<Answer<AgentList>>;
declare function getAgent(options: { path: { agentId: string } }): Promise<Answer<Agent>>;
declare function getOwner(options: { path: { ownerId: string } }): Promise<Answer<Owner>>;

export const LIST_AGENTS = qitsOperation({
  provider: 'qits-agents-service',
  operationId: 'listAgents',
  method: 'GET',
  call: listAgents,
  consumes: ['entries[].agentId', 'entries[].runtimeStatus', 'entries[].owner.name'],
});
export const GET_AGENT = qitsOperation({
  provider: 'qits-agents-service',
  operationId: 'getAgent',
  method: 'GET',
  call: getAgent,
  consumes: ['agentId', 'runtimeStatus', 'owner.name', 'tags'],
});
export const GET_OWNER = qitsOperation({
  provider: 'qits-owners-service',
  operationId: 'getOwner',
  method: 'GET',
  call: getOwner,
  consumes: ['ownerId', 'name'],
});

@Injectable({ providedIn: 'root' })
export class AgentsStore {
  readonly agents = qitsResource(LIST_AGENTS, () => ({}));
  readonly agent = qitsResource(GET_AGENT, () => ({ path: { agentId: 'a-1' } }));
  readonly owner = qitsResource(GET_OWNER, () => ({ path: { ownerId: 'o-1' } }));
}
export const store = () => inject(AgentsStore);
`;

// A fixture imports only the directives its template uses: an unused one is a diagnostic too.
const DIRECTIVES = {
  QitsEntityList: /qitsEntityList\b/,
  QitsEntity: /qitsEntity\b/,
  QitsField: /qitsField\b/,
};

const component = (name, template, extra = '') => {
  const used = Object.keys(DIRECTIVES).filter((d) => DIRECTIVES[d].test(template));
  return `
import { Component } from '@angular/core';
import { ${used.join(', ')} } from '@qits/angular';
import { store, type Agent } from './models';

@Component({
  selector: 'app-${name}',
  imports: [${used.join(', ')}],
  template: \`${template}\`,
})
export class Fixture {
  readonly s = store();
  ${extra}
}
`;
};

// Every directive, in each of its uses, over consumed resource values. A static attribute, a
// bound literal and a derived list all name real (consumed) paths and keys.
const FIXTURES = {
  'list-detail-join': component(
    'list-detail-join',
    `
    @if (s.agents.value(); as list) {
      <ul [qitsEntityList]="s.agents">
        @for (agent of list.entries; track agent.agentId) {
          <li [qitsEntity]="agent" entityKey="agentId">
            <span [fieldOf]="agent" qitsField="agentId">{{ agent.agentId }}</span>
            <span [fieldOf]="agent" [qitsField]="'owner.name'">{{ agent.owner?.name }}</span>
            <span [fieldOf]="agent" [qitsField]="{ derived: ['runtimeStatus', 'owner'] }">
              {{ agent.runtimeStatus === 'RUNNING' }}
            </span>
          </li>
        }
      </ul>
    }
    @if (s.agent.value(); as agent) {
      <section [qitsEntity]="agent" [entityKey]="'agentId'" [entitySource]="s.agent">
        <span [fieldOf]="agent" qitsField="owner.name">{{ agent.owner?.name }}</span>
        <span [fieldOf]="agent" [qitsField]="{ derived: ['tags'] }">{{ agent.tags.length }}</span>
        @if (s.owner.value(); as owner) {
          <span [qitsEntity]="owner" entityKey="ownerId" [entitySource]="s.owner">
            <b [fieldOf]="owner" qitsField="name">{{ owner.name }}</b>
          </span>
        }
      </section>
    }
    `,
  ),
  'plain-type': component(
    'plain-type',
    `
    <p [qitsEntity]="agent" entityKey="agentId">
      <span [fieldOf]="agent" qitsField="tags">{{ agent.tags }}</span>
      <span [fieldOf]="agent" qitsField="owner.email">{{ agent.owner?.email }}</span>
    </p>
    `,
    `readonly agent: Agent = { agentId: 'a', runtimeStatus: 'RUNNING', tags: [] };`,
  ),
};

// Each wrong in exactly one place, with the literal the diagnostic is expected to name.
const NEGATIVES = {
  'wrong-field': [`qitsField="runtimStatus"`, 'runtimStatus'],
  'wrong-nested-field': [`qitsField="owner.nme"`, 'owner.nme'],
  'wrong-bound-field': [`[qitsField]="'agentID'"`, 'agentID'],
  'wrong-derived': [`[qitsField]="{ derived: ['tags', 'statuz'] }"`, 'statuz'],
  'unconsumed-field': [`qitsField="owner.email"`, 'owner.email'],
  'array-element': [`qitsField="tags.length"`, 'tags.length'],
};
for (const [name, [binding]] of Object.entries(NEGATIVES)) {
  FIXTURES[name] = component(
    name,
    `
    @if (s.agent.value(); as agent) {
      <section [qitsEntity]="agent" entityKey="agentId" [entitySource]="s.agent">
        <span [fieldOf]="agent" ${binding}>x</span>
      </section>
    }
    `,
  );
}
const KEY_NEGATIVES = {
  'wrong-key': [`entityKey="agentID"`, 'agentID'],
  'wrong-bound-key': [`[entityKey]="'id'"`, 'id'],
  'unconsumed-key': [`entityKey="tags"`, 'tags'],
};
for (const [name, [binding]] of Object.entries(KEY_NEGATIVES)) {
  FIXTURES[name] = component(
    name,
    `
    @if (s.agents.value(); as list) {
      <ul [qitsEntityList]="s.agents">
        @for (agent of list.entries; track agent.agentId) {
          <li [qitsEntity]="agent" ${binding}>x</li>
        }
      </ul>
    }
    `,
  );
}
Object.assign(NEGATIVES, KEY_NEGATIVES);

/** Diagnostics per fixture name; anything outside the fixtures under `other`. */
let diagnostics;

before(() => {
  writeFileSync(join(dir, 'models.ts'), MODELS);
  const rootNames = [join(dir, 'models.ts')];
  for (const [name, source] of Object.entries(FIXTURES)) {
    writeFileSync(join(dir, `${name}.ts`), source);
    rootNames.push(join(dir, `${name}.ts`));
  }
  const options = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    experimentalDecorators: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
    paths: { '@qits/angular': [LIBRARY] },
    strictTemplates: true,
    strictInjectionParameters: true,
    strictInputAccessModifiers: true,
  };
  const host = ts.createCompilerHost(options);
  const program = new NgtscProgram(rootNames, options, host);
  const all = [
    ...program.getTsSyntacticDiagnostics(),
    ...program.getTsSemanticDiagnostics(),
    ...program.getNgStructuralDiagnostics(),
    ...program.getNgSemanticDiagnostics(),
  ];
  diagnostics = { other: [] };
  for (const name of Object.keys(FIXTURES)) diagnostics[name] = [];
  for (const d of all) {
    const file = d.file ? resolve(d.file.fileName) : '';
    const name = Object.keys(FIXTURES).find((n) => file === join(dir, `${n}.ts`));
    diagnostics[name ?? 'other'].push(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }
});

describe('data-mark templates', () => {
  it('compiles the library and the models without a diagnostic', () => {
    assert.deepEqual(diagnostics.other, []);
  });

  it('accepts a list, a detail and a join over consumed values', () => {
    assert.deepEqual(diagnostics['list-detail-join'], []);
  });

  it('accepts whole arrays and nested fields of a plain type', () => {
    assert.deepEqual(diagnostics['plain-type'], []);
  });

  for (const [name, [binding, literal]] of Object.entries(NEGATIVES)) {
    it(`refuses ${name}: ${binding}`, () => {
      const found = diagnostics[name];
      assert.equal(found.length, 1, `one diagnostic expected, got:\n${found.join('\n---\n')}`);
      assert.match(found[0], new RegExp(`'"?${literal.replace('.', '\\.')}"?'`));
    });
  }
});
