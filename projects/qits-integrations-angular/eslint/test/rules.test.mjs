// node --test: the rules against a throwaway app tree under <repo>/tmp (git-ignored).
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

const COMPONENT = (name) => `@Component({ selector: 'x', template: '' })\nexport class ${name} {}`;

tester.run('page-location', rules['page-location'], {
  valid: [
    { filename: at('src/app/routes/projects/projects.page.ts'), code: COMPONENT('ProjectsPage') },
    { filename: at('src/app/routes/shell.layout.ts'), code: COMPONENT('ShellLayout') },
    // Not a component: a route's resolver or guard sits beside its page.
    {
      filename: at('src/app/routes/projects/[slug]/project.resolver.ts'),
      code: 'export const projectResolver = () => null;',
    },
    {
      filename: at('src/app/routes/projects/projects.page.spec.ts'),
      code: COMPONENT('HostComponent'),
    },
    { filename: at('src/app/ui/components/card.ts'), code: COMPONENT('Card') },
    {
      filename: at('src/pages/home/home.page.ts'),
      code: COMPONENT('HomePage'),
      options: [{ routes: 'src/pages' }],
    },
  ],
  invalid: [
    {
      filename: at('src/app/projects/projects.page.ts'),
      code: COMPONENT('ProjectsPage'),
      errors: [
        {
          messageId: 'outsideRoutes',
          data: {
            kind: 'page',
            routes: 'src/app/routes',
            file: 'src/app/projects/projects.page.ts',
          },
        },
      ],
    },
    {
      filename: at('src/app/shell.layout.ts'),
      code: COMPONENT('ShellLayout'),
      errors: [
        {
          messageId: 'outsideRoutes',
          data: { kind: 'layout', routes: 'src/app/routes', file: 'src/app/shell.layout.ts' },
        },
      ],
    },
    {
      filename: at('src/app/routes/projects/project-card.ts'),
      code: COMPONENT('ProjectCard'),
      errors: [{ messageId: 'notAPage', data: { name: 'ProjectCard', routes: 'src/app/routes' } }],
    },
  ],
});

tester.run('page-suffix', rules['page-suffix'], {
  valid: [
    { filename: at('src/app/routes/projects/projects.page.ts'), code: COMPONENT('ProjectsPage') },
    { filename: at('src/app/routes/shell.layout.ts'), code: COMPONENT('ShellLayout') },
    { filename: at('src/app/ui/components/card.ts'), code: COMPONENT('Card') },
    // Not a component: the name is free.
    { filename: at('src/app/core/page.ts'), code: 'export class NextPage {}' },
    {
      filename: at('src/app/routes/projects/projects.page.spec.ts'),
      code: COMPONENT('HostLayout'),
    },
  ],
  invalid: [
    {
      filename: at('src/app/routes/projects/projects.page.ts'),
      code: COMPONENT('ProjectsComponent'),
      errors: [
        {
          messageId: 'suffix',
          data: { name: 'ProjectsComponent', suffix: 'Page', file: '.page.ts' },
        },
      ],
    },
    {
      filename: at('src/app/routes/shell.layout.ts'),
      code: COMPONENT('ShellPage'),
      errors: [
        { messageId: 'suffix', data: { name: 'ShellPage', suffix: 'Layout', file: '.layout.ts' } },
      ],
    },
    {
      filename: at('src/app/ui/components/settings.ts'),
      code: COMPONENT('SettingsPage'),
      errors: [
        {
          messageId: 'wrongFile',
          data: { name: 'SettingsPage', suffix: 'page', extension: 'page' },
        },
      ],
    },
    {
      filename: at('src/app/routes/projects/projects.page.ts'),
      code: `${COMPONENT('ProjectsPage')}\n@Component({ template: '' })\nclass FrameLayout {}`,
      errors: [
        {
          messageId: 'wrongFile',
          data: { name: 'FrameLayout', suffix: 'layout', extension: 'layout' },
        },
      ],
    },
  ],
});

touch('src/app/routes/settings/index.ts');
const ROUTES = at('src/app/app.routes.ts');
const IMPORTS = `
  import { ShellLayout } from './routes/shell.layout';
  import { ProjectsPage } from './routes/projects/projects.page';
  import { NotFoundPage } from './routes/not-found/not-found.page';
`;

tester.run('route-matches-directory', rules['route-matches-directory'], {
  valid: [
    {
      filename: ROUTES,
      code: `${IMPORTS}
        export const routes: Routes = [
          {
            path: '',
            component: ShellLayout,
            children: [
              { path: '', redirectTo: 'projects', pathMatch: 'full' },
              { path: 'projects', component: ProjectsPage },
              {
                path: 'projects/:slug',
                loadComponent: () => import('./routes/projects/[slug]/project.layout').then((m) => m.ProjectLayout),
                children: [
                  {
                    path: 'work',
                    loadComponent: () =>
                      import('./routes/projects/[slug]/work/project-work.page').then((m) => m.ProjectWorkPage),
                  },
                ],
              },
              { path: 'settings', loadComponent: () => import('./routes/settings') },
              { path: 'admin', loadChildren: () => import('./routes/admin/admin.routes') },
              { path: '**', component: NotFoundPage },
            ],
          },
        ];`,
    },
    // A route table under the routes directory is mounted at its own directory.
    {
      filename: at('src/app/routes/admin/admin.routes.ts'),
      code: `
        import { AdminPage } from './admin.page';
        export default [
          { path: '', component: AdminPage },
          { path: 'users/:id', loadComponent: () => import('./users/[id]/user.page') },
        ] satisfies Routes;`,
    },
    // Not a route table.
    {
      filename: at('src/app/core/menu.ts'),
      code: `${IMPORTS}\nconst items = [{ path: 'x', component: ProjectsPage }];`,
    },
    // A path alias or a dynamic path cannot be checked.
    {
      filename: ROUTES,
      code: `
        import { HomePage } from '@app/home.page';
        export const routes = [
          { path: 'home', component: HomePage },
          { path: segment, loadComponent: () => import('./routes/x/x.page') },
        ];`,
    },
    {
      filename: at('src/routing.ts'),
      code: `${IMPORTS.replaceAll('./routes', './pages')}\nexport const routes = [{ path: 'projects', component: ProjectsPage }];`,
      options: [{ routes: 'src/pages', routeTables: ['src/routing.ts'] }],
    },
  ],
  invalid: [
    {
      filename: ROUTES,
      code: `${IMPORTS}
        export const routes: Routes = [
          {
            path: '',
            component: ShellLayout,
            children: [{ path: 'projects/:slug', component: ProjectsPage }],
          },
        ];`,
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/projects/:slug',
            what: 'its component',
            actual: 'src/app/routes/projects',
            expected: 'src/app/routes/projects/[slug]',
          },
        },
      ],
    },
    {
      filename: ROUTES,
      code: `
        export const routes = [
          {
            path: 'projects/:slug',
            children: [
              {
                path: 'work',
                loadComponent: () => import('./routes/work/project-work.page').then((m) => m.ProjectWorkPage),
              },
            ],
          },
        ];`,
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/projects/:slug/work',
            what: 'its component',
            actual: 'src/app/routes/work',
            expected: 'src/app/routes/projects/[slug]/work',
          },
        },
      ],
    },
    {
      filename: ROUTES,
      code: `
        import { ProjectCard } from './ui/components/project-card';
        export const routes = [{ path: 'card', component: ProjectCard }];`,
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/card',
            what: 'its component',
            actual: 'src/app/ui/components',
            expected: 'src/app/routes/card',
          },
        },
      ],
    },
    // The shell itself belongs at the top of the routes directory.
    {
      filename: ROUTES,
      code: `
        import { ShellLayout } from './routes/shell/shell.layout';
        export const routes = [{ path: '', component: ShellLayout, children: [] }];`,
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/',
            what: 'its component',
            actual: 'src/app/routes/shell',
            expected: 'src/app/routes',
          },
        },
      ],
    },
    {
      filename: ROUTES,
      code: "export const routes = [{ path: 'admin', loadChildren: () => import('./admin/admin.routes') }];",
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/admin',
            what: 'its child routes',
            actual: 'src/app/admin',
            expected: 'src/app/routes/admin',
          },
        },
      ],
    },
    {
      filename: at('src/app/routes/admin/admin.routes.ts'),
      code: "export default [{ path: 'users', loadComponent: () => import('../users/users.page') }];",
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/admin/users',
            what: 'its component',
            actual: 'src/app/routes/users',
            expected: 'src/app/routes/admin/users',
          },
        },
      ],
    },
  ],
});

const SHOTS = "await expect.element(view).toMatchScreenshot('loaded');";
touch('src/app/routes/projects/projects.page.browser.spec.ts', SHOTS);
touch('src/app/routes/shell.layout.browser.spec.ts', SHOTS);
touch('src/app/routes/users/users.page.browser.spec.ts', "it('renders', () => {});");
touch('src/pages/home/home.page.browser.spec.ts', SHOTS);

tester.run('page-has-screenshots', rules['page-has-screenshots'], {
  valid: [
    { filename: at('src/app/routes/projects/projects.page.ts'), code: COMPONENT('ProjectsPage') },
    { filename: at('src/app/routes/shell.layout.ts'), code: COMPONENT('ShellLayout') },
    // Outside the routes directory: page-location reports it, this rule does not.
    { filename: at('src/app/ui/orphan.page.ts'), code: COMPONENT('OrphanPage') },
    // A spec, a resolver: not a page.
    { filename: at('src/app/routes/admin/admin.page.spec.ts'), code: COMPONENT('HostComponent') },
    {
      filename: at('src/app/routes/admin/admin.resolver.ts'),
      code: 'export const adminResolver = () => null;',
    },
    {
      filename: at('src/pages/home/home.page.ts'),
      code: COMPONENT('HomePage'),
      options: [{ routes: 'src/pages' }],
    },
  ],
  invalid: [
    {
      filename: at('src/app/routes/admin/admin.page.ts'),
      code: COMPONENT('AdminPage'),
      errors: [
        {
          messageId: 'noSpec',
          data: { kind: 'page', spec: 'admin.page.browser.spec.ts' },
          line: 1,
        },
      ],
    },
    {
      filename: at('src/app/routes/admin/admin.layout.ts'),
      code: COMPONENT('AdminLayout'),
      errors: [
        { messageId: 'noSpec', data: { kind: 'layout', spec: 'admin.layout.browser.spec.ts' } },
      ],
    },
    {
      filename: at('src/app/routes/users/users.page.ts'),
      code: COMPONENT('UsersPage'),
      errors: [
        { messageId: 'noScreenshot', data: { kind: 'page', spec: 'users.page.browser.spec.ts' } },
      ],
    },
    // No component class: reported on the file.
    {
      filename: at('src/app/routes/empty/empty.page.ts'),
      code: 'export const nothing = 1;',
      errors: [{ messageId: 'noSpec', line: 1, column: 1 }],
    },
    {
      filename: at('src/pages/about/about.page.ts'),
      code: COMPONENT('AboutPage'),
      options: [{ routes: 'src/pages' }],
      errors: [{ messageId: 'noSpec', data: { kind: 'page', spec: 'about.page.browser.spec.ts' } }],
    },
  ],
});

describe('page-has-screenshots opt-out', () => {
  const lint = (code) =>
    new Linter().verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          ...qits.configs.recommended[0],
        },
      ],
      at('src/app/routes/old/old.page.ts'),
    );
  it('a disable comment above @Component silences it', () => {
    const reason =
      '// eslint-disable-next-line qits/page-has-screenshots -- redirects, shows nothing';
    assert.deepEqual(lint(`${reason}\n${COMPONENT('OldPage')}`), []);
  });
  it('without the comment it reports', () => {
    assert.deepEqual(
      lint(COMPONENT('OldPage')).map((m) => m.ruleId),
      ['qits/page-has-screenshots'],
    );
  });
});

const PAGE_SPEC = at('src/app/routes/projects/project-list.page.browser.spec.ts');
const LAYOUT_SPEC = at('src/app/routes/shell.layout.browser.spec.ts');
tester.run(
  'browser-spec-data-from-golden-masters',
  rules['browser-spec-data-from-golden-masters'],
  {
    valid: [
      // A golden-master call, awaited, flushed directly.
      {
        filename: PAGE_SPEC,
        code: "req.flush(await commands.goldenMaster('a project exists', 'listProjects'));",
      },
      // Through a const, a field, an element, a destructured part and a find().
      {
        filename: PAGE_SPEC,
        code: `
        const list = await goldenMaster('a project exists', 'listProjects');
        const { entries } = list;
        http.expectOne('/a').flush(list);
        http.expectOne('/b').flush(list.entries[0]);
        http.expectOne('/c').flush(entries);
        http.expectOne('/d').flush(list.entries.find((e) => e.project));
        http.expectOne('/e').flush(list as unknown as object);
      `,
      },
      {
        filename: PAGE_SPEC,
        code: "for (const entry of (await githostGoldenMaster('s', 'op')).entries) req.flush(entry);",
      },
      // An error answer may carry any body.
      {
        filename: PAGE_SPEC,
        code: "req.flush(null, { status: 500, statusText: 'Server Error' });",
      },
      {
        filename: LAYOUT_SPEC,
        code: "req.flush({ message: 'gone' }, { status: 404, statusText: 'x' });",
      },
      // A no-content operation says so.
      { filename: PAGE_SPEC, code: "req.flush(null, { status: 204, statusText: 'No Content' });" },
      // A parameter cannot be traced, nor options that are not a literal: the run-time guard checks.
      { filename: PAGE_SPEC, code: 'const answer = (body, options) => req.flush(body, options);' },
      { filename: PAGE_SPEC, code: 'req.flush({ a: 1 }, options);' },
      // Types from a store are fine.
      {
        filename: PAGE_SPEC,
        code: "import type { Project } from '$core/projects/projects.store';",
      },
      { filename: PAGE_SPEC, code: "import { type Project } from './projects.store';" },
      // A provider that is not a store.
      {
        filename: PAGE_SPEC,
        code: '({ provide: EVENT_SOURCE, useValue: () => ({ onmessage: null, close() {} }) });',
      },
      // A store provided as it is.
      { filename: PAGE_SPEC, code: '({ providers: [ProjectsStore] });' },
      // Other specs are not checked.
      {
        filename: at('src/app/ui/card.component.browser.spec.ts'),
        code: "patchState(store, { x: 1 }); req.flush({ a: 1 }); import { recorded } from '@qits/angular/testing/browser';",
      },
      {
        filename: at('src/app/routes/projects/project-list.page.spec.ts'),
        code: 'req.flush({ a: 1 });',
      },
    ],
    invalid: [
      {
        filename: PAGE_SPEC,
        code: 'req.flush({ entries: [] });',
        errors: [{ messageId: 'notGolden' }],
      },
      { filename: PAGE_SPEC, code: 'req.flush([]);', errors: [{ messageId: 'notGolden' }] },
      { filename: PAGE_SPEC, code: 'req.flush(null);', errors: [{ messageId: 'notGolden' }] },
      {
        filename: PAGE_SPEC,
        code: "req.flush(null, { status: 200, statusText: 'OK' });",
        errors: [{ messageId: 'notGolden' }],
      },
      {
        filename: PAGE_SPEC,
        code: "req.flush({ a: 1 }, { status: 204, statusText: 'No Content' });",
        errors: [{ messageId: 'notGolden' }],
      },
      {
        filename: PAGE_SPEC,
        code: `
        const recorded = await goldenMaster('s', 'listProjects');
        req.flush({ ...recorded, entries: [] });
        req.flush(recorded.entries.slice(0, 1));
        req.flush(structuredClone(recorded));
      `,
        errors: [
          { messageId: 'notGolden' },
          { messageId: 'notGolden' },
          { messageId: 'notGolden' },
        ],
      },
      {
        filename: PAGE_SPEC,
        code: "let list = await goldenMaster('s', 'op'); list = { entries: [] }; req.flush(list);",
        errors: [{ messageId: 'notGolden' }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { BODY } from './fixtures'; req.flush(BODY);",
        errors: [{ messageId: 'notGolden' }],
      },
      {
        filename: LAYOUT_SPEC,
        code: "import { patchState } from '@ngrx/signals'; patchState(store, { projects: [] });",
        errors: [{ messageId: 'patchState' }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { patchState as set } from '@ngrx/signals'; set(store, {});",
        errors: [{ messageId: 'patchState' }],
      },
      {
        filename: PAGE_SPEC,
        code: 'TestBed.overrideProvider(ProjectsStore, { useValue: {} });',
        errors: [{ messageId: 'overrideProvider' }],
      },
      {
        filename: PAGE_SPEC,
        code: '({ provide: ProjectsStore, useValue: { projects: () => [] } });',
        errors: [{ messageId: 'storeProvider', data: { token: 'ProjectsStore' } }],
      },
      {
        filename: PAGE_SPEC,
        code: '({ provide: stores.WorkStore, useClass: FakeWorkStore });',
        errors: [{ messageId: 'storeProvider', data: { token: 'WorkStore' } }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { ProjectsStore } from '$core/projects/projects.store';",
        errors: [{ messageId: 'storeImport' }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { type Project, ProjectsStore } from './projects.store.ts';",
        errors: [{ messageId: 'storeImport' }],
      },
      {
        filename: PAGE_SPEC,
        code: "await import('./projects.store');",
        errors: [{ messageId: 'storeImport' }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { recorded, fromGoldenMasters } from '@qits/angular/testing/browser';",
        errors: [
          { messageId: 'recorder', data: { name: 'recorded' } },
          { messageId: 'recorder', data: { name: 'fromGoldenMasters' } },
        ],
      },
    ],
  },
);
