// node --test: qits/offline-capable-operations against a throwaway, typed app under <repo>/tmp
// (git-ignored), with JSON and YAML contracts.
import { after, describe, it } from 'node:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import qits from '../index.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

mkdirSync('tmp', { recursive: true });
const app = mkdtempSync(join(process.cwd(), 'tmp', 'eslint-offline-capable-'));
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
    include: ['src/app/core/**/*.ts'],
  }),
);

/** `export const NAME = qitsOperation({...})` for one operation. */
const operation = (name, provider, operationId, method) =>
  `export const ${name} = qitsOperation({\n  provider: '${provider}',\n  operationId: '${operationId}',\n  method: '${method}',\n  call: client,\n  consumes: [],\n});\n`;
touch(
  'src/app/core/things/things.operations.ts',
  [
    "import { qitsOperation } from '@qits/angular';",
    'declare const client: (options: never) => Promise<unknown>;',
    "const PROVIDER = 'qits-things-service';",
    operation('LIST_THINGS', 'qits-things-service', 'listThings', 'GET'),
    operation('RENAME_THING', 'qits-things-service', 'renameThing', 'PUT'),
    operation('GET_PLAIN', 'qits-things-service', 'getPlain', 'GET'),
    operation('UPDATE_PLAIN', 'qits-things-service', 'updatePlain', 'PATCH'),
    operation('FLAGGED_OFF', 'qits-things-service', 'flaggedOff', 'POST'),
    operation('GONE', 'qits-things-service', 'vanished', 'DELETE'),
    // The right operationId under the wrong method is not the operation.
    operation('WRONG_METHOD', 'qits-things-service', 'renameThing', 'POST'),
    operation('YAML_LIST', 'qits-yaml-service', 'listYaml', 'GET'),
    operation('YAML_DELETE', 'qits-yaml-service', 'deleteYaml', 'DELETE'),
    operation('YAML_PLAIN', 'qits-yaml-service', 'createYaml', 'POST'),
    operation('UNLISTED', 'qits-other-service', 'listOthers', 'GET'),
    operation('MISSING_FILE', 'qits-missing-service', 'listMissing', 'GET'),
    operation('BROKEN', 'qits-broken-service', 'listBroken', 'GET'),
    // A const provider is still a literal to the type checker.
    'export const BY_CONST = qitsOperation({\n  provider: PROVIDER,\n  operationId: "getPlain",\n  method: "GET",\n  call: client,\n  consumes: [],\n});',
    // Not an operation the rule can read: a provider that is not a literal, and not qitsOperation.
    'export const DYNAMIC = qitsOperation({\n  provider: String(Date.now()),\n  operationId: "getPlain",\n  method: "GET",\n  call: client,\n  consumes: [],\n});',
    'export const NOT_AN_OPERATION = Object.freeze({ provider: "qits-things-service", operationId: "getPlain", method: "GET" });',
    '',
  ].join('\n'),
);
touch(
  'contracts/qits-things-service.json',
  JSON.stringify({
    openapi: '3.1.0',
    paths: {
      '/things': {
        get: { operationId: 'listThings', 'x-qits-offline': true },
        post: { operationId: 'flaggedOff', 'x-qits-offline': false },
      },
      '/things/{id}': {
        put: { operationId: 'renameThing', 'x-qits-offline': 'true' },
        patch: { operationId: 'updatePlain' },
        get: { operationId: 'getPlain' },
      },
    },
  }),
);
touch(
  'contracts/qits-yaml-service.yml',
  [
    'openapi: 3.1.0',
    'paths:',
    '  /yaml:',
    '    get:',
    '      operationId: listYaml',
    '      x-qits-offline: true',
    '    post:',
    '      operationId: createYaml',
    '  /yaml/{id}:',
    '    delete:',
    '      operationId: deleteYaml',
    '      x-qits-offline: "true"',
    '',
  ].join('\n'),
);
touch('contracts/qits-broken-service.json', '{ "paths": ');

const CONTRACTS = {
  'qits-things-service': 'contracts/qits-things-service.json',
  'qits-yaml-service': './contracts/qits-yaml-service.yml',
  'qits-missing-service': 'contracts/qits-missing-service.yaml',
  'qits-broken-service': 'contracts/qits-broken-service.json',
};
const OPTIONS = [{ contracts: CONTRACTS }];

const PARSER = {
  parser: tseslint.parser,
  parserOptions: {
    projectService: {
      allowDefaultProject: ['src/app/routes/things/*.ts'],
      defaultProject: 'tsconfig.json',
    },
    tsconfigRootDir: app,
  },
};
const tester = new RuleTester({ languageOptions: PARSER });
const untyped = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const rule = qits.rules['offline-capable-operations'];

const PAGE = at('src/app/routes/things/things.page.ts');
const OPERATIONS = '../../core/things/things.operations';
/** A page importing `names` from the operations file, with the given class members. */
const page = (names, ...members) =>
  `import { qitsMutation, qitsResource } from '@qits/angular';\nimport { ${names.join(', ')} } from '${OPERATIONS}';\nexport class ThingsPage {\n${members.map((m) => `  ${m}\n`).join('')}}\n`;
const cached = (op) => `readonly r${op} = qitsResource(${op}, () => ({}), { offline: 'cache' });`;
const queued = (op) => `readonly m${op} = qitsMutation(${op}, { offline: 'queue' });`;

const NOT_CAPABLE = (provider, operationId, policy) =>
  `${provider} ${operationId} is not offline-capable (its contract does not mark it x-qits-offline), so offline: '${policy}' can replay a write twice or overwrite a change: make the operation @OfflineCapable in the provider, or use offline: 'online-only'.`;

tester.run('offline-capable-operations', rule, {
  valid: [
    // JSON: `true` and `"true"`.
    {
      filename: PAGE,
      code: page(['LIST_THINGS', 'RENAME_THING'], cached('LIST_THINGS'), queued('RENAME_THING')),
      options: OPTIONS,
    },
    // YAML: `true` and `"true"`.
    {
      filename: PAGE,
      code: page(['YAML_LIST', 'YAML_DELETE'], cached('YAML_LIST'), queued('YAML_DELETE')),
      options: OPTIONS,
    },
    // An online-only use, or none declared, needs no offline-capable operation.
    {
      filename: PAGE,
      code: page(
        ['GET_PLAIN', 'UPDATE_PLAIN', 'UNLISTED'],
        "readonly a = qitsResource(GET_PLAIN, () => ({}), { offline: 'online-only' });",
        "readonly b = qitsMutation(UPDATE_PLAIN, { offline: 'online-only' });",
        'readonly c = qitsResource(UNLISTED, () => ({}));',
        // The wrong policy for the kind is not an offline use either.
        "readonly d = qitsResource(GET_PLAIN, () => ({}), { offline: 'queue' as never });",
        // A method named like an Object.prototype member is no resource either.
        'readonly e = GET_PLAIN.toString();',
      ),
      options: OPTIONS,
    },
    // An operation the rule cannot read is not reported.
    {
      filename: PAGE,
      code: page(
        ['DYNAMIC', 'NOT_AN_OPERATION'],
        cached('DYNAMIC'),
        cached('NOT_AN_OPERATION'),
        "readonly x = qitsResource(this.pick(), () => ({}), { offline: 'cache' });",
        'pick(): never { throw new Error(); }',
      ),
      options: OPTIONS,
    },
    // Specs are not read.
    {
      filename: at('src/app/routes/things/things.page.spec.ts'),
      code: page(['GET_PLAIN'], cached('GET_PLAIN')),
      options: OPTIONS,
    },
  ],
  invalid: [
    // A plain operation (no mark), through an import from a *.operations.ts file.
    {
      filename: PAGE,
      code: page(['GET_PLAIN'], cached('GET_PLAIN')),
      options: OPTIONS,
      errors: [
        {
          message: NOT_CAPABLE('qits-things-service', 'getPlain', 'cache'),
          line: 4,
          column: 38,
        },
      ],
    },
    {
      filename: PAGE,
      code: page(['UPDATE_PLAIN', 'FLAGGED_OFF'], queued('UPDATE_PLAIN'), queued('FLAGGED_OFF')),
      options: OPTIONS,
      errors: [
        { message: NOT_CAPABLE('qits-things-service', 'updatePlain', 'queue') },
        { message: NOT_CAPABLE('qits-things-service', 'flaggedOff', 'queue') },
      ],
    },
    // YAML without the mark; a const provider.
    {
      filename: PAGE,
      code: page(['YAML_PLAIN', 'BY_CONST'], queued('YAML_PLAIN'), cached('BY_CONST')),
      options: OPTIONS,
      errors: [
        { message: NOT_CAPABLE('qits-yaml-service', 'createYaml', 'queue') },
        { message: NOT_CAPABLE('qits-things-service', 'getPlain', 'cache') },
      ],
    },
    // An operation declared in the file itself, and an aliased import.
    {
      filename: PAGE,
      code: `import { qitsOperation, qitsResource } from '@qits/angular';\nimport { GET_PLAIN as PLAIN } from '${OPERATIONS}';\ndeclare const client: (options: never) => Promise<unknown>;\nconst LOCAL = qitsOperation({ provider: 'qits-things-service', operationId: 'getPlain', method: 'GET', call: client, consumes: [] } as const);\nexport class ThingsPage {\n  ${cached('LOCAL')}\n  ${cached('PLAIN')}\n}\n`,
      options: OPTIONS,
      errors: [
        { message: NOT_CAPABLE('qits-things-service', 'getPlain', 'cache'), line: 6 },
        { message: NOT_CAPABLE('qits-things-service', 'getPlain', 'cache'), line: 7 },
      ],
    },
    // An operation absent from its contract, and one under another method.
    {
      filename: PAGE,
      code: page(['GONE', 'WRONG_METHOD'], queued('GONE'), queued('WRONG_METHOD')),
      options: OPTIONS,
      errors: [
        {
          message:
            "qits-things-service's contract contracts/qits-things-service.json has no DELETE operation 'vanished': the operation is renamed or gone, or the committed document is stale.",
        },
        {
          messageId: 'unknownOperation',
          data: {
            provider: 'qits-things-service',
            path: 'contracts/qits-things-service.json',
            method: 'POST',
            operationId: 'renameThing',
          },
        },
      ],
    },
    // A provider with no entry, a missing file, and a file that does not parse.
    {
      filename: PAGE,
      code: page(
        ['UNLISTED', 'MISSING_FILE', 'BROKEN'],
        cached('UNLISTED'),
        cached('MISSING_FILE'),
        cached('BROKEN'),
      ),
      options: OPTIONS,
      errors: [
        {
          message:
            "qits-other-service listOthers is used with offline: 'cache', but contracts names no document for qits-other-service: commit the provider's docs/openapi.yml and name it in contracts.",
        },
        {
          message:
            "qits-missing-service listMissing is used with offline: 'cache', but its contract contracts/qits-missing-service.yaml does not exist: commit the provider's docs/openapi.yml and name it in contracts.",
        },
        {
          messageId: 'noContract',
          data: {
            provider: 'qits-broken-service',
            operationId: 'listBroken',
            policy: 'cache',
            why: 'its contract contracts/qits-broken-service.json is not a JSON or YAML document',
          },
        },
      ],
    },
  ],
});

untyped.run('offline-capable-operations without typed linting', rule, {
  valid: [
    // Nothing offline: nothing needs the types.
    { filename: PAGE, code: page(['GET_PLAIN'], 'readonly x = 1;'), options: OPTIONS },
  ],
  invalid: [
    // Once per file.
    {
      filename: PAGE,
      code: page(['GET_PLAIN'], cached('GET_PLAIN'), queued('UPDATE_PLAIN')),
      options: OPTIONS,
      errors: [
        {
          message:
            'offline-capable-operations needs typed linting: set languageOptions.parserOptions.projectService',
          line: 4,
        },
      ],
    },
  ],
});

describe('offline-capable-operations options', () => {
  const config = (options) => ({
    plugins: { qits },
    rules: { 'qits/offline-capable-operations': ['error', ...options] },
  });
  const lint = (options) =>
    new Linter().verify(
      page(['GET_PLAIN'], cached('GET_PLAIN')),
      [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, config(options)],
      PAGE,
    );
  it('requires contracts, with at least one provider', () => {
    assert.throws(() => lint([]), /should NOT have fewer than 1 items|must NOT have fewer than 1/);
    assert.throws(() => lint([{}]), /contracts/);
    assert.throws(() => lint([{ contracts: {} }]), /fewer than 1 properties/);
    assert.deepEqual(
      lint([{ contracts: { x: 'y.json' } }]).map((m) => m.messageId),
      ['typedLinting'],
    );
  });
  it('is in no preset', () => {
    for (const config of [...qits.configs.recommended, ...qits.configs.offline])
      assert.equal(config.rules['qits/offline-capable-operations'], undefined);
  });
});

describe('offline-capable-operations documents', () => {
  it('reads a document again once it changes', () => {
    const code = page(['LIST_THINGS'], cached('LIST_THINGS'));
    const run = () =>
      new Linter()
        .verify(
          code,
          [{ files: ['**/*.ts'], languageOptions: PARSER }, config('contracts/changing.json')],
          PAGE,
        )
        .map((m) => m.messageId ?? m.message);
    const config = (path) => ({
      plugins: { qits },
      rules: {
        'qits/offline-capable-operations': [
          'error',
          { contracts: { 'qits-things-service': path } },
        ],
      },
    });
    const write = (marked, mtime) => {
      touch(
        'contracts/changing.json',
        JSON.stringify({
          paths: {
            '/things': {
              get: { operationId: 'listThings', ...(marked ? { 'x-qits-offline': true } : {}) },
            },
          },
        }),
      );
      utimesSync(at('contracts/changing.json'), mtime, mtime);
    };
    write(false, 1000);
    assert.deepEqual(run(), ['notOfflineCapable']);
    write(true, 2000);
    assert.deepEqual(run(), []);
  });

  it('asks for yaml when it is not installed, once per document and file', async () => {
    // A copy of the rule where `yaml` does not resolve: outside the workspace, with only
    // `typescript` beside it.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qits-eslint-noyaml-')));
    after(() => rmSync(outside, { recursive: true, force: true }));
    const here = new URL('..', import.meta.url).pathname;
    mkdirSync(join(outside, 'eslint', 'rules'), { recursive: true });
    copyFileSync(join(here, 'project.mjs'), join(outside, 'eslint', 'project.mjs'));
    copyFileSync(
      join(here, 'rules', 'offline-capable-operations.mjs'),
      join(outside, 'eslint', 'rules', 'offline-capable-operations.mjs'),
    );
    mkdirSync(join(outside, 'node_modules'));
    symlinkSync(
      realpathSync(join(process.cwd(), 'node_modules', 'typescript')),
      join(outside, 'node_modules', 'typescript'),
    );
    const { default: copy } = await import(
      join(outside, 'eslint', 'rules', 'offline-capable-operations.mjs')
    );
    const messages = new Linter().verify(
      page(['YAML_LIST', 'YAML_DELETE'], cached('YAML_LIST'), queued('YAML_DELETE')),
      [
        { files: ['**/*.ts'], languageOptions: PARSER },
        {
          plugins: { copy: { rules: { rule: copy } } },
          rules: { 'copy/rule': ['error', { contracts: CONTRACTS }] },
        },
      ],
      PAGE,
    );
    assert.deepEqual(
      messages.map((m) => [m.message, m.line]),
      [['install yaml to read contracts/qits-yaml-service.yml, or give a .json document', 4]],
    );
  });
});
