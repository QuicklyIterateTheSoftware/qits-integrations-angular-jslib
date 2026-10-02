// node --test: the three rules against a throwaway app tree under <repo>/tmp (git-ignored).
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import qits from '../index.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

mkdirSync('tmp', { recursive: true });
const app = mkdtempSync(join(process.cwd(), 'tmp', 'eslint-rules-'));
after(() => rmSync(app, { recursive: true, force: true }));

const touch = (path, content = '') => {
  mkdirSync(dirname(join(app, path)), { recursive: true });
  writeFileSync(join(app, path), content);
};
touch('package.json', JSON.stringify({ name: 'qits-demo-app' }));
touch('src/app/core/projects/projects.store.pact.spec.ts');
const at = (path) => join(app, path);

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const { rules } = qits;

const CLIENT = "import { getProjects } from '../../api/projects';";

tester.run('client-only-in-stores', rules['client-only-in-stores'], {
  valid: [
    { filename: at('src/app/core/projects/projects.store.ts'), code: CLIENT },
    { filename: at('src/app/core/projects/projects.store.spec.ts'), code: CLIENT },
    { filename: at('src/app/core/projects/projects.store.pact.spec.ts'), code: CLIENT },
    {
      filename: at('src/app/core/projects/card.ts'),
      code: "import { X } from './projects.store';",
    },
    {
      filename: at('src/app/api/projects/sdk.gen.ts'),
      code: "import { client } from './client.gen';",
    },
    {
      filename: at('src/app/core/projects/card.ts'),
      code: "import { getProjects } from '@backend/projects';",
    },
    // A type calls nothing.
    {
      filename: at('src/app/projects/project-card.ts'),
      code: "import type { ProjectDto } from '../api/projects';",
    },
    {
      filename: at('src/app/projects/project-card.ts'),
      code: "import { type ProjectDto } from '../api/projects';",
    },
    // app.config.ts wires the client up.
    {
      filename: at('src/app/app.config.ts'),
      code: "import { client } from './api/projects/client.gen';",
    },
    {
      filename: at('src/app/setup/http.ts'),
      code: "import { client } from '../api/projects/client.gen';",
      options: [{ allow: ['src/app/setup/**'] }],
    },
  ],
  invalid: [
    {
      filename: at('src/app/auth/session.guard.ts'),
      code: "import { getProjectsApiProjects } from '../api/projects';",
      errors: [{ messageId: 'notAStore' }],
    },
    {
      filename: at('src/app/projects/project-card.ts'),
      code: "export { client } from '../api/projects/client.gen';",
      errors: [{ messageId: 'notAStore' }],
    },
    {
      filename: at('src/app/projects/project-card.ts'),
      code: "const api = () => import('../api/projects');",
      errors: [{ messageId: 'notAStore' }],
    },
    {
      filename: at('src/app/projects/project-card.ts'),
      code: "import { getProjects } from '@backend/projects';",
      options: [{ clients: ['@backend/**'] }],
      errors: [{ messageId: 'notAStore' }],
    },
    {
      filename: at('src/app/projects/project-card.ts'),
      code: "import { type ProjectDto, getProjects } from '../api/projects';",
      errors: [{ messageId: 'notAStore' }],
    },
  ],
});

tester.run('store-has-pact', rules['store-has-pact'], {
  valid: [
    { filename: at('src/app/core/projects/projects.store.ts'), code: CLIENT },
    {
      filename: at('src/app/core/other/other.store.ts'),
      code: "import { signalStore } from '@ngrx/signals';",
    },
    {
      filename: at('src/app/core/users/users.store.ts'),
      code: "import type { UserDto } from '../../api/users';",
    },
  ],
  invalid: [
    {
      filename: at('src/app/core/users/users.store.ts'),
      code: `${CLIENT}\nimport { client } from '../../api/projects/client.gen';`,
      errors: [
        {
          messageId: 'noPact',
          data: { specifier: '../../api/projects', pact: 'users.store.pact.spec.ts' },
        },
      ],
    },
  ],
});

const STORE = at('src/app/core/projects/projects.store.ts');
const SDK =
  "import { getProjects, getProjectsResource, type ProjectDto } from '../../api/projects';";

tester.run('consume-client-calls', rules['consume-client-calls'], {
  valid: [
    { filename: STORE, code: `${SDK}\nconst r = await consume(getProjects(), PATHS);` },
    {
      filename: STORE,
      code: `${SDK}\nconsume(getProjects({ path: { id } }), PATHS, ['message']);`,
    },
    {
      filename: STORE,
      code: "import * as api from '../../api/projects';\nawait consume(api.getProjects(), PATHS);",
    },
    // A type calls nothing.
    { filename: STORE, code: `${SDK}\nlet p: ProjectDto; type F = typeof getProjects;` },
    // Not a store: client-only-in-stores' business, not this rule's.
    { filename: at('src/app/projects/card.ts'), code: `${SDK}\nawait getProjects();` },
    {
      filename: at('src/app/core/projects/projects.store.spec.ts'),
      code: `${SDK}\ngetProjects();`,
    },
    {
      filename: STORE,
      code: `${SDK}\nawait unwrap(getProjects(), PATHS);`,
      options: [{ consume: 'unwrap' }],
    },
  ],
  invalid: [
    {
      filename: STORE,
      code: `${SDK}\nconst { data } = await getProjects();`,
      errors: [{ messageId: 'unwrapped', data: { name: 'getProjects', consume: 'consume' } }],
    },
    {
      filename: STORE,
      code: `${SDK}\ngetProjects().then((r) => r.data);`,
      errors: [{ messageId: 'unwrapped' }],
    },
    {
      filename: STORE,
      code: `${SDK}\nconst call = getProjects();\nawait consume(call, PATHS);`,
      errors: [{ messageId: 'unwrapped' }],
    },
    {
      filename: STORE,
      code: `${SDK}\nawait consume(Promise.resolve(getProjects()), PATHS);`,
      errors: [{ messageId: 'unwrapped' }],
    },
    {
      filename: STORE,
      code: `${SDK}\nawait consume(PATHS, getProjects());`,
      errors: [{ messageId: 'unwrapped' }],
    },
    {
      filename: STORE,
      code: `${SDK}\nconst f = getProjects;`,
      errors: [{ messageId: 'unwrapped' }],
    },
    {
      filename: STORE,
      code: `${SDK}\nconst projects = getProjectsResource(() => ({}));`,
      errors: [
        { messageId: 'unwrapped', data: { name: 'getProjectsResource', consume: 'consume' } },
      ],
    },
    {
      filename: STORE,
      code: "import * as api from '../../api/projects';\nawait api.getProjects();",
      errors: [{ messageId: 'unwrapped', data: { name: 'api.getProjects', consume: 'consume' } }],
    },
  ],
});

const SPEC = at('src/app/core/projects/projects.store.pact.spec.ts');

tester.run('pact-names', rules['pact-names'], {
  valid: [
    {
      filename: SPEC,
      code: `
        const CONSUMER = 'qits-demo-app';
        const PROVIDER = 'qits-projects-service';
        const pact = new PactV4({ consumer: CONSUMER, provider: PROVIDER, dir });
        addGoldenInteraction(pact, masters, {
          provider: PROVIDER, state, operationId,
          trigger: { kind: 'ui', app: CONSUMER, interaction: slug },
        });`,
    },
    {
      filename: SPEC,
      code: "new pactjs.PactV3({ consumer: 'qits-demo-app', provider: 'qits-ci-daemon' });",
    },
    // Not a pact spec: not checked.
    {
      filename: at('src/app/core/projects/projects.store.spec.ts'),
      code: "new PactV4({ consumer: 'x', provider: 'qits-projects' });",
    },
  ],
  invalid: [
    {
      filename: SPEC,
      code: "new PactV4({ consumer: 'qits-landing', provider: 'qits-projects' });",
      errors: [{ messageId: 'consumer' }, { messageId: 'provider' }],
    },
    {
      filename: SPEC,
      code: "new PactV4({ consumer: 'qits-demo-app', provider: `qits-projects-${role}` });",
      errors: [{ messageId: 'unresolved' }],
    },
    {
      filename: SPEC,
      code: `
        let PROVIDER = 'qits-projects-service';
        addGoldenInteraction(pact, masters, {
          provider: PROVIDER, state, operationId,
          trigger: { kind: 'ui', app: 'qits-landing', interaction: 'x' },
        });`,
      errors: [{ messageId: 'unresolved' }, { messageId: 'consumer' }],
    },
  ],
});
