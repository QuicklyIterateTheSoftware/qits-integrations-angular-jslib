// node --test: qits/offline-policy-declared, and the offline preset, against a throwaway app tree
// under <repo>/tmp (git-ignored).
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

mkdirSync('tmp', { recursive: true });
const app = mkdtempSync(join(process.cwd(), 'tmp', 'eslint-offline-policy-'));
after(() => rmSync(app, { recursive: true, force: true }));

const touch = (path, content = '') => {
  mkdirSync(dirname(join(app, path)), { recursive: true });
  writeFileSync(join(app, path), content);
};
const at = (path) => join(app, path);
touch('package.json', JSON.stringify({ name: 'qits-demo-app' }));

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const rule = qits.rules['offline-policy-declared'];

const PAGE = at('src/app/routes/things/things.page.ts');
const HEAD = "import { qitsMutation, qitsResource } from '@qits/angular';\n";
const field = (init) => `${HEAD}export class ThingsPage {\n  readonly x = ${init};\n}\n`;

const RESOURCE_MESSAGE =
  "qitsResource(...) declares no offline policy: pass { offline: 'cache' | 'online-only' } as its third argument (an object literal with its own offline property), or it is 'online-only' without anyone having decided so.";
const MUTATION_MESSAGE =
  "qitsMutation(...) declares no offline policy: pass { offline: 'queue' | 'online-only' } as its second argument (an object literal with its own offline property), or it is 'online-only' without anyone having decided so.";

tester.run('offline-policy-declared', rule, {
  valid: [
    { filename: PAGE, code: field("qitsResource(GET_THING, () => ({}), { offline: 'cache' })") },
    // `online-only` written out is a decision: the value is not checked.
    {
      filename: PAGE,
      code: field("qitsResource(GET_THING, () => ({}), { offline: 'online-only' })"),
    },
    { filename: PAGE, code: field('qitsResource(GET_THING, () => ({}), { offline: policy })') },
    { filename: PAGE, code: field("qitsMutation(RENAME, { offline: 'queue', affects: [] })") },
    { filename: PAGE, code: field("qitsMutation(RENAME, { 'offline': 'online-only' })") },
    // A spread beside an own key is fine; `as const` / `satisfies` are looked through.
    {
      filename: PAGE,
      code: field("qitsMutation(RENAME, { ...shared, offline: 'queue' } as const)"),
    },
    // Other functions, and specs, are not read.
    { filename: PAGE, code: field('resource({ loader: () => load() })') },
    { filename: at('src/app/routes/things/things.page.spec.ts'), code: field('qitsMutation(X)') },
    // `resource` / `mutation` rename the functions.
    {
      filename: PAGE,
      code: field('qitsResource(GET_THING, () => ({}))'),
      options: [{ resource: 'appResource', mutation: 'appMutation' }],
    },
  ],
  invalid: [
    {
      filename: PAGE,
      code: field('qitsResource(GET_THING, () => ({}))'),
      errors: [{ message: RESOURCE_MESSAGE, line: 3, column: 16 }],
    },
    {
      filename: PAGE,
      code: field('qitsResource(GET_THING, () => ({}), { captureAs: true })'),
      errors: [{ message: RESOURCE_MESSAGE, line: 3, column: 52 }],
    },
    {
      filename: PAGE,
      code: field('qitsMutation(RENAME)'),
      errors: [{ message: MUTATION_MESSAGE }],
    },
    {
      filename: PAGE,
      code: field('qitsMutation(RENAME, { affects: () => [this.things] })'),
      errors: [{ message: MUTATION_MESSAGE }],
    },
    // A spread with no own `offline` key, and an options variable, are not a declaration.
    {
      filename: PAGE,
      code: field('qitsMutation(RENAME, { ...OFFLINE })'),
      errors: [{ message: MUTATION_MESSAGE }],
    },
    {
      filename: PAGE,
      code: field('qitsResource(GET_THING, () => ({}), OPTIONS)'),
      errors: [{ message: RESOURCE_MESSAGE }],
    },
    // A computed key is not an own `offline` property the rule can see.
    {
      filename: PAGE,
      code: field("qitsMutation(RENAME, { [key]: 'queue' })"),
      errors: [{ message: MUTATION_MESSAGE }],
    },
    // A call anywhere counts, not only a field initialiser; `ns.qitsResource` too.
    {
      filename: at('src/app/core/things.ts'),
      code: `${HEAD}export function things() {\n  return [qits.qitsResource(LIST, () => ({})), qitsMutation(RENAME, {})];\n}\n`,
      errors: [{ message: RESOURCE_MESSAGE }, { message: MUTATION_MESSAGE }],
    },
    {
      filename: PAGE,
      code: field('appMutation(RENAME)'),
      options: [{ mutation: 'appMutation' }],
      errors: [
        {
          messageId: 'undeclared',
          data: {
            callee: 'appMutation',
            position: 'second',
            example: "{ offline: 'queue' | 'online-only' }",
          },
        },
      ],
    },
  ],
});

describe('the offline preset', () => {
  const CODE = field('qitsMutation(RENAME)');
  const lint = (configs) =>
    new Linter()
      .verify(
        CODE,
        [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, ...configs],
        PAGE,
      )
      .filter((m) => m.ruleId?.startsWith('qits/offline-'));
  it('recommended enables none of the offline rules', () => {
    const rules = qits.configs.recommended.flatMap((c) => Object.keys(c.rules));
    assert.deepEqual(
      rules.filter((r) => r.startsWith('qits/offline-')),
      [],
    );
    assert.deepEqual(lint(qits.configs.recommended), []);
  });
  it('offline enables the policy and states rules, and not the contracts rule', () => {
    assert.equal(qits.configs.offline.length, 1);
    const [config] = qits.configs.offline;
    assert.equal(config.name, 'qits/offline');
    assert.deepEqual(config.files, ['**/*.ts']);
    assert.equal(config.plugins.qits, qits);
    assert.deepEqual(config.rules, {
      'qits/offline-policy-declared': 'error',
      'qits/offline-states-handled': 'error',
    });
    assert.deepEqual(
      lint([...qits.configs.recommended, ...qits.configs.offline]).map((m) => [
        m.ruleId,
        m.severity,
      ]),
      [['qits/offline-policy-declared', 2]],
    );
  });
  it('registers all three rules', () => {
    for (const name of [
      'offline-policy-declared',
      'offline-states-handled',
      'offline-capable-operations',
    ])
      assert.ok(qits.rules[name], name);
  });
});

describe('the offline rules in the README', () => {
  const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');
  it('has a row for each in the rules table', () => {
    for (const name of [
      'offline-policy-declared',
      'offline-states-handled',
      'offline-capable-operations',
    ])
      assert.match(readme, new RegExp(`^\\| \`qits/${name}\` +\\| \\*\\*Off\\*\\* in`, 'm'), name);
  });
  it('documents the preset and the contracts option', () => {
    assert.ok(readme.includes('### Holding an offline-first app to its policies'));
    assert.ok(readme.includes('qits.configs.offline'));
    assert.ok(readme.includes('contracts'));
    assert.ok(readme.includes('docs/openapi.yml'));
  });
});
