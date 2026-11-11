// node --test: the rules against a throwaway app tree under <repo>/tmp (git-ignored).
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { ESLint, Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { format } from 'prettier';
import qits from '../index.mjs';
import { renderRoutePaths } from '../rules/route-paths.mjs';

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

// A second app whose tsconfig gives the $layout alias, through `extends` and with comments.
touch('aliased/package.json', JSON.stringify({ name: 'qits-aliased-app' }));
touch(
  'aliased/tsconfig.json',
  '/* app config */\n{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true, }, }',
);
touch(
  'aliased/tsconfig.base.json',
  '{\n  // aliases\n  "compilerOptions": { "paths": { "$core/*": ["./src/app/core/*"], "$layout/*": ["./src/app/layout/*"] } }\n}',
);
const inAliased = (path) => join(app, 'aliased', path);

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
    // With the $layout alias, a layout may live in its directory, and other components there too.
    { filename: inAliased('src/app/layout/shell.layout.ts'), code: COMPONENT('ShellLayout') },
    { filename: inAliased('src/app/layout/shell/shell.layout.ts'), code: COMPONENT('ShellLayout') },
    { filename: inAliased('src/app/layout/frame.ts'), code: COMPONENT('FrameComponent') },
    { filename: inAliased('src/app/routes/shell.layout.ts'), code: COMPONENT('ShellLayout') },
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
    // Without the $layout alias, a layout lives under routes/ only.
    {
      filename: at('src/app/layout/shell.layout.ts'),
      code: COMPONENT('ShellLayout'),
      errors: [
        {
          messageId: 'layoutNoAlias',
          data: { routes: 'src/app/routes', file: 'src/app/layout/shell.layout.ts' },
        },
      ],
    },
    {
      filename: inAliased('src/app/shell.layout.ts'),
      code: COMPONENT('ShellLayout'),
      errors: [
        {
          messageId: 'layoutOutside',
          data: {
            routes: 'src/app/routes',
            layouts: 'src/app/layout',
            file: 'src/app/shell.layout.ts',
          },
        },
      ],
    },
    // The $layout directory takes layouts, not pages.
    {
      filename: inAliased('src/app/layout/home.page.ts'),
      code: COMPONENT('HomePage'),
      errors: [
        {
          messageId: 'outsideRoutes',
          data: { kind: 'page', routes: 'src/app/routes', file: 'src/app/layout/home.page.ts' },
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
    { filename: inAliased('src/app/layout/shell.layout.ts'), code: COMPONENT('ShellLayout') },
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
          data: { name: 'SettingsPage', suffix: 'page', extension: 'page', where: '' },
        },
      ],
    },
    {
      filename: at('src/app/routes/projects/projects.page.ts'),
      code: `${COMPONENT('ProjectsPage')}\n@Component({ template: '' })\nclass FrameLayout {}`,
      errors: [
        {
          messageId: 'wrongFile',
          data: {
            name: 'FrameLayout',
            suffix: 'layout',
            extension: 'layout',
            where: ' (or the $layout alias directory)',
          },
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
    // With the $layout alias, a layout there is shared and may serve any URL.
    {
      filename: inAliased('src/app/app.routes.ts'),
      code: `
        import { ShellLayout } from './layout/shell.layout';
        export const routes = [
          { path: '', loadComponent: () => import('./layout/shell.layout'), children: [] },
          { path: 'admin', component: ShellLayout, children: [] },
          { path: 'admin/:id', loadComponent: () => import('./layout/admin/admin.layout.ts') },
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
    // Without the alias, the layout directory is just another wrong place.
    {
      filename: ROUTES,
      code: "export const routes = [{ path: '', loadComponent: () => import('./layout/shell.layout') }];",
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/',
            what: 'its component',
            actual: 'src/app/layout',
            expected: 'src/app/routes',
          },
        },
      ],
    },
    // With it, a page there is still checked against its URL.
    {
      filename: inAliased('src/app/app.routes.ts'),
      code: "export const routes = [{ path: 'home', loadComponent: () => import('./layout/home.page') }];",
      errors: [
        {
          messageId: 'misplaced',
          data: {
            route: '/home',
            what: 'its component',
            actual: 'src/app/layout',
            expected: 'src/app/routes/home',
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
touch('aliased/src/app/layout/shell.layout.browser.spec.ts', SHOTS);

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
    { filename: inAliased('src/app/layout/shell.layout.ts'), code: COMPONENT('ShellLayout') },
    // Without the alias, a layout outside routes/ is page-location's to report.
    { filename: at('src/app/layout/frame.layout.ts'), code: COMPONENT('FrameLayout') },
  ],
  invalid: [
    {
      filename: inAliased('src/app/layout/frame.layout.ts'),
      code: COMPONENT('FrameLayout'),
      errors: [
        { messageId: 'noSpec', data: { kind: 'layout', spec: 'frame.layout.browser.spec.ts' } },
      ],
    },
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

// The page and layout screenshot specs (ticket qits-1998): through the app's routes.
const ROUTED_SPEC = at('src/app/routes/projects/projects.page.browser.spec.ts');
const ROUTED_LAYOUT_SPEC = at('src/app/routes/projects/[slug]/work/work.layout.browser.spec.ts');
const OPEN_ROUTE = `import { openRoute, provideAppRoute } from '../../../testing/browser/app-route';
beforeEach(() => TestBed.configureTestingModule({ providers: provideAppRoute() }));
it('lists', async () => {
  await openRoute('/projects');
  await expect.element(page.getByRole('main')).toMatchScreenshot('list');
});`;
const SHOT = "  await expect.element(page.getByRole('main')).toMatchScreenshot('list');";
const routerSpec = (imports, providers) => `${imports}
import { TestBed } from '@angular/core/testing';
it('lists', async () => {
  TestBed.configureTestingModule({ ${providers} });
${SHOT}
});`;
const PROVIDE_ROUTER = "import { provideRouter } from '@angular/router';";
/** A report's data: the spec and the default helper, unless given. */
const through = (data) => ({
  spec: 'projects.page.browser.spec.ts',
  helpers: 'openRoute()',
  ...data,
});

tester.run('page-screenshots-through-routes', rules['page-screenshots-through-routes'], {
  valid: [
    { filename: ROUTED_SPEC, code: OPEN_ROUTE },
    { filename: ROUTED_LAYOUT_SPEC, code: OPEN_ROUTE },
    // The app's own table, imported from a route-table file (app.routes.ts, or a *.routes.ts).
    {
      filename: at('src/app/routes/auth-callback.page.browser.spec.ts'),
      code: routerSpec(
        `${PROVIDE_ROUTER}\nimport { routes } from '../app.routes';`,
        'providers: [provideRouter(routes)]',
      ),
    },
    {
      filename: ROUTED_SPEC,
      code: routerSpec(
        "import { RouterModule as R } from '@angular/router';\nimport { adminRoutes } from '../admin/admin.routes';",
        'imports: [R.forRoot(adminRoutes as Routes)]',
      ),
    },
    // A pattern spec, a UI component's spec, a $layout layout's (the shell keeps its stand-ins).
    {
      filename: at('src/app/patterns/list/list.browser.spec.ts'),
      code: routerSpec(
        PROVIDE_ROUTER,
        "providers: [provideRouter([{ path: '', component: Host }])]",
      ),
    },
    {
      filename: inAliased('src/app/layout/shell/shell.layout.browser.spec.ts'),
      code: routerSpec(
        PROVIDE_ROUTER,
        "providers: [provideRouter([{ path: 'a', component: Stub }])]",
      ),
    },
    // Not a page or layout spec, even under the routes directory.
    {
      filename: at('src/app/routes/projects/project-card.browser.spec.ts'),
      code: `import { ProjectsPage } from './projects.page';\nTestBed.createComponent(ProjectsPage);\n${SHOT}`,
    },
    // createComponent of something that is not a page: the route still has to come from somewhere.
    {
      filename: ROUTED_SPEC,
      code: `import { Host } from './host';\nawait openRoute('/projects');\nTestBed.createComponent(Host);`,
    },
    // Another helper, and another routes directory.
    {
      filename: at('src/pages/home/home.page.browser.spec.ts'),
      code: `await openPage('/');\n${SHOT}`,
      options: [{ routes: 'src/pages', helpers: ['openPage'] }],
    },
  ],
  invalid: [
    {
      filename: ROUTED_SPEC,
      code: `import { TestBed } from '@angular/core/testing';\nimport { ProjectsPage } from './projects.page';\nit('lists', async () => {\n  TestBed.createComponent(ProjectsPage);\n${SHOT}\n});`,
      errors: [
        {
          messageId: 'createsPage',
          data: {
            spec: 'projects.page.browser.spec.ts',
            name: 'ProjectsPage',
            helpers: 'openRoute()',
          },
          line: 4,
        },
      ],
    },
    // A layout, imported through the $layout alias or with its extension.
    {
      filename: ROUTED_LAYOUT_SPEC,
      code: `import { WorkLayout } from './work.layout.ts';\nTestBed.createComponent(WorkLayout);\n${SHOT}`,
      errors: [
        {
          messageId: 'createsPage',
          data: through({ spec: 'work.layout.browser.spec.ts', name: 'WorkLayout' }),
        },
      ],
    },
    {
      filename: inAliased('src/app/routes/home.page.browser.spec.ts'),
      code: `import { ShellLayout } from '$layout/shell/shell.layout';\nTestBed.createComponent(ShellLayout);\n${SHOT}`,
      errors: [
        {
          messageId: 'createsPage',
          data: through({ spec: 'home.page.browser.spec.ts', name: 'ShellLayout' }),
        },
      ],
    },
    {
      filename: ROUTED_SPEC,
      code: routerSpec(
        PROVIDE_ROUTER,
        "providers: [provideRouter([{ path: 'projects', component: ProjectsPage }])]",
      ),
      errors: [
        { messageId: 'inlineRoutes', data: through({ what: 'an inline route table' }), line: 4 },
      ],
    },
    {
      filename: ROUTED_SPEC,
      code: routerSpec(PROVIDE_ROUTER, 'providers: [provideRouter([])]'),
      errors: [{ messageId: 'inlineRoutes', data: through({ what: 'an empty route table' }) }],
    },
    {
      filename: ROUTED_SPEC,
      code: routerSpec(
        `${PROVIDE_ROUTER}\nconst routes = [{ path: 'projects', component: ProjectsPage }];`,
        'providers: [provideRouter(routes)]',
      ),
      errors: [
        {
          messageId: 'inlineRoutes',
          data: through({ what: "'routes' (not imported from a route-table file)" }),
        },
      ],
    },
    // Imported, but not from a route-table file.
    {
      filename: ROUTED_SPEC,
      code: routerSpec(
        `${PROVIDE_ROUTER}\nimport { routes } from './stand-in';`,
        'providers: [provideRouter(routes)]',
      ),
      errors: [{ messageId: 'inlineRoutes' }],
    },
    {
      filename: ROUTED_SPEC,
      code: routerSpec(
        "import { RouterTestingModule } from '@angular/router/testing';",
        "imports: [RouterTestingModule.withRoutes([{ path: 'projects', component: ProjectsPage }])]",
      ),
      errors: [{ messageId: 'inlineRoutes', data: through({ what: 'an inline route table' }) }],
    },
    // An inline table beside openRoute is still reported.
    {
      filename: ROUTED_SPEC,
      code: `${PROVIDE_ROUTER}\nprovideRouter();\n${OPEN_ROUTE}`,
      errors: [{ messageId: 'inlineRoutes', data: through({ what: 'no routes' }), line: 2 }],
    },
    // No route at all: once, on the first screenshot.
    {
      filename: ROUTED_LAYOUT_SPEC,
      code: `it('a', async () => {\n  document.body.innerHTML = '<main></main>';\n${SHOT}\n${SHOT}\n});`,
      errors: [
        {
          messageId: 'noRoute',
          data: { spec: 'work.layout.browser.spec.ts', helpers: 'openRoute()' },
          line: 3,
          column: 9,
        },
      ],
    },
    {
      filename: ROUTED_SPEC,
      code: "it('renders', () => {});",
      errors: [{ messageId: 'noRoute', line: 1, column: 1 }],
    },
    {
      filename: ROUTED_SPEC,
      code: `await openRoute('/projects');\n${SHOT}`,
      options: [{ helpers: ['openPage', 'openShell'] }],
      errors: [{ messageId: 'noRoute', data: through({ helpers: 'openPage() / openShell()' }) }],
    },
  ],
});

describe('page-screenshots-through-routes opt-out', () => {
  const lint = (code, file = ROUTED_SPEC) =>
    new Linter()
      .verify(
        code,
        [
          {
            files: ['**/*.ts'],
            languageOptions: { parser: tseslint.parser },
            ...qits.configs.recommended[0],
          },
        ],
        file,
      )
      // SHOT has no kind, so screenshot-kind also fires here; this suite is about the other rule.
      .filter((m) => m.ruleId === 'qits/page-screenshots-through-routes');
  const NO_ROUTE = `it('a', async () => {\n${SHOT}\n});`;
  it('is an error in recommended', () => {
    assert.equal(
      qits.configs.recommended[0].rules['qits/page-screenshots-through-routes'],
      'error',
    );
    assert.deepEqual(
      lint(NO_ROUTE).map((m) => [m.ruleId, m.severity]),
      [['qits/page-screenshots-through-routes', 2]],
    );
  });
  it('a disable comment above the first screenshot, or at the top of the file, silences it', () => {
    const next =
      '  // eslint-disable-next-line qits/page-screenshots-through-routes -- shows the bare page on purpose';
    assert.deepEqual(lint(NO_ROUTE.replace(SHOT, `${next}\n${SHOT}`)), []);
    const top =
      '/* eslint-disable qits/page-screenshots-through-routes -- mounts a stand-in on purpose */';
    const page = `import { TestBed } from '@angular/core/testing';\nimport { ProjectsPage } from './projects.page';\nTestBed.createComponent(ProjectsPage);\n${NO_ROUTE}`;
    assert.equal(lint(page).length, 1);
    assert.deepEqual(lint(`${top}\n${page}`), []);
  });
});

// What a page screenshot shows (ticket qits-2074): the whole page, not a part of it.
/** A spec that opens the route, then screenshots `subject` (after `before`, inside the test). */
const shotOf = (subject, before = '') => `${OPEN_ROUTE_HEAD}
it('shows', async () => {
  const opened = await openRoute('/projects');
${before}  await expect.element(${subject}).toMatchScreenshot('list', { kind: 'DATA' });
});`;
const OPEN_ROUTE_HEAD = "import { openRoute } from '../../../testing/browser/app-route';";
const partOfPage = (spec = 'projects.page.browser.spec.ts') => [
  { messageId: 'partOfPage', data: { spec } },
];

tester.run('page-screenshot-whole-page', rules['page-screenshot-whole-page'], {
  valid: [
    { filename: ROUTED_SPEC, code: shotOf('page.elementLocator(opened.frame)') },
    { filename: ROUTED_SPEC, code: shotOf('opened.frame') },
    // Bound to the whole page first, awaited or not.
    {
      filename: ROUTED_SPEC,
      code: shotOf('frame', '  const frame = page.elementLocator(opened.frame);\n'),
    },
    {
      filename: ROUTED_SPEC,
      code: shotOf('frame', '  let frame = await page.elementLocator(opened.frame);\n'),
    },
    // Destructured under a wholePage key, trusted by name: `{ frame }`, `{ frame: f }`.
    {
      filename: ROUTED_SPEC,
      code: `async function shown() {\n  const opened = await openRoute('/projects');\n  return { opened, frame: page.elementLocator(opened.frame) };\n}\nit('shows', async () => {\n  const { frame } = await shown();\n  await expect.element(frame).toMatchScreenshot('list', { kind: 'DATA' });\n});`,
    },
    { filename: ROUTED_SPEC, code: shotOf('f', '  const { frame: f } = await shown();\n') },
    // A function of this file whose every return is the whole page; its arguments are not read.
    {
      filename: at('src/app/routes/auth-callback.page.browser.spec.ts'),
      code: `function view(harness: RouterTestingHarness) {\n  return page.elementLocator(harness.routeNativeElement as HTMLElement);\n}\nit('signs in', async () => {\n  const harness = await RouterTestingHarness.create();\n  await expect.element(view(harness)).toMatchScreenshot('done', { kind: 'DATA' });\n});`,
    },
    {
      filename: ROUTED_SPEC,
      code: shotOf(
        'whole(opened)',
        '  const whole = (o: Opened) => page.elementLocator(o.frame);\n',
      ),
    },
    // `!`, `as`, `satisfies` around the subject or inside it.
    { filename: ROUTED_SPEC, code: shotOf('page.elementLocator(opened.frame!)') },
    {
      filename: ROUTED_SPEC,
      code: shotOf('frame!', '  const frame = page.elementLocator(opened.frame as HTMLElement);\n'),
    },
    // `.not` / `.soft` between, and expect(...) itself.
    {
      filename: ROUTED_SPEC,
      code: `it('a', async () => {\n  await expect(opened.frame).not.toMatchScreenshot('a', { kind: 'DATA' });\n  await expect.soft(page.elementLocator(opened.frame)).toMatchScreenshot('b', { kind: 'DATA' });\n});`,
    },
    // Another matcher is not a screenshot.
    { filename: ROUTED_SPEC, code: shotOf('x').replace('toMatchScreenshot', 'toHaveText') },
    // A spec outside the routes directory, and a non-page browser spec, take crops freely.
    {
      filename: at('src/app/layout/shell/shell.layout.browser.spec.ts'),
      code: shotOf("page.getByRole('banner')"),
    },
    {
      filename: at('src/app/patterns/list/list.browser.spec.ts'),
      code: shotOf("page.getByRole('list')"),
    },
    {
      filename: at('src/app/routes/projects/project-card.browser.spec.ts'),
      code: shotOf("page.getByRole('article')"),
    },
    // Another wholePage member, and another routes directory.
    {
      filename: at('src/pages/home/home.page.browser.spec.ts'),
      code: shotOf('page.elementLocator(opened.root)'),
      options: [{ routes: 'src/pages', wholePage: ['root'] }],
    },
  ],
  invalid: [
    // A helper returning a part of the page: work-item's actions bar.
    {
      filename: ROUTED_SPEC,
      code: shotOf(
        'actionsOf(element)',
        "  const element = page.elementLocator(opened.page);\n  const actionsOf = (e: Locator) =>\n    page.elementLocator(e.element().querySelector('[data-page-actions]') as HTMLElement);\n",
      ),
      errors: [{ ...partOfPage()[0], line: 7, column: 24 }],
    },
    // A locator chain off the whole page.
    {
      filename: ROUTED_SPEC,
      code: shotOf(
        "frame.getByRole('region', { name: 'Features' })",
        '  const frame = page.elementLocator(opened.frame);\n',
      ),
      errors: partOfPage(),
    },
    // Chained further: a node inside the frame.
    {
      filename: ROUTED_SPEC,
      code: shotOf("page.elementLocator(opened.frame.querySelector('x')!)"),
      errors: partOfPage(),
    },
    {
      filename: ROUTED_SPEC,
      code: shotOf("page.elementLocator(opened.frame.querySelector('p')!.closest('div')!)"),
      errors: partOfPage(),
    },
    // The innermost routed component, without the shell.
    {
      filename: ROUTED_SPEC,
      code: shotOf('page.elementLocator(opened.page)'),
      errors: partOfPage(),
    },
    // A function parameter, and a name the rule cannot resolve.
    {
      filename: ROUTED_SPEC,
      code: `async function shoot(target: Locator) {\n  await expect.element(target).toMatchScreenshot('x', { kind: 'DATA' });\n}`,
      errors: partOfPage(),
    },
    { filename: ROUTED_SPEC, code: shotOf('somewhere'), errors: partOfPage() },
    // A helper with one return that is not the whole page.
    {
      filename: ROUTED_SPEC,
      code: `function view(o: Opened, part: boolean) {\n  if (part) return page.elementLocator(o.page);\n  return page.elementLocator(o.frame);\n}\n${shotOf('view(opened, true)')}`,
      errors: partOfPage(),
    },
    // Destructured under a key that is not wholePage.
    {
      filename: ROUTED_SPEC,
      code: shotOf('element', '  const { element } = await shown();\n'),
      errors: partOfPage(),
    },
    // A layout spec under the routes directory taking a crop; one report per screenshot.
    {
      filename: ROUTED_LAYOUT_SPEC,
      code: shotOf(
        "page.getByRole('navigation')",
        "  await expect.element(page.getByRole('tab')).not.toMatchScreenshot('b', { kind: 'DATA' });\n",
      ),
      errors: [
        ...partOfPage('work.layout.browser.spec.ts'),
        ...partOfPage('work.layout.browser.spec.ts'),
      ],
    },
    // The wholePage option replaces the default.
    {
      filename: ROUTED_SPEC,
      code: shotOf('page.elementLocator(opened.frame)'),
      options: [{ wholePage: ['root'] }],
      errors: partOfPage(),
    },
  ],
});

describe('page-screenshot-whole-page in recommended', () => {
  const lint = (code) =>
    new Linter()
      .verify(
        code,
        [
          {
            files: ['**/*.ts'],
            languageOptions: { parser: tseslint.parser },
            ...qits.configs.recommended[0],
          },
        ],
        ROUTED_SPEC,
      )
      .filter((m) => m.ruleId === 'qits/page-screenshot-whole-page');
  const crop = shotOf("page.getByRole('main')");
  it('warns, with the message the brief gives', () => {
    const [report, ...rest] = lint(crop);
    assert.deepEqual(rest, []);
    assert.equal(report.severity, 1);
    assert.equal(
      report.message,
      "projects.page.browser.spec.ts screenshots part of the page: screenshot the whole page (`opened.frame`). For a part of the page, put the screenshot in that component's own browser spec under `patterns/` or `ui/`, or give the page a provider state that shows it.",
    );
  });
  it('a disable comment above the screenshot silences it', () => {
    const reason =
      '  // eslint-disable-next-line qits/page-screenshot-whole-page -- the bar is the state';
    assert.deepEqual(lint(crop.replace('  await expect', `${reason}\n  await expect`)), []);
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
      // A state-tree token provided as it is, or imported for its type only.
      {
        filename: PAGE_SPEC,
        code: "import { SelectedProject } from '$core/projects/selected-project'; ({ providers: [SelectedProject] });",
      },
      {
        filename: PAGE_SPEC,
        code: "import type { SelectedProject } from '$core/projects/selected-project'; ({ provide: SelectedProject, useValue: {} });",
      },
      // A transport seam the app allows, under its name or an alias.
      {
        filename: PAGE_SPEC,
        code: "import { EVENT_SOURCE } from '$core/events/domain-events'; ({ provide: EVENT_SOURCE, useValue: () => ({}) });",
        options: [{ allowTokens: ['EVENT_SOURCE'] }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { EVENT_SOURCE as SOURCE } from '../../core/events/domain-events'; ({ provide: SOURCE, useFactory: () => () => ({}) });",
        options: [{ allowTokens: ['EVENT_SOURCE'] }],
      },
      // A token from outside the state tree.
      {
        filename: PAGE_SPEC,
        code: "import { AppOrigins } from '$shared/app-origins'; ({ provide: AppOrigins, useValue: {} });",
      },
      // UI components may use synthetic data: browser specs under src/app/ui/ are not checked.
      {
        filename: at('src/app/ui/card.component.browser.spec.ts'),
        code: "patchState(store, { x: 1 }); req.flush({ a: 1 }); import { recorded } from '@qits/angular/testing/browser';",
      },
      {
        filename: at('src/app/ui/forms/field.browser.spec.ts'),
        code: 'req.flush({ a: 1 });',
      },
      // syntheticAllowed names other places that may.
      {
        filename: at('src/app/widgets/chip.browser.spec.ts'),
        code: 'req.flush({ a: 1 });',
        options: [{ syntheticAllowed: ['src/app/widgets/**'] }],
      },
      // Specs that do not run in the browser are not checked.
      {
        filename: at('src/app/routes/projects/project-list.page.spec.ts'),
        code: 'req.flush({ a: 1 });',
      },
    ],
    invalid: [
      // Every browser spec outside the UI tree is checked, not only page and layout specs.
      {
        filename: at('src/app/patterns/project-list.patterns.browser.spec.ts'),
        code: 'req.flush({ a: 1 });',
        errors: [{ messageId: 'notGolden' }],
      },
      {
        filename: at('src/app/projects/project-card.browser.spec.ts'),
        code: 'patchState(store, { x: 1 });',
        errors: [{ messageId: 'patchState' }],
      },
      // A custom syntheticAllowed replaces the default, so src/app/ui/ is checked again.
      {
        filename: at('src/app/ui/card.component.browser.spec.ts'),
        code: 'req.flush({ a: 1 });',
        options: [{ syntheticAllowed: ['src/app/widgets/**'] }],
        errors: [{ messageId: 'notGolden' }],
      },
      // allowTokens exempts only the tokens it names.
      {
        filename: PAGE_SPEC,
        code: "import { EVENT_SOURCE } from '$core/events/domain-events'; import { SelectedProject } from '$core/projects/selected-project'; import { AppOrigins } from '$core/app-origins'; [{ provide: EVENT_SOURCE, useValue: () => ({}) }, { provide: SelectedProject, useValue: {} }, { provide: AppOrigins, useValue: {} }];",
        options: [{ allowTokens: ['EVENT_SOURCE'] }],
        errors: [
          { messageId: 'stateProvider', data: { token: 'SelectedProject' } },
          { messageId: 'stateProvider', data: { token: 'AppOrigins' } },
        ],
      },
      // It never exempts a store.
      {
        filename: PAGE_SPEC,
        code: '({ provide: ProjectsStore, useValue: {} });',
        options: [{ allowTokens: ['ProjectsStore'] }],
        errors: [{ messageId: 'stateProvider', data: { token: 'ProjectsStore' } }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { SelectedProject } from '$core/projects/selected-project'; ({ provide: SelectedProject, useValue: { slug: () => 'x' } });",
        errors: [{ messageId: 'stateProvider', data: { token: 'SelectedProject' } }],
      },
      {
        filename: PAGE_SPEC,
        code: "import { SelectedProject } from '../../core/projects/selected-project'; ({ provide: SelectedProject, useFactory: () => ({}) });",
        errors: [{ messageId: 'stateProvider', data: { token: 'SelectedProject' } }],
      },
      {
        filename: LAYOUT_SPEC,
        code: "import { EVENT_SOURCE as SOURCE } from '../core/events/domain-events'; ({ provide: SOURCE, useClass: Fake });",
        errors: [{ messageId: 'stateProvider', data: { token: 'SOURCE' } }],
      },
      {
        filename: PAGE_SPEC,
        code: "import * as core from '$core/projects/selected-project'; ({ provide: core.SelectedProject, useExisting: Other });",
        errors: [{ messageId: 'stateProvider', data: { token: 'core' } }],
      },
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
        errors: [{ messageId: 'stateProvider', data: { token: 'ProjectsStore' } }],
      },
      {
        filename: PAGE_SPEC,
        code: '({ provide: stores.WorkStore, useClass: FakeWorkStore });',
        errors: [{ messageId: 'stateProvider', data: { token: 'WorkStore' } }],
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
      {
        filename: PAGE_SPEC,
        code: "import { recordedText, fromGoldenMasterTexts } from '@qits/angular/testing/browser';",
        errors: [
          { messageId: 'recorder', data: { name: 'recordedText' } },
          { messageId: 'recorder', data: { name: 'fromGoldenMasterTexts' } },
        ],
      },
    ],
  },
);

describe('browser-spec-data-from-golden-masters messages', () => {
  const { messages } = rules['browser-spec-data-from-golden-masters'].meta;
  it('every data message says how to add a provider state and a pact interaction', () => {
    for (const id of [
      'patchState',
      'overrideProvider',
      'stateProvider',
      'storeImport',
      'notGolden',
    ]) {
      assert.match(messages[id], /add a provider state to the provider repository/, id);
      assert.match(messages[id], /\(ProviderStates \+ golden-master recorder\)/, id);
      assert.match(messages[id], /add a pact interaction for it in the consumer's pact spec/, id);
      assert.match(
        messages[id],
        /Then answer with goldenMaster\('<new state>', '<operationId>'\)/,
        id,
      );
    }
    for (const id of ['patchState', 'overrideProvider', 'stateProvider', 'storeImport']) {
      assert.match(messages[id], /Feed the data through HTTP from a golden master instead/, id);
    }
    assert.match(messages.recorder, /wrap the goldenMaster command there/);
  });
});

const KIND_SPEC = at('src/app/routes/projects/project-list.page.browser.spec.ts');
tester.run('screenshot-kind', rules['screenshot-kind'], {
  valid: [
    // Each allowed kind, as toMatchScreenshot(name, { kind }).
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { kind: 'DATA' });",
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('empty', { kind: 'NO_DATA' });",
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('wait', { kind: 'PENDING' });",
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('refused', { kind: 'ERROR' });",
    },
    // Options as the sole argument: toMatchScreenshot({ kind }).
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot({ kind: 'DATA' });",
    },
    // A no-expression template literal is a string literal.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { kind: `DATA` });",
    },
    // A valid opt-out: a non-empty array of enum literals, with a non-empty reason.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['DESKTOP'], reason: 'needs a fine pointer' });",
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['PHONE', 'TABLET'], reason: 'needs a fine pointer' });",
    },
    // A kind given literally beside a spread is still checkable.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { ...base, kind: 'DATA' });",
    },
    // A call to a different matcher is not a shot at all.
    { filename: KIND_SPEC, code: "await expect.element(view).toHaveText('x');" },
    // A non-browser spec is not checked at all.
    {
      filename: at('src/app/routes/projects/project-list.page.spec.ts'),
      code: "await expect.element(view).toMatchScreenshot('loaded');",
    },
  ],
  invalid: [
    // No options object at all.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded');",
      errors: [{ messageId: 'noOptions' }],
    },
    {
      filename: KIND_SPEC,
      code: 'await expect.element(view).toMatchScreenshot();',
      errors: [{ messageId: 'noOptions' }],
    },
    // An options object with no kind. viewports is otherwise valid, so only reason is also missing.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { viewports: ['PHONE'] });",
      errors: [{ messageId: 'missingKind' }, { messageId: 'missingReason' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot({ name: 'x' });",
      errors: [{ messageId: 'missingKind' }],
    },
    // kind is not a string literal from the enum.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { kind: 'LOADING' });",
      errors: [{ messageId: 'invalidKind' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { kind: `DATA-${x}` });",
      errors: [{ messageId: 'invalidKind' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { kind: KIND });",
      errors: [{ messageId: 'invalidKind' }],
    },
    // viewports present but not a non-empty array literal of enum literals.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: 'DESKTOP', reason: 'x' });",
      errors: [{ messageId: 'invalidViewports' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: [], reason: 'x' });",
      errors: [{ messageId: 'invalidViewports' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['MOBILE'], reason: 'x' });",
      errors: [{ messageId: 'invalidViewports' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: [size], reason: 'x' });",
      errors: [{ messageId: 'invalidViewports' }],
    },
    // viewports present without a non-empty string-literal reason.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['DESKTOP'] });",
      errors: [{ messageId: 'missingReason' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['DESKTOP'], reason: '' });",
      errors: [{ messageId: 'missingReason' }],
    },
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['DESKTOP'], reason: reasonVar });",
      errors: [{ messageId: 'missingReason' }],
    },
    // Both a bad viewports and a missing reason are reported together (sorted by position: the
    // 'viewports' property starts before its value, so missingReason's node comes first).
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['MOBILE'] });",
      errors: [{ messageId: 'missingReason' }, { messageId: 'invalidViewports' }],
    },
    // A spread with no literal kind is reported as missing, not as unreadable.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { ...base });",
      errors: [{ messageId: 'missingKind' }],
    },
    // A spread with a bad literal kind is still checked for kind; viewports stay unreadable.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', { ...base, kind: 'LOADING', viewports: ['MOBILE'] });",
      errors: [{ messageId: 'invalidKind' }],
    },
    // An empty options object has no kind either.
    {
      filename: KIND_SPEC,
      code: "await expect.element(view).toMatchScreenshot('loaded', {});",
      errors: [{ messageId: 'missingKind' }],
    },
  ],
});

describe('screenshot-kind messages', () => {
  const { messages } = rules['screenshot-kind'].meta;
  it('names the allowed kinds and viewports', () => {
    assert.match(messages.noOptions, /DATA, NO_DATA, PENDING, ERROR/);
    assert.match(messages.missingKind, /DATA, NO_DATA, PENDING, ERROR/);
    assert.match(messages.invalidKind, /DATA, NO_DATA, PENDING, ERROR/);
    assert.match(messages.invalidViewports, /PHONE, TABLET, DESKTOP/);
  });
});

// route-paths: an app whose route tables are on disk, read by the rule on the generated file.
const inPaths = (path) => join(app, 'paths', path);
touch('paths/package.json', JSON.stringify({ name: 'qits-paths-app' }));
touch(
  'paths/src/app/app.routes.ts',
  `import { Routes } from '@angular/router';
import { authCallbackRoute } from '@qits/angular';
import { ShellLayout } from './routes/shell.layout';
import { NotFoundPage } from './routes/not-found/not-found.page';

export const routes: Routes = [
  authCallbackRoute,
  {
    path: '',
    component: ShellLayout,
    children: [
      { path: '', redirectTo: 'projects', pathMatch: 'full' },
      { path: 'projects', loadComponent: () => import('./routes/projects/projects.page') },
      {
        path: 'projects/:slug',
        loadComponent: () => import('./routes/projects/[slug]/project.layout'),
        children: [
          { path: '', children: [] },
          { path: ':tab', children: [] },
        ],
      },
      { path: 'admin', loadChildren: () => import('./routes/admin/admin.routes') },
      { path: segment, loadComponent: () => import('./routes/x/x.page') },
      { path: 'old', redirectTo: 'projects' },
      { path: 'settings', canActivate: [guard] },
      { path: '**', component: NotFoundPage },
    ],
  },
] as Routes;
`,
);
touch(
  'paths/src/app/routes/admin/admin.routes.ts',
  `export default [
  { path: '', loadComponent: () => import('./admin.page') },
  { path: 'users/:id', loadComponent: () => import('./users/[id]/user.page') },
] satisfies Routes;
`,
);
const PATHS = ['', 'admin', 'admin/users/:id', 'projects', 'projects/:slug', 'projects/:slug/:tab'];
const ROUTE_PATHS = inPaths('src/app/route-paths.ts');
const CURRENT = renderRoutePaths(PATHS);
touch('paths/src/app/route-paths.ts', CURRENT);

// An app with route tables and no generated file.
touch('missing/package.json', JSON.stringify({ name: 'qits-missing-app' }));
touch('missing/src/app/app.routes.ts', "export const routes = [{ path: 'a', component: A }];\n");
touch('missing/src/app/routes/b/b.routes.ts', "export default [{ path: '', component: B }];\n");
const inMissing = (path) => join(app, 'missing', path);

tester.run('route-paths', rules['route-paths'], {
  valid: [
    { filename: ROUTE_PATHS, code: CURRENT },
    // Another name for the generated file.
    {
      filename: inPaths('src/types/routes.ts'),
      code: renderRoutePaths(PATHS, 'src/types/routes.ts'),
      options: [{ file: 'src/types/routes.ts' }],
    },
    // The app has the file: its route tables report nothing.
    { filename: inPaths('src/app/app.routes.ts'), code: 'export const routes = [];' },
    // Route tables are never visited; only the generated file is.
    { filename: inMissing('src/app/routes/b/b.routes.ts'), code: 'export default [];' },
    // Neither the generated file nor a route table.
    { filename: inMissing('src/app/core/menu.ts'), code: 'export const x = 1;' },
    // The app has not opted in: route-paths.ts does not exist, so nothing is reported.
    { filename: inMissing('src/app/app.routes.ts'), code: 'export const routes = [];' },
  ],
  invalid: [
    // A route was added to the tables.
    {
      filename: ROUTE_PATHS,
      code: renderRoutePaths(PATHS.filter((p) => p !== 'projects/:slug/:tab')),
      output: CURRENT,
      errors: [
        {
          messageId: 'stale',
          data: {
            file: 'src/app/route-paths.ts',
            added: "'/projects/:slug/:tab'",
            removed: 'none',
          },
        },
      ],
    },
    // A route was removed from the tables.
    {
      filename: ROUTE_PATHS,
      code: renderRoutePaths([...PATHS, 'gone', 'gone/:id'].sort()),
      output: CURRENT,
      errors: [
        {
          messageId: 'stale',
          data: { file: 'src/app/route-paths.ts', added: 'none', removed: "'/gone', '/gone/:id'" },
        },
      ],
    },
    // An empty file is the generator's starting point.
    {
      filename: ROUTE_PATHS,
      code: '',
      output: CURRENT,
      errors: [{ messageId: 'stale' }],
    },
  ],
});

describe('route-paths on an app that has not opted in', () => {
  it('reports nothing through a real ESLint run on recommended', async () => {
    const eslint = new ESLint({
      cwd: inMissing(''),
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          ...qits.configs.recommended[0],
        },
      ],
    });
    const [result] = await eslint.lintFiles(['src/app/app.routes.ts']);
    assert.ok(!result.messages.some((m) => m.ruleId === 'qits/route-paths'), result.messages);
  });
});

describe('route-paths generated file', () => {
  const generated = (code) =>
    new Linter().verifyAndFix(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          ...qits.configs.recommended[0],
        },
      ],
      ROUTE_PATHS,
    );
  it('lists the paths the tables declare, and none they do not', () => {
    const { output, messages } = generated('');
    assert.deepEqual(messages, []);
    const members = /export type RoutePath =([^;]*);/.exec(output)[1];
    assert.deepEqual(
      [...members.matchAll(/'([^']*)'/g)].map((m) => m[1]),
      PATHS,
    );
    // the :tab child that has no directory, the nested table under its directory
    assert.match(output, /'projects\/:slug\/:tab'/);
    assert.match(output, /'admin\/users\/:id'/);
    for (const absent of ['**', 'old', 'settings', 'auth/callback']) {
      assert.doesNotMatch(output, new RegExp(`'${absent.replace(/\*/g, '\\*')}'`), absent);
    }
    assert.match(output, /eslint --fix src\/app\/route-paths\.ts/);
    assert.match(
      output,
      /declare module '@qits\/angular' \{\n {2}interface QitsApp \{\n {4}routePath: RoutePath;\n {2}\}\n\}\n$/,
    );
  });
  it('is the text prettier writes, one member per line', async () => {
    const prettier = { parser: 'typescript', singleQuote: true, printWidth: 100 };
    for (const paths of [[''], ['', 'projects', 'projects/:slug'], PATHS]) {
      const text = renderRoutePaths(paths);
      assert.equal(await format(text, prettier), text);
    }
  });
});

// navigation-through-outcomes: an external template, and the library holding itself to the rule.
touch(
  'src/app/routes/linked/linked.html',
  '<nav>\n  <a routerLink="/projects">Projects</a>\n</nav>\n',
);
touch('src/app/routes/plain/plain.html', '<a [qitsExit]="outcomes.cancel">Cancel</a>\n');
touch('qits-angular/package.json', JSON.stringify({ name: '@qits/angular' }));
const inLibrary = (path) => join(app, 'qits-angular', path);

const ROUTER =
  "import { Component, inject } from '@angular/core';\nimport { Router } from '@angular/router';\n";
const FIELD = `${ROUTER}export class P {\n  private readonly router = inject(Router);\n  open() {\n    void this.router.navigate(['/projects']);\n  }\n}`;
const component = (template, extra = '') =>
  `import { Component } from '@angular/core';\n@Component({\n  selector: 'app-x',${extra}\n  template: \`${template}\`,\n})\nexport class X {}`;
/** The options the library's own lint config gives the rule. */
const LIBRARY_OPTIONS = { include: ['src/lib/**'], exclude: ['src/lib/outcomes/**'] };
const NAVIGATE_MESSAGE =
  "Navigate through a declared outcome, not Router.navigate: declare it with outcomes('<interaction>', { <name>: exit('<route path>') }) from @qits/angular and call .go(params).";

tester.run('navigation-through-outcomes', rules['navigation-through-outcomes'], {
  valid: [
    // Navigation through a declared outcome.
    {
      filename: at('src/app/routes/work/create/work-create.page.ts'),
      code: `${ROUTER}import { exit, outcomes } from '@qits/angular';\nexport class P {\n  readonly outcomes = outcomes('create', { created: exit('work/:id') });\n  done(id: string) {\n    void this.outcomes.created.go({ id });\n  }\n}`,
    },
    {
      filename: at('src/app/routes/work/create/work-create.page.ts'),
      code: component('<a [qitsExit]="outcomes.cancel">Cancel</a>'),
    },
    {
      filename: at('src/app/routes/plain/plain.page.ts'),
      code: component('', "\n  templateUrl: './plain.html',").replace('\n  template: ``,', ''),
    },
    // A click that does not navigate.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: component('<button (click)="tab.set(\'open\')">Open</button>'),
    },
    // routerLinkActive only styles a link.
    {
      filename: at('src/app/layout/shell.layout.ts'),
      code: component(
        '<a routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">x</a>',
      ),
    },
    // A navigate on something that is not the Router.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: `${ROUTER}export class P {\n  private readonly wizard = inject(Wizard);\n  next(steps: { navigate(n: number): void }) {\n    this.wizard.navigate(1);\n    steps.navigate(2);\n  }\n}`,
    },
    // Without a Router import nothing is the Router.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: 'export class P {\n  router = inject(Router);\n  go() {\n    this.router.navigate([]);\n  }\n}',
    },
    // createUrlTree / parseUrl do not navigate; a destructured navigate is not followed.
    {
      filename: at('src/app/core/auth/session.guard.ts'),
      code: `${ROUTER}export const guard = () => {\n  const router = inject(Router);\n  const { navigate } = router;\n  void navigate;\n  return router.createUrlTree(['/sign-in']) ?? router.parseUrl('/');\n};`,
    },
    // An object key named routerLink is data; the template binding it is what gets reported.
    {
      filename: at('src/app/core/work/work-briefs.store.ts'),
      code: "export const briefs = [{ routerLink: '/work' }];",
    },
    // A template with an expression in it is not read.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: "import { Component } from '@angular/core';\nconst LINK = 'routerLink=\"/a\"';\n@Component({ selector: 'app-x', template: `<a ${LINK}>a</a>` })\nexport class X {}",
    },
    // A missing templateUrl is the build's to report.
    {
      filename: at('src/app/routes/gone/gone.page.ts'),
      code: "import { Component } from '@angular/core';\n@Component({ selector: 'app-x', templateUrl: './gone.html' })\nexport class X {}",
    },
    // Specs, the test harness, the generated clients and the library itself are not read.
    { filename: at('src/app/routes/work/work.page.spec.ts'), code: FIELD },
    { filename: at('src/app/routes/work/work.page.browser.spec.ts'), code: FIELD },
    { filename: at('src/testing/harness.ts'), code: FIELD },
    { filename: at('src/app/api/projects/sdk.gen.ts'), code: FIELD },
    // The library's own options: its outcome API navigates by design.
    {
      filename: inLibrary('src/lib/outcomes/outcomes.ts'),
      code: FIELD,
      options: [LIBRARY_OPTIONS],
    },
    { filename: inLibrary('src/lib/outcomes/x.ts'), code: FIELD, options: [LIBRARY_OPTIONS] },
    // Other scopes.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: FIELD,
      options: [{ include: ['src/app/core/**'] }],
    },
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: FIELD,
      options: [{ exclude: ['src/app/routes/**'] }],
    },
    // An empty command list is a local click (owner decision 4, epic qits-2000, qits-2038): it
    // keeps the current route and changes only the query or fragment.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: `${ROUTER}export class P {\n  private readonly router = inject(Router);\n  private readonly route = inject(ActivatedRoute);\n  openTab(tab: string) {\n    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab } });\n  }\n}`,
    },
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: `${ROUTER}export class P {\n  private readonly router = inject(Router);\n  go() {\n    void this.router.navigate([], { fragment: 'x' });\n  }\n}`,
    },
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: `${ROUTER}export class P {\n  private readonly router = inject(Router);\n  clear() {\n    void this.router.navigate([]);\n  }\n}`,
    },
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: component('<a [routerLink]="[]" [queryParams]="{ tab: 1 }">Tab</a>'),
    },
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: component('\n    @if (open) {\n      <a [routerLink]="[]">Tab</a>\n    }\n  '),
    },
    {
      filename: at('src/app/patterns/menu/menu.ts'),
      code: component('<a *ngIf="x" [routerLink]="[]">Tab</a>'),
    },
  ],
  invalid: [
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: FIELD,
      errors: [{ message: NAVIGATE_MESSAGE, line: 6, column: 22, endColumn: 30 }],
    },
    {
      filename: at('src/app/routes/root.page.ts'),
      code: `${ROUTER}export class RootPage {\n  constructor() {\n    void inject(Router).navigateByUrl('/projects', { replaceUrl: true });\n  }\n}`,
      errors: [{ messageId: 'navigate', data: { method: 'navigateByUrl' }, line: 5 }],
    },
    // The library's own code outside its outcome API, under the library's options.
    {
      filename: inLibrary('src/lib/sign-in/x.ts'),
      code: `${ROUTER}export class Callback {\n  constructor() {\n    void inject(Router).navigateByUrl('/', { replaceUrl: true });\n  }\n}`,
      options: [LIBRARY_OPTIONS],
      errors: [{ messageId: 'navigate', data: { method: 'navigateByUrl' }, line: 5 }],
    },
    // Aliased imports.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: "import { inject as di } from '@angular/core';\nimport { Router as R } from '@angular/router';\nexport class P {\n  #r = di(R);\n  go() {\n    void this.#r.navigateByUrl('/');\n  }\n}",
      errors: [{ messageId: 'navigate', data: { method: 'navigateByUrl' } }],
    },
    // Constructor injection, a parameter, a typed field, a local.
    {
      filename: at('src/app/patterns/work-list/work-list.ts'),
      code: `${ROUTER}export class L {\n  private other!: Router;\n  constructor(private r: Router) {\n    r.navigate(['/a']);\n  }\n  go(router: Router) {\n    this.r.navigate(['/a']);\n    router.navigateByUrl('/b');\n    this.other.navigate(['/a']);\n    const local = inject(Router);\n    local.navigate(['/a']);\n  }\n}`,
      errors: [
        { messageId: 'navigate', line: 6 },
        { messageId: 'navigate', line: 9 },
        { messageId: 'navigate', line: 10 },
        { messageId: 'navigate', line: 11 },
        { messageId: 'navigate', line: 13 },
      ],
    },
    // Optional chaining.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: `${ROUTER}export class P {\n  router? = inject(Router);\n  go() {\n    void this.router?.navigate(['/a']);\n  }\n}`,
      errors: [{ messageId: 'navigate', line: 6 }],
    },
    // Inline template: bound inside @if, plain, at the attribute.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: component(
        '\n    @if (open) {\n      <a [routerLink]="[\'/projects\']">P</a>\n    }\n    <a routerLink="/work">W</a>\n  ',
      ),
      errors: [
        {
          messageId: 'routerLink',
          data: { where: '' },
          line: 6,
          column: 10,
          endLine: 6,
          endColumn: 38,
        },
        {
          messageId: 'routerLink',
          data: { where: '' },
          line: 8,
          column: 8,
          endLine: 8,
          endColumn: 26,
        },
      ],
    },
    // On <ng-template>.
    {
      filename: at('src/app/patterns/menu/menu.ts'),
      code: component(
        '<ng-template routerLink="/a"></ng-template><ng-template [routerLink]="x"></ng-template>',
      ),
      errors: [{ messageId: 'routerLink' }, { messageId: 'routerLink' }],
    },
    // A structural directive's wrapper repeats the attribute: reported once.
    {
      filename: at('src/app/patterns/menu/menu.ts'),
      code: component('<a *ngIf="x" routerLink="/a">a</a>'),
      errors: [{ messageId: 'routerLink' }],
    },
    // Escapes in the literal: the location falls back to the template property.
    {
      filename: at('src/app/patterns/menu/menu.ts'),
      code: "import { Component } from '@angular/core';\n@Component({\n  selector: 'app-x',\n  template: '<a title=\"it\\'s\" routerLink=\"/a\">a</a>',\n})\nexport class X {}",
      errors: [{ messageId: 'routerLink', line: 4, column: 3 }],
    },
    // External template: on templateUrl, naming the file, line and column.
    {
      filename: at('src/app/routes/linked/linked.page.ts'),
      code: "import { Component } from '@angular/core';\n@Component({\n  selector: 'app-x',\n  templateUrl: './linked.html',\n})\nexport class X {}",
      errors: [
        {
          message:
            'A raw routerLink (src/app/routes/linked/linked.html:2:6) is a navigation no outcome declares: use <a [qitsExit]="outcomes.<name>" [exitParams]="{…}"> (or .go() from a click) with outcomes()/exit() from @qits/angular.',
          line: 4,
          column: 3,
        },
      ],
    },
    // A ui component is in scope.
    {
      filename: at('src/app/ui/components/tag-link/tag-link.ts'),
      code: component('<a [routerLink]="link()">{{ label() }}</a>'),
      errors: [{ messageId: 'routerLink' }],
    },
    // The empty-array exemption only reaches what owner decision 4 names: a relativeTo that can
    // still name another route, a second argument the rule cannot see into, a non-empty command
    // list, and navigateByUrl, all stay reported.
    {
      filename: at('src/app/routes/work/work.page.ts'),
      code: `${ROUTER}export class P {\n  private readonly router = inject(Router);\n  private readonly route = inject(ActivatedRoute);\n  go(opts: { relativeTo?: unknown }) {\n    this.router.navigate([], { relativeTo: this.route.parent });\n    this.router.navigate([], opts);\n    this.router.navigate(['x']);\n    this.router.navigateByUrl('');\n  }\n}`,
      errors: [
        { messageId: 'navigate', data: { method: 'navigate' }, line: 7 },
        { messageId: 'navigate', data: { method: 'navigate' }, line: 8 },
        { messageId: 'navigate', data: { method: 'navigate' }, line: 9 },
        { messageId: 'navigate', data: { method: 'navigateByUrl' }, line: 10 },
      ],
    },
    // A non-empty-array routerLink, and a static attribute, stay reported.
    {
      filename: at('src/app/patterns/menu/menu.ts'),
      code: component('<a [routerLink]="[\'x\']">a</a><a routerLink="x">b</a>'),
      errors: [{ messageId: 'routerLink' }, { messageId: 'routerLink' }],
    },
  ],
});

describe('navigation-through-outcomes, screenshot-kind and page-screenshot-whole-page in recommended', () => {
  const config = [
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      ...qits.configs.recommended[0],
    },
  ];
  it('are the only rules set to warn', () => {
    const levels = qits.configs.recommended[0].rules;
    assert.equal(levels['qits/navigation-through-outcomes'], 'warn');
    assert.equal(levels['qits/screenshot-kind'], 'warn');
    assert.equal(levels['qits/page-screenshot-whole-page'], 'warn');
    assert.deepEqual(
      Object.keys(levels).filter((r) => levels[r] === 'warn'),
      [
        'qits/page-screenshot-whole-page',
        'qits/navigation-through-outcomes',
        'qits/screenshot-kind',
      ],
    );
  });
  it('warns, and an eslint-disable pair round an inline template silences it', () => {
    const file = at('src/app/routes/work/work.page.ts');
    const lint = (code) =>
      new Linter()
        .verify(code, config, file)
        .filter((m) => m.ruleId === 'qits/navigation-through-outcomes');
    const code = component('<a routerLink="/a">a</a>');
    assert.deepEqual(
      lint(code).map((m) => m.severity),
      [1],
    );
    const disabled = code
      .replace(
        '  template:',
        '  /* eslint-disable qits/navigation-through-outcomes -- links out of the app */\n  template:',
      )
      .replace('`,\n', '`,\n  /* eslint-enable qits/navigation-through-outcomes */\n');
    assert.deepEqual(lint(disabled), []);
    assert.deepEqual(
      lint(
        FIELD.replace(
          '    void this.router',
          '    // eslint-disable-next-line qits/navigation-through-outcomes -- redirect page\n    void this.router',
        ),
      ),
      [],
    );
  });
});
