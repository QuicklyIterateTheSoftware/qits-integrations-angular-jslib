// node --test: qits/data-through-fields against a throwaway, typed app under <repo>/tmp (git-ignored).
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import qits from '../index.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// Under the workspace, so `@angular/core` resolves from its node_modules.
mkdirSync('tmp', { recursive: true });
const app = mkdtempSync(join(process.cwd(), 'tmp', 'eslint-data-through-fields-'));
after(() => rmSync(app, { recursive: true, force: true }));

const touch = (path, content = '') => {
  mkdirSync(dirname(join(app, path)), { recursive: true });
  writeFileSync(join(app, path), content);
};
const at = (path) => join(app, path);

touch('package.json', JSON.stringify({ name: 'qits-demo-app' }));
// The tsconfig holds only the generated client; the pages under test run in the default project,
// which takes the same options.
touch(
  'tsconfig.json',
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      skipLibCheck: true,
      noEmit: true,
      lib: ['ES2022', 'DOM'],
    },
    include: ['src/app/api/**/*.ts'],
  }),
);
// A generated client's types.
touch(
  'src/app/api/agents/types.gen.ts',
  [
    'export interface AgentDto {',
    '  agentId: string;',
    '  runtimeStatus: string;',
    '  owner?: { name: string } | null;',
    '  tags: string[];',
    '  createdAt: string;',
    '}',
    'export interface AgentPageDto {',
    '  items: AgentDto[];',
    '  total: number;',
    '}',
    '',
  ].join('\n'),
);
// External templates.
touch(
  'src/app/routes/linked.html',
  '<ul [qitsEntityList]="agents">\n  @for (agent of agents.value()?.items ?? []; track agent.agentId) {\n    <li>{{ agent.runtimeStatus }}</li>\n  }\n</ul>\n',
);
touch(
  'src/app/routes/marked.html',
  '<ul [qitsEntityList]="agents">\n  @for (agent of agents.value()?.items ?? []; track agent.agentId) {\n    <li [qitsEntity]="agent" entityKey="agentId">\n      <span [fieldOf]="agent" qitsField="runtimeStatus">{{ agent.runtimeStatus }}</span>\n    </li>\n  }\n</ul>\n',
);

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: {
        allowDefaultProject: ['src/app/routes/*.ts'],
        defaultProject: 'tsconfig.json',
      },
      tsconfigRootDir: app,
    },
  },
});
const untyped = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const rule = qits.rules['data-through-fields'];

const PAGE = at('src/app/routes/agents.page.ts');
const CARD = at('src/app/routes/agent-card.ts');
const HEADER = [
  "import { Component, computed, input, linkedSignal, model } from '@angular/core';",
  "import { qitsResource } from '@qits/angular';",
  "import type { AgentDto, AgentPageDto } from '../api/agents/types.gen';",
  'declare const LIST_AGENTS: unknown;',
  'declare const GET_AGENT: unknown;',
  '',
].join('\n');
/** A component with an inline template and the given class members. */
const component = (template, ...members) =>
  `${HEADER}@Component({\n  selector: 'app-x',\n  template: \`${template}\`,\n})\nexport class X {\n${members.map((m) => `  ${m}\n`).join('')}}\n`;
/** The same with an external template. */
const linked = (url, ...members) =>
  `${HEADER}@Component({\n  selector: 'app-x',\n  templateUrl: '${url}',\n})\nexport class X {\n${members.map((m) => `  ${m}\n`).join('')}}\n`;

const LIST = 'readonly agents = qitsResource(LIST_AGENTS, () => ({}));';
const DETAIL = 'readonly detail = qitsResource(GET_AGENT, () => ({ id: 1 }));';
const ITEMS = 'readonly items = computed(() => this.agents.value()?.items ?? []);';
/** A list whose rows carry their entity mark, with `row` as one row's content. */
const rows = (row) =>
  `<ul [qitsEntityList]="agents">@for (agent of agents.value()?.items ?? []; track agent.agentId) {<li [qitsEntity]="agent" entityKey="agentId">${row}</li>}</ul>`;
/** A detail root holding `content`. */
const detail = (content) =>
  `@if (detail.value(); as agent) {<section [qitsEntity]="agent" entityKey="agentId" [entitySource]="detail">${content}</section>}`;
/** Where `needle` sits in `code`, as ESLint's 1-based line and column. */
const locOf = (code, needle) => {
  const before = code.slice(0, code.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1).length + 1 };
};

const UNMARKED_ROW = component(rows('{{ agent.runtimeStatus }}'), LIST);

tester.run('data-through-fields', rule, {
  valid: [
    // A resource list, each row and field marked.
    {
      filename: PAGE,
      code: component(
        rows('<span [fieldOf]="agent" qitsField="runtimeStatus">{{ agent.runtimeStatus }}</span>'),
        LIST,
      ),
    },
    // A nested field through `?.`, a fallback, and a mark on an ancestor of the text.
    {
      filename: PAGE,
      code: component(
        rows(
          '<p [fieldOf]="agent" qitsField="owner.name"><b>{{ agent.owner?.name ?? \'—\' }}</b></p>',
        ),
        LIST,
      ),
    },
    // `['x']` and `!` are property reads too.
    {
      filename: PAGE,
      code: component(
        rows('<span [fieldOf]="agent" qitsField="owner.name">{{ agent.owner![\'name\'] }}</span>'),
        LIST,
      ),
    },
    // A detail root: `@if (…; as agent)` aliases the root value.
    {
      filename: PAGE,
      code: component(
        detail('<h1 [fieldOf]="agent" qitsField="runtimeStatus">{{ agent.runtimeStatus }}</h1>'),
        DETAIL,
      ),
    },
    // A path straight off the root, and `@let` aliasing one.
    {
      filename: PAGE,
      code: component(
        '<section [qitsEntity]="detail.value()!" entityKey="agentId">@let owner = detail.value()?.owner;<b [fieldOf]="detail.value()!" qitsField="owner.name">{{ owner?.name }}</b><i [fieldOf]="detail.value()!" [qitsField]="\'runtimeStatus\'">{{ detail.value()?.runtimeStatus }}</i></section>',
        DETAIL,
      ),
    },
    // Static copy, a resource's state and non-API fields are not data.
    {
      filename: PAGE,
      code: component(
        '<h1>Agents</h1><p>{{ title }}</p>@if (agents.isLoading()) {<p>Loading {{ count() }}</p>}',
        LIST,
        "readonly title = 'Agents';",
        'readonly count = computed(() => 3);',
      ),
    },
    // Conditions, classes, styles and attributes are not renders.
    {
      filename: PAGE,
      code: component(
        rows(
          '@if (agent.runtimeStatus === \'RUNNING\') {<b [class.on]="agent.tags.length > 0" [style.color]="agent.owner?.name" [attr.title]="agent.agentId" [title]="agent.agentId">Running</b>}',
        ),
        LIST,
      ),
    },
    // A plain-path computed is an alias of its path: an item of it is a row entity.
    {
      filename: PAGE,
      code: component(
        '<ul [qitsEntityList]="agents">@for (agent of items(); track agent.agentId) {<li [qitsEntity]="agent" entityKey="agentId"><span [fieldOf]="agent" qitsField="agentId">{{ agent.agentId }}</span></li>}</ul>',
        LIST,
        ITEMS,
      ),
    },
    // A computed, a block-bodied computed and a linkedSignal over one path each count as it.
    {
      filename: PAGE,
      code: component(
        '<section [qitsEntity]="detail.value()!" entityKey="agentId"><b [fieldOf]="detail.value()!" qitsField="runtimeStatus">{{ status() }}</b><i [fieldOf]="detail.value()!" qitsField="owner.name">{{ owner() }}</i><u [fieldOf]="detail.value()!" qitsField="tags">{{ tags() }}</u></section>',
        DETAIL,
        'readonly status = computed(() => this.detail.value()?.runtimeStatus);',
        'readonly owner = computed(() => {\n    return this.detail.value()?.owner?.name ?? null;\n  });',
        'readonly tags = linkedSignal(() => this.detail.value()?.tags || []);',
      ),
    },
    // Derived data under a derived mark that lists every path it reads.
    {
      filename: PAGE,
      code: component(
        rows(
          '<span [fieldOf]="agent" [qitsField]="{ derived: [\'createdAt\'] }">{{ agent.createdAt | date }}</span><span [fieldOf]="agent" [qitsField]="{ derived: [\'runtimeStatus\', \'agentId\'] }">{{ agent.runtimeStatus + \' \' + agent.agentId }}</span>',
        ),
        LIST,
      ),
    },
    // A call taking the whole entity reads no field the rule can name.
    {
      filename: PAGE,
      code: component(
        rows(
          '<span [fieldOf]="agent" [qitsField]="{ derived: [\'runtimeStatus\'] }">{{ label(agent) }}</span>',
        ),
        LIST,
        'label(a: AgentDto) { return a.runtimeStatus; }',
      ),
    },
    // A non-alias computed, a ternary and a count under derived marks.
    {
      filename: PAGE,
      code: component(
        '<section [qitsEntity]="detail.value()!" entityKey="agentId"><b [fieldOf]="detail.value()!" [qitsField]="{ derived: [\'runtimeStatus\'] }">{{ shout() }}</b><i [fieldOf]="detail.value()!" [qitsField]="{ derived: [\'tags\', \'runtimeStatus\'] }">{{ detail.value()?.tags?.length ? detail.value()?.runtimeStatus : \'\' }}</i></section>',
        DETAIL,
        'readonly shout = computed(() => this.detail.value()?.runtimeStatus.toUpperCase());',
      ),
    },
    // A joined record: the entity mark makes a derived local an entity root of its own.
    {
      filename: PAGE,
      code: component(
        rows(
          '@if (hosted(agent.agentId); as host) {<span [qitsEntity]="host" entityKey="agentId" [entitySource]="detail" [fieldOf]="host" qitsField="owner.name">{{ host.owner?.name }}</span>}',
        ),
        LIST,
        DETAIL,
        'hosted(id: string) { return this.detail.value(); }',
      ),
    },
    // A bound, non-literal mark is trusted for the path; it still marks the field.
    {
      filename: PAGE,
      code: component(
        rows(
          '<span [fieldOf]="agent" [qitsField]="mark()">{{ agent.runtimeStatus }} {{ agent.createdAt | date }}</span>',
        ),
        LIST,
        "readonly mark = computed(() => 'runtimeStatus' as const);",
      ),
    },
    // A qitsField inside a qitsEntityList without a row mark of its own.
    {
      filename: PAGE,
      code: component(
        '<ul [qitsEntityList]="agents"><li [fieldOf]="agents.value()!" qitsField="total">{{ agents.value()?.total }}</li></ul>',
        LIST,
      ),
    },
    // An API-typed input, traced like a resource value; its component marks its own element.
    {
      filename: CARD,
      code: component(
        '<article [qitsEntity]="agent()" entityKey="agentId"><h2 [fieldOf]="agent()" qitsField="owner.name">{{ agent().owner?.name }}</h2></article>',
        'readonly agent = input.required<AgentDto>();',
      ),
    },
    // An input of a local type is not API data.
    {
      filename: CARD,
      code: component(
        '<p>{{ crumb().label }}</p><p>{{ count() }}</p>',
        'readonly crumb = input.required<{ label: string }>();',
        'readonly count = input(0);',
      ),
    },
    // A ui- component's inputs under a mark; the marks' own inputs are not renders.
    {
      filename: PAGE,
      code: component(
        rows(
          '<ui-chip [fieldOf]="agent" qitsField="runtimeStatus" [label]="agent.runtimeStatus" />',
        ),
        LIST,
      ),
    },
    {
      filename: PAGE,
      code: component(
        '<ui-card [qitsEntityList]="agents"><ui-row [qitsEntity]="detail.value()!" entityKey="agentId" [entitySource]="detail" /></ui-card>',
        LIST,
        DETAIL,
      ),
    },
    // Another element's inputs are not renders, unless `display` names its prefix.
    {
      filename: PAGE,
      code: component(rows('<app-chip [label]="agent.runtimeStatus" />'), LIST),
    },
    {
      filename: PAGE,
      code: component(rows('<ui-chip [label]="agent.runtimeStatus" />'), LIST),
      options: [{ display: ['app-'] }],
    },
    // The resource function by another name.
    {
      filename: PAGE,
      code: component(rows('{{ agent.runtimeStatus }}'), LIST),
      options: [{ resource: 'appResource' }],
    },
    // An external template, marked.
    { filename: PAGE, code: linked('./marked.html', LIST) },
    // A missing templateUrl is the build's to report.
    { filename: PAGE, code: linked('./gone.html', LIST) },
    // Specs are not read.
    { filename: at('src/app/routes/agents.page.spec.ts'), code: UNMARKED_ROW },
  ],
  invalid: [
    // Rendered resource data outside a qitsField, reported where it sits in the template.
    {
      filename: PAGE,
      code: UNMARKED_ROW,
      errors: [
        {
          message:
            '\'agent.runtimeStatus\' renders API data outside any qitsField: mark the element that shows it with [fieldOf]="<entity>" qitsField="<path>" (or [qitsField]="{ derived: [...] }"), or the builder reads it as static copy.',
          ...locOf(UNMARKED_ROW, 'agent.runtimeStatus }}'),
        },
      ],
    },
    // A detail root's field, @let and @if aliases, and a path straight off the root.
    {
      filename: PAGE,
      code: component(
        '@let a = detail.value();@if (detail.value()?.owner; as owner) {<p>{{ owner.name }}</p>}<p>{{ a?.agentId }}</p><p>{{ detail.value()?.createdAt }}</p>',
        DETAIL,
      ),
      errors: [
        { messageId: 'unmarked', data: { expression: 'owner.name', where: '' } },
        { messageId: 'unmarked', data: { expression: 'a?.agentId', where: '' } },
        { messageId: 'unmarked', data: { expression: 'detail.value()?.createdAt', where: '' } },
      ],
    },
    // Content bindings render too.
    {
      filename: PAGE,
      code: component(
        rows(
          '<b [textContent]="agent.agentId"></b><i [innerText]="agent.runtimeStatus"></i><p [innerHTML]="agent.owner?.name"></p>',
        ),
        LIST,
      ),
      errors: [
        { messageId: 'unmarked', data: { expression: '[textContent]="agent.agentId"', where: '' } },
        {
          messageId: 'unmarked',
          data: { expression: '[innerText]="agent.runtimeStatus"', where: '' },
        },
        {
          messageId: 'unmarked',
          data: { expression: '[innerHTML]="agent.owner?.name"', where: '' },
        },
      ],
    },
    // Derived data is rendered data as well.
    {
      filename: PAGE,
      code: component(rows('{{ agent.createdAt | date }}'), LIST),
      errors: [{ messageId: 'unmarked' }],
    },
    // A qitsField outside any entity mark.
    {
      filename: PAGE,
      code: component(
        '<section><span [fieldOf]="detail.value()!" qitsField="runtimeStatus">{{ detail.value()?.runtimeStatus }}</span></section>',
        DETAIL,
      ),
      errors: [
        {
          message:
            'qitsField has no qitsEntity or qitsEntityList at or above it in this template: mark the element that shows the entity the field belongs to.',
          line: 8,
        },
      ],
    },
    // A sibling's entity mark does not count, nor does a bound mark escape the check.
    {
      filename: PAGE,
      code: component(
        '<p [qitsEntity]="detail.value()!" entityKey="agentId"></p><b [fieldOf]="detail.value()!" [qitsField]="mark()">x</b>',
        DETAIL,
        "readonly mark = computed(() => 'agentId' as const);",
      ),
      errors: [{ messageId: 'noEntity' }],
    },
    // Through a pipe or a call under a plain mark: it needs a derived one.
    {
      filename: PAGE,
      code: component(
        rows(
          '<span [fieldOf]="agent" qitsField="createdAt">{{ agent.createdAt | date }}</span><span [fieldOf]="agent" qitsField="runtimeStatus">{{ label(agent) }}</span>',
        ),
        LIST,
        'label(a: AgentDto) { return a.runtimeStatus; }',
      ),
      errors: [
        {
          message:
            "'agent.createdAt | date' is computed from API data, not shown as is: mark it [qitsField]=\"{ derived: ['createdAt'] }\" rather than with a field path.",
        },
        { messageId: 'notDerived', data: { expression: 'label(agent)', paths: '', where: '' } },
      ],
    },
    // Operators, template literals, ternaries, method calls and non-alias computeds are derived.
    {
      filename: PAGE,
      code: component(
        detail(
          '<b [fieldOf]="agent" qitsField="runtimeStatus">{{ agent.runtimeStatus + \'!\' }}</b><b [fieldOf]="agent" qitsField="agentId">{{ \\`#\\${agent.agentId}\\` }}</b><b [fieldOf]="agent" qitsField="tags">{{ agent.tags.length ? \'tagged\' : \'\' }}</b><b [fieldOf]="agent" qitsField="runtimeStatus">{{ agent.runtimeStatus.toLowerCase() }}</b><b [fieldOf]="agent" qitsField="runtimeStatus">{{ shout() }}</b>',
        ),
        DETAIL,
        'readonly shout = computed(() => this.detail.value()?.runtimeStatus.toUpperCase());',
      ),
      errors: [
        {
          messageId: 'notDerived',
          data: { expression: "agent.runtimeStatus + '!'", paths: "'runtimeStatus'", where: '' },
        },
        {
          messageId: 'notDerived',
          data: { expression: '`#${agent.agentId}`', paths: "'agentId'", where: '' },
        },
        {
          messageId: 'notDerived',
          data: { expression: "agent.tags.length ? 'tagged' : ''", paths: "'tags'", where: '' },
        },
        {
          messageId: 'notDerived',
          data: {
            expression: 'agent.runtimeStatus.toLowerCase()',
            paths: "'runtimeStatus'",
            where: '',
          },
        },
        {
          messageId: 'notDerived',
          data: { expression: 'shout()', paths: "'runtimeStatus'", where: '' },
        },
      ],
    },
    // A computed over a plain path is that path: a mark naming another one is wrong.
    {
      filename: PAGE,
      code: component(
        '<section [qitsEntity]="detail.value()!" entityKey="agentId"><b [fieldOf]="detail.value()!" qitsField="agentId">{{ status() }}</b></section>',
        DETAIL,
        "readonly status = computed(() => this.detail.value()?.runtimeStatus ?? '');",
      ),
      errors: [
        {
          messageId: 'wrongField',
          data: { expression: 'status()', path: 'runtimeStatus', mark: 'agentId', where: '' },
        },
      ],
    },
    // A plain-path computed list stays a list of entities, still to be marked.
    {
      filename: PAGE,
      code: component(
        '<ul [qitsEntityList]="agents">@for (agent of items(); track agent.agentId) {<li>{{ agent.agentId }}</li>}</ul>',
        LIST,
        ITEMS,
      ),
      errors: [{ messageId: 'unmarked', data: { expression: 'agent.agentId', where: '' } }],
    },
    // Without an entity mark of its own a joined record stays derived; with one, its paths count.
    {
      filename: PAGE,
      code: component(
        rows(
          '@if (hosted(agent.agentId); as host) {<span [fieldOf]="host" qitsField="owner.name">{{ host.owner?.name }}</span><span [qitsEntity]="host" entityKey="agentId" [fieldOf]="host" qitsField="owner.name">{{ host.runtimeStatus }}</span>}',
        ),
        LIST,
        DETAIL,
        'hosted(id: string) { return this.detail.value(); }',
      ),
      errors: [
        {
          messageId: 'notDerived',
          data: { expression: 'host.owner?.name', paths: "'agentId'", where: '' },
        },
        {
          messageId: 'wrongField',
          data: {
            expression: 'host.runtimeStatus',
            path: 'runtimeStatus',
            mark: 'owner.name',
            where: '',
          },
        },
      ],
    },
    // A literal field path, static or bound, that names another field.
    {
      filename: PAGE,
      code: component(
        rows(
          '<span [fieldOf]="agent" qitsField="name">{{ agent.runtimeStatus }}</span><span [fieldOf]="agent" [qitsField]="\'owner\'">{{ agent.owner?.name }}</span>',
        ),
        LIST,
      ),
      errors: [
        {
          message:
            "'agent.runtimeStatus' shows 'runtimeStatus', but the qitsField it sits under names 'name'.",
        },
        {
          messageId: 'wrongField',
          data: { expression: 'agent.owner?.name', path: 'owner.name', mark: 'owner', where: '' },
        },
      ],
    },
    // A literal derived mark that leaves out a path the content reads.
    {
      filename: PAGE,
      code: component(
        rows(
          '<span [fieldOf]="agent" [qitsField]="{ derived: [\'runtimeStatus\'] }">{{ agent.runtimeStatus + agent.agentId + agent.owner?.name }}</span><span [fieldOf]="agent" [qitsField]="{ derived: [\'tags\'] }">{{ agent.agentId }}</span>',
        ),
        LIST,
      ),
      errors: [
        {
          message:
            "'agent.runtimeStatus + agent.agentId + agent.owner?.name' reads 'agentId', 'owner.name', which the derived qitsField it sits under does not list.",
        },
        {
          messageId: 'missingDerived',
          data: { expression: 'agent.agentId', missing: "'agentId'", where: '' },
        },
      ],
    },
    // An API-typed input: the type itself, a union member, an array element, an alias argument.
    {
      filename: CARD,
      code: component(
        '<p>{{ agent().runtimeStatus }}</p><p>{{ maybe()?.agentId }}</p>@for (a of many(); track a.agentId) {<p>{{ a.owner?.name }}</p>}<p>{{ seen().agentId }}</p><p>{{ page().total }}</p><p>{{ picked().runtimeStatus }}</p>',
        'readonly agent = input.required<AgentDto>();',
        'readonly maybe = input<AgentDto | undefined>();',
        'readonly many = input<readonly AgentDto[]>([]);',
        "readonly seen = input.required<Consumed<AgentDto, ['agentId']>>();",
        'readonly page = model.required<AgentPageDto>();',
        "readonly picked = input(undefined as unknown as Pick<AgentDto, 'runtimeStatus'>);",
      ).replace(
        'declare const LIST_AGENTS',
        'type Consumed<T, P extends readonly string[]> = { [K in keyof T & P[number]]: T[K] };\ndeclare const LIST_AGENTS',
      ),
      errors: [
        { messageId: 'unmarked', data: { expression: 'agent().runtimeStatus', where: '' } },
        { messageId: 'unmarked', data: { expression: 'maybe()?.agentId', where: '' } },
        { messageId: 'unmarked', data: { expression: 'a.owner?.name', where: '' } },
        { messageId: 'unmarked', data: { expression: 'seen().agentId', where: '' } },
        { messageId: 'unmarked', data: { expression: 'page().total', where: '' } },
        { messageId: 'unmarked', data: { expression: 'picked().runtimeStatus', where: '' } },
      ],
    },
    // An input's marks are checked like any other.
    {
      filename: CARD,
      code: component(
        '<article [qitsEntity]="agent()" entityKey="agentId"><h2 [fieldOf]="agent()" qitsField="agentId">{{ agent().owner?.name }}</h2></article>',
        'readonly agent = input.required<AgentDto>();',
      ),
      errors: [
        {
          messageId: 'wrongField',
          data: {
            expression: 'agent().owner?.name',
            path: 'owner.name',
            mark: 'agentId',
            where: '',
          },
        },
      ],
    },
    // A ui- component's inputs are rendered.
    {
      filename: PAGE,
      code: component(rows('<ui-chip [label]="agent.runtimeStatus" />'), LIST),
      errors: [
        { messageId: 'unmarked', data: { expression: '[label]="agent.runtimeStatus"', where: '' } },
      ],
    },
    {
      filename: PAGE,
      code: component(
        rows('<ui-chip [fieldOf]="agent" qitsField="agentId" label="{{ agent.runtimeStatus }}" />'),
        LIST,
      ),
      errors: [
        {
          messageId: 'wrongField',
          data: {
            expression: 'label="{{ agent.runtimeStatus }}"',
            path: 'runtimeStatus',
            mark: 'agentId',
            where: '',
          },
        },
      ],
    },
    // `display` names the prefixes whose inputs render.
    {
      filename: PAGE,
      code: component(rows('<app-chip [label]="agent.runtimeStatus" />'), LIST),
      options: [{ display: ['app-'] }],
      errors: [{ messageId: 'unmarked' }],
    },
    // `resource` names the function a resource field is made with.
    {
      filename: PAGE,
      code: component(
        rows('{{ agent.runtimeStatus }}'),
        'readonly agents = appResource(LIST_AGENTS);',
      ).replace(
        'declare const LIST_AGENTS',
        'declare const appResource: (x: unknown) => { value(): AgentPageDto | undefined };\ndeclare const LIST_AGENTS',
      ),
      options: [{ resource: 'appResource' }],
      errors: [{ messageId: 'unmarked' }],
    },
    // An external template: on templateUrl, naming the file, line and column.
    {
      filename: PAGE,
      code: linked('./linked.html', LIST),
      errors: [
        {
          message:
            '\'agent.runtimeStatus\' (src/app/routes/linked.html:3:12) renders API data outside any qitsField: mark the element that shows it with [fieldOf]="<entity>" qitsField="<path>" (or [qitsField]="{ derived: [...] }"), or the builder reads it as static copy.',
          line: 8,
          column: 3,
        },
      ],
    },
  ],
});

untyped.run('data-through-fields without typed linting', rule, {
  valid: [
    // Specs and the generated clients are not read at all.
    { filename: at('src/app/routes/agents.page.spec.ts'), code: UNMARKED_ROW },
    { filename: at('src/app/api/agents/view.ts'), code: UNMARKED_ROW },
    // Only a component needs the types.
    { filename: PAGE, code: 'export class Plain {}' },
  ],
  invalid: [
    {
      filename: CARD,
      code: component('<p>{{ title }}</p>', "readonly title = 'x';"),
      errors: [
        {
          message:
            'data-through-fields needs typed linting: set languageOptions.parserOptions.projectService',
          line: 10,
        },
      ],
    },
    // Reported once per component class; the resource roots are still traced.
    {
      filename: PAGE,
      code: UNMARKED_ROW,
      errors: [{ messageId: 'unmarked' }, { messageId: 'typedLinting' }],
    },
  ],
});

describe('data-through-fields in recommended', () => {
  const config = (rules) => [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...qits.configs.recommended,
    ...(rules ? [{ files: ['**/*.ts'], rules }] : []),
  ];
  const lint = (rules) =>
    new Linter()
      .verify(UNMARKED_ROW, config(rules), PAGE)
      .filter((m) => m.ruleId === 'qits/data-through-fields');
  it('is not enabled by recommended', () => {
    assert.equal(qits.configs.recommended[0].rules['qits/data-through-fields'], undefined);
    assert.deepEqual(lint(), []);
  });
  it('reports once an app enables it', () => {
    assert.deepEqual(
      lint({ 'qits/data-through-fields': 'error' }).map((m) => m.messageId),
      ['unmarked', 'typedLinting'],
    );
  });
});

describe('data-through-fields in the README', () => {
  const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');
  it('has a row in the rules table', () => {
    assert.match(readme, /^\| `qits\/data-through-fields` +\| \*\*Off\*\* in `recommended`/m);
  });
  it('documents its options and typed linting', () => {
    for (const option of ['clients', 'resource', 'display', 'projectService'])
      assert.ok(readme.includes(`\`${option}\``), option);
    assert.ok(readme.includes("'qits/data-through-fields': 'error'"));
  });
});
