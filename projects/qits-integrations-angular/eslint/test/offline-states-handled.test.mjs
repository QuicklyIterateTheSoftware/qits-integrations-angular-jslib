// node --test: qits/offline-states-handled against a throwaway, typed app under <repo>/tmp
// (git-ignored).
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const app = mkdtempSync(join(process.cwd(), 'tmp', 'eslint-offline-states-'));
after(() => rmSync(app, { recursive: true, force: true }));

const touch = (path, content = '') => {
  mkdirSync(dirname(join(app, path)), { recursive: true });
  writeFileSync(join(app, path), content);
};
const at = (path) => join(app, path);

touch('package.json', JSON.stringify({ name: 'qits-demo-app' }));
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
    include: ['src/app/env.d.ts'],
  }),
);
touch('src/app/env.d.ts', 'export {};\n');
// External templates.
touch(
  'src/app/routes/things/things.html',
  "@if (things.qitsStatus() === 'offline') {\n  <p>Offline, nothing stored</p>\n} @else {\n  <p>{{ things.value()?.total }}</p>\n}\n",
);
touch(
  'src/app/routes/things/handled.html',
  "@switch (things.qitsStatus()) {\n  @case ('cached') {\n    <p>Stored</p>\n  }\n  @case ('offline') {\n    <p>Offline</p>\n  }\n  @default {\n    <p>{{ things.value()?.total }}</p>\n  }\n}\n",
);

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: {
        allowDefaultProject: ['src/app/routes/things/*.ts'],
        defaultProject: 'tsconfig.json',
      },
      tsconfigRootDir: app,
    },
  },
});
const untyped = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const rule = qits.rules['offline-states-handled'];

const PAGE = at('src/app/routes/things/things.page.ts');
const HEADER = [
  "import { Component, computed, linkedSignal } from '@angular/core';",
  "import { qitsMutation, qitsResource } from '@qits/angular';",
  'declare const LIST_THINGS: unknown;',
  'declare const RENAME_THING: unknown;',
  '',
].join('\n');
/** A component with an inline template and the given class members. */
const component = (template, ...members) =>
  `${HEADER}@Component({\n  selector: 'app-x',\n  template: \`${template}\`,\n})\nexport class ThingsPage {\n${members.map((m) => `  ${m}\n`).join('')}}\n`;
/** The same with an external template. */
const linked = (url, ...members) =>
  `${HEADER}@Component({\n  selector: 'app-x',\n  templateUrl: '${url}',\n})\nexport class ThingsPage {\n${members.map((m) => `  ${m}\n`).join('')}}\n`;

const CACHED = "readonly things = qitsResource(LIST_THINGS, () => ({}), { offline: 'cache' });";
const ONLINE =
  "readonly things = qitsResource(LIST_THINGS, () => ({}), { offline: 'online-only' });";
const QUEUED = "readonly rename = qitsMutation(RENAME_THING, { offline: 'queue' });";
const DIRECT = "readonly rename = qitsMutation(RENAME_THING, { offline: 'online-only' });";
const SHOW = '<p>{{ things.value()?.total }}</p>';
const BOTH_STATES =
  "@if (things.qitsStatus() === 'cached') {<p>Stored</p>} @if (things.qitsStatus() == 'offline') {<p>Offline</p>}";
const RUN = '<button (click)="rename.run({})">Rename</button>';
const QUEUE_STATES =
  "@if (rename.status() !== 'pending') {<p>Sent</p>} @if (rename.status() != 'conflict') {<p>Fine</p>}";

/** One missing state of one field, as the rule reports it. */
const missing = (field, state, line) => ({
  message: `'${field}' can be ${state}, and the template never shows it`,
  ...(line ? { line } : {}),
});

tester.run('offline-states-handled', rule, {
  valid: [
    // A cache resource that shows both states, with each of the comparisons.
    { filename: PAGE, code: component(`${SHOW}${BOTH_STATES}`, CACHED) },
    {
      filename: PAGE,
      code: component(
        "@if ('offline' !== things.qitsStatus()) {<p>{{ things.hasValue() }}</p>} @if (this.things.qitsStatus() === 'cached') {<p>Stored</p>}",
        CACHED,
      ),
    },
    // @switch / @case.
    {
      filename: PAGE,
      code: component(
        "@switch (things.qitsStatus()) { @case ('cached') {<p>Stored</p>} @case ('offline') {<p>Offline</p>} @default {<p>{{ things.value()?.total }}</p>} }",
        CACHED,
      ),
    },
    // cachedAt() shows `cached`.
    {
      filename: PAGE,
      code: component(
        `${SHOW}<small>{{ things.cachedAt() | date }}</small>@if (things.qitsStatus() === 'offline') {<p>Offline</p>}`,
        CACHED,
      ),
    },
    // The compare in a computed the template reads (and a linkedSignal; a switch in one counts).
    {
      filename: PAGE,
      code: component(
        `${SHOW}@if (stale()) {<p>Stored</p>} @if (gone()) {<p>Offline</p>}`,
        CACHED,
        "readonly stale = computed(() => this.things.qitsStatus() === 'cached');",
        "readonly gone = linkedSignal(() => { switch (this.things.qitsStatus()) { case 'offline': return true; default: return false; } });",
      ),
    },
    // A resource rendered only through a computed counts as rendered, and is handled there too.
    {
      filename: PAGE,
      code: component(
        '<p>{{ total() }}</p>@if (state() === "x") {}',
        CACHED,
        'readonly total = computed(() => this.things.value()?.total);',
        "readonly state = computed(() => this.things.qitsStatus() === 'cached' || this.things.qitsStatus() === 'offline' ? 'x' : 'y');",
      ),
    },
    // An online-only resource needs nothing.
    { filename: PAGE, code: component(SHOW, ONLINE) },
    // A cache resource the template never renders needs nothing.
    { filename: PAGE, code: component('<p>Static</p>', CACHED) },
    // A mutation never run needs nothing, queued or not.
    { filename: PAGE, code: component('<p>Static</p>', QUEUED) },
    // A queued run that shows pending and conflict.
    { filename: PAGE, code: component(`${RUN}${QUEUE_STATES}`, QUEUED) },
    // conflict() shows `conflict`; @case under @switch on status().
    {
      filename: PAGE,
      code: component(
        `${RUN}@if (rename.conflict(); as c) {<p>Theirs: {{ c.current }}</p>}@switch (rename.status()) { @case ('pending') {<p>Queued</p>} }`,
        QUEUED,
      ),
    },
    // An online-only run needs conflict only, and a run in the class code counts.
    {
      filename: PAGE,
      code: component(
        "@if (rename.status() === 'conflict') {<p>Changed elsewhere</p>}",
        DIRECT,
        'save() { void this.rename.run({}); }',
      ),
    },
    // An external template.
    { filename: PAGE, code: linked('./handled.html', CACHED) },
    // A policy that is not a string literal is offline-policy-declared's business.
    {
      filename: PAGE,
      code: component(
        `${SHOW}${RUN}`,
        'readonly things = qitsResource(LIST_THINGS, () => ({}), { offline: policy });',
        'readonly rename = qitsMutation(RENAME_THING);',
      ),
    },
    // A template the rule cannot read (an interpolated literal) is not judged.
    {
      filename: PAGE,
      code: component(
        `<p>\${TITLE}</p>${RUN}`,
        DIRECT,
        'save() { void this.rename.run({}); }',
      ).replace(
        'declare const LIST_THINGS',
        'declare const TITLE: string;\ndeclare const LIST_THINGS',
      ),
    },
    // Not a component, and specs, are not read.
    { filename: PAGE, code: `${HEADER}export class Things {\n  ${CACHED}\n}\n` },
    { filename: at('src/app/routes/things/things.page.spec.ts'), code: component(SHOW, CACHED) },
  ],
  invalid: [
    // A cache resource missing both states, on the field's declaration.
    {
      filename: PAGE,
      code: component(SHOW, CACHED),
      errors: [missing('things', 'cached', 10), missing('things', 'offline', 10)],
    },
    // hasValue() and qitsStatus() render it too.
    {
      filename: PAGE,
      code: component('@if (things.hasValue()) {<p>Yes</p>}', CACHED),
      errors: [missing('things', 'cached'), missing('things', 'offline')],
    },
    {
      filename: PAGE,
      code: component(
        "@if (things.qitsStatus() === 'cached') {<p>{{ things.value()?.total }}</p>}",
        CACHED,
      ),
      errors: [missing('things', 'offline')],
    },
    // Comparing the wrong signal does not count: status() never says cached.
    {
      filename: PAGE,
      code: component(
        `${SHOW}@if (things.status() === 'cached') {} @if (things.qitsStatus() === 'offline') {}`,
        CACHED,
      ),
      errors: [missing('things', 'cached')],
    },
    // A computed the template never reads shows nothing; one in the class code neither.
    {
      filename: PAGE,
      code: component(
        `${SHOW}@if (things.qitsStatus() === 'offline') {}`,
        CACHED,
        "readonly stale = computed(() => this.things.qitsStatus() === 'cached');",
      ),
      errors: [missing('things', 'cached')],
    },
    // A queued run that never shows pending.
    {
      filename: PAGE,
      code: component(`${RUN}@if (rename.conflict()) {<p>Conflict</p>}`, QUEUED),
      errors: [missing('rename', 'pending', 10)],
    },
    // A run that never shows conflict, queued or online-only.
    {
      filename: PAGE,
      code: component(`${RUN}@if (rename.status() === 'pending') {<p>Queued</p>}`, QUEUED),
      errors: [missing('rename', 'conflict')],
    },
    {
      filename: PAGE,
      code: component('<p>Static</p>', DIRECT, 'save() { return this.rename.run({}); }'),
      errors: [missing('rename', 'conflict')],
    },
    // @case on a mutation's status() handles only the cases it names.
    {
      filename: PAGE,
      code: component(
        `${RUN}@switch (rename.status()) { @case ('done') {<p>Done</p>} @case ('pending') {<p>Queued</p>} }`,
        QUEUED,
      ),
      errors: [missing('rename', 'conflict')],
    },
    // Both fields at once, each with its own reports.
    {
      filename: PAGE,
      code: component(`${SHOW}${RUN}`, CACHED, QUEUED),
      errors: [
        missing('things', 'cached', 10),
        missing('things', 'offline', 10),
        missing('rename', 'pending', 11),
        missing('rename', 'conflict', 11),
      ],
    },
    // An external template.
    {
      filename: PAGE,
      code: linked('./things.html', CACHED),
      errors: [missing('things', 'cached', 10)],
    },
    // `resource` / `mutation` rename the functions.
    {
      filename: PAGE,
      code: component(
        `${SHOW}${RUN}`,
        "readonly things = appResource(LIST_THINGS, () => ({}), { offline: 'cache' });",
        "readonly rename = appMutation(RENAME_THING, { offline: 'online-only' });",
      ).replace(
        'declare const LIST_THINGS',
        'declare const appResource: any;\ndeclare const appMutation: any;\ndeclare const LIST_THINGS',
      ),
      options: [{ resource: 'appResource', mutation: 'appMutation' }],
      errors: [
        missing('things', 'cached'),
        missing('things', 'offline'),
        missing('rename', 'conflict'),
      ],
    },
  ],
});

untyped.run('offline-states-handled without typed linting', rule, {
  valid: [
    { filename: at('src/app/routes/things/things.page.spec.ts'), code: component(SHOW, CACHED) },
    { filename: PAGE, code: 'export class Plain {}' },
  ],
  invalid: [
    {
      filename: PAGE,
      code: component(SHOW, CACHED),
      errors: [
        {
          message:
            'offline-states-handled needs typed linting: set languageOptions.parserOptions.projectService',
          line: 9,
        },
      ],
    },
  ],
});

describe('offline-states-handled in the offline preset', () => {
  const lint = (configs) =>
    new Linter()
      .verify(
        component(SHOW, CACHED),
        [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, ...configs],
        PAGE,
      )
      .filter((m) => m.ruleId === 'qits/offline-states-handled');
  it('is not enabled by recommended', () => {
    assert.deepEqual(lint(qits.configs.recommended), []);
  });
  it('is enabled by offline', () => {
    assert.deepEqual(
      lint(qits.configs.offline).map((m) => m.messageId),
      ['typedLinting'],
    );
  });
});
