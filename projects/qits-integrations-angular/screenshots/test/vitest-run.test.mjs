// node --test: screenshotReferences() in a real Vitest browser run (Chromium, through Playwright),
// on a throwaway app under <repo>/tmp (git-ignored). Part of `pnpm test:browser`, which needs
// Chromium; `pnpm test` runs the stand-in tests in screenshots.test.mjs instead.
import { after, before, describe, it } from 'node:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { startVitest } from 'vitest/node';
import { findOrphans } from '../index.mjs';
import { DEFAULT_RECORD } from '../record.mjs';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

mkdirSync('tmp', { recursive: true });
const root = mkdtempSync(join(process.cwd(), 'tmp', 'screenshots-run-'));
after(() => rmSync(root, { recursive: true, force: true }));

const write = (path, content) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const SPEC = 'src/box/box.browser.spec.ts';
const shot = (name) =>
  `src/box/__screenshots__/box.browser.spec.ts/${name}-chromium-${platform()}.png`;

write(
  'vitest.config.mjs',
  `import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { screenshotReferences } from ${JSON.stringify(INDEX)};

export default defineConfig({
  plugins: [screenshotReferences()],
  test: {
    include: ['src/**/*.browser.spec.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
});
`,
);
// Names from an it.each table, a template string and a path: the record must hold them as Vitest
// resolves them.
write(
  SPEC,
  `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

const box = (colour: string) => {
  document.body.innerHTML =
    '<div data-testid="box" style="width:40px;height:20px;background:' + colour + '"></div>';
  return page.getByTestId('box');
};

it.each(['red', 'blue'])('a %s box', async (colour) => {
  await expect.element(box(colour)).toMatchScreenshot(\`box-\${colour}\`);
});

it('an open menu', async () => {
  await expect.element(box('green')).toMatchScreenshot('menu/open');
});
`,
);

/** One run of the app's browser tests. Returns whether every test passed. */
async function run({ update = false, testNamePattern } = {}) {
  const vitest = await startVitest('test', [], {
    root,
    watch: false,
    update,
    reporters: ['dot'],
    ...(testNamePattern ? { testNamePattern } : {}),
  });
  const passed = vitest.state.getCountOfFailedTests() === 0 && !process.exitCode;
  await vitest.close();
  process.exitCode = 0;
  return passed;
}

const record = () => JSON.parse(readFileSync(join(root, DEFAULT_RECORD), 'utf8'));

describe('screenshotReferences in a Vitest browser run', { timeout: 180_000 }, () => {
  before(async () => {
    // The first run writes the references, as the baselines job does.
    assert.ok(await run({ update: true }), 'the update run passes');
  });

  it('records the references every test resolved, and the spec as complete', async () => {
    assert.ok(await run());
    assert.deepEqual(record().specs[SPEC].references, [
      shot('box-blue'),
      shot('box-red'),
      shot('menu/open'),
    ]);
    assert.equal(record().specs[SPEC].complete, true);
    assert.deepEqual(findOrphans({ root, record: DEFAULT_RECORD }).orphans, []);
  });

  it('finds a reference whose name no test takes any more', async () => {
    copyFileSync(join(root, shot('box-red')), join(root, shot('box-renamed')));
    assert.ok(await run());
    assert.deepEqual(
      findOrphans({ root, record: DEFAULT_RECORD }).orphans.map((o) => [o.path, o.reason]),
      [[shot('box-renamed'), 'unused']],
    );
  });

  it('does not judge a spec when a filter skipped some of its tests', async () => {
    assert.ok(await run({ testNamePattern: 'open menu' }));
    assert.equal(record().specs[SPEC].complete, false);
    assert.deepEqual(record().specs[SPEC].references, [shot('menu/open')]);
    const { orphans, unchecked } = findOrphans({ root, record: DEFAULT_RECORD });
    assert.deepEqual(orphans, []);
    assert.equal(unchecked[0].spec, SPEC);
  });
});

/**
 * The Vitest config of a throwaway app with freezes on: `@qits/angular` points at `src/qits-angular.ts`
 * there (the modules of the library the setup uses: route telemetry, the outcome recorder and the
 * offline testing hook), the setup file is `src/setup.ts`.
 */
const freezesConfig = (app) => `import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { screenshotReferences } from ${JSON.stringify(INDEX)};

export default defineConfig({
  plugins: [screenshotReferences({ freezes: true })],
  resolve: {
    alias: [
      { find: /^@qits\\/angular$/, replacement: ${JSON.stringify(join(app, 'src/qits-angular.ts'))} },
    ],
  },
  optimizeDeps: {
    include: [
      '@angular/common',
      '@angular/compiler',
      '@angular/core',
      '@angular/core/testing',
      '@angular/common/http',
      '@angular/common/http/testing',
      '@angular/platform-browser/testing',
      '@angular/router',
      '@opentelemetry/api',
    ],
  },
  test: {
    include: ['src/**/*.browser.spec.ts'],
    setupFiles: ['src/setup.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
});
`;

// The screenshot freezes (ticket qits-1947): freezeScreenshots() and recordOutcomes() in the setup
// file (the library's source, with @qits/angular pointed at the two modules they use),
// screenshotReferences({ freezes }) in the config.
describe('screenshot freezes in a Vitest browser run', { timeout: 300_000 }, () => {
  const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const app = mkdtempSync(join(process.cwd(), 'tmp', 'freezes-run-'));
  after(() => rmSync(app, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), content);
  };
  const FORM = 'src/form/form.browser.spec.ts';
  const FREEZES = join(app, 'src/testing/browser/freezes');
  const freeze = (name) => join(FREEZES, FORM, `${name}.html`);
  const manifest = () => JSON.parse(readFileSync(join(FREEZES, 'manifest.json'), 'utf8'));
  /** Every file under the freeze directory, path → content. */
  const tree = () =>
    Object.fromEntries(
      readdirSync(FREEZES, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort()
        .map((path) => [path.slice(FREEZES.length + 1), readFileSync(path, 'utf8')]),
    );

  put('vitest.config.mjs', freezesConfig(app));
  put(
    'src/qits-angular.ts',
    `export * from ${JSON.stringify(join(LIBRARY, 'src/lib/route-telemetry.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/outcomes/outcome-recorder.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/offline/offline-testing.ts'))};
`,
  );
  put(
    'src/setup.ts',
    // The guard imports Angular's partially compiled packages: JIT needs the compiler here.
    `import '@angular/compiler';
import { freezeScreenshots } from ${JSON.stringify(join(LIBRARY, 'testing/browser/src/freeze-screenshots.ts'))};
import { recordOutcomes } from ${JSON.stringify(join(LIBRARY, 'testing/browser/src/record-outcomes.ts'))};

recordOutcomes();
freezeScreenshots({ routes: [{ path: '', redirectTo: 'a', pathMatch: 'full' }, { path: 'a', children: [{ path: 'b/:id' }] }] });
`,
  );
  put('src/fonts/test-font.woff2', 'not really a font');
  const CSS = `
  @font-face { font-family: 'Freeze Test'; src: url('/src/fonts/test-font.woff2') format('woff2'); }
  @font-face { font-family: 'Unused Face'; src: url('/src/fonts/unused.woff2') format('woff2'); }
  body { font-family: 'Freeze Test', sans-serif; margin: 0; }
  .card { border: 2px solid rgb(200, 0, 0); padding: 4px; }
  .card:hover .field::placeholder { color: gray; }
  .unused-rule { color: blue; }
  @keyframes spin { to { transform: rotate(1turn); } }
  @media (min-width: 1px) { .field { color: rgb(0, 128, 0); } .not-here { color: red; } }
`;
  const spec = (withMenu, typed = 'Ada') => `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { recordOutcome } from '@qits/angular';

const mount = (html: string) => {
  document.head.querySelector('style[data-freeze-test]')?.remove();
  const style = document.createElement('style');
  style.dataset.freezeTest = '';
  style.textContent = ${JSON.stringify(CSS)};
  document.head.append(style);
  document.body.innerHTML = '<main class="shell"><p>beside</p><div class="frame">' + html + '</div></main>';
};

it('a filled form', async () => {
  mount('<form data-testid="form" class="card"><!-- a comment --><label for="name">Name</label>' +
    '<input id="name" class="field" onclick="alert(1)"><script>window.ran = true</script>' +
    '<a href="javascript:alert(1)">x</a></form>');
  await page.getByLabelText('Name').fill('${typed}');
  await expect.element(page.getByTestId('form')).toMatchScreenshot('filled');
});
${
  withMenu
    ? `
it('an open menu', async () => {
  mount('<div data-testid="menu" class="card"><button class="field" data-qits-outcome="menu:open">Open</button>' +
    '<button hidden data-qits-outcome="menu:closed">Close</button></div>');
  recordOutcome({ interaction: 'menu', outcome: 'open', kind: 'stay', to: null });
  await expect.element(page.getByTestId('menu')).toMatchScreenshot('menu/open');
});
`
    : ''
}`;
  put(FORM, spec(true));
  // A spec that holds a test with it.skip: its passing shot is frozen all the same.
  const HELD = 'src/held/held.browser.spec.ts';
  put(
    HELD,
    `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

it.skip('a held test', () => {});

it('a shown box', async () => {
  document.body.innerHTML = '<div data-testid="box" style="width:30px;height:10px;background:red"></div>';
  await expect.element(page.getByTestId('box')).toMatchScreenshot('shown');
});
`,
  );

  async function runFreezes({ update = false, testNamePattern } = {}) {
    const vitest = await startVitest('test', [], {
      root: app,
      watch: false,
      update,
      reporters: ['dot'],
      ...(testNamePattern ? { testNamePattern } : {}),
    });
    const passed = vitest.state.getCountOfFailedTests() === 0 && !process.exitCode;
    await vitest.close();
    process.exitCode = 0;
    return passed;
  }

  /** One update run's failure messages, per spec (relative to the app). */
  async function failuresOf() {
    const vitest = await startVitest('test', [], {
      root: app,
      watch: false,
      update: true,
      reporters: ['dot'],
    });
    const failures = {};
    const collect = (task, spec) => {
      for (const error of task.result?.errors ?? []) (failures[spec] ??= []).push(error.message);
      for (const child of task.tasks ?? []) collect(child, spec);
    };
    for (const file of vitest.state.getFiles()) collect(file, file.filepath.slice(app.length + 1));
    await vitest.close();
    process.exitCode = 0;
    return failures;
  }

  before(async () => {
    assert.ok(await runFreezes({ update: true }), 'the update run passes');
  });

  it('freezes every passing shot as HTML without scripts, with its state and its CSS', () => {
    const html = readFileSync(freeze('filled'), 'utf8');
    assert.match(html, /^<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><style>\n/);
    assert.doesNotMatch(html, /<script|onclick|javascript:|<!--/);
    assert.match(html, /<input id="f0" class="field" value="Ada">/);
    assert.match(html, /<label for="f0">Name<\/label>/);
    // The ancestors are empty shells: the sibling paragraph is gone, the classes stay.
    assert.match(html, /<body><main class="shell"><div class="frame"><form data-testid="form"/);
    assert.doesNotMatch(html, /beside/);
    assert.match(html, /\.card \{ border: 2px solid rgb\(200, 0, 0\); padding: 4px; \}/);
    assert.match(html, /\.card:hover \.field::placeholder/);
    assert.match(html, /@media \(min-width: 1px\) \{\n\.field \{ color: rgb\(0, 128, 0\); \}\n\}/);
    assert.doesNotMatch(html, /unused-rule|not-here|@keyframes|Unused Face/);
    assert.match(html, /url\("\.\.\/\.\.\/\.\.\/assets\/test-font\.woff2"\)/);
    assert.equal(
      readFileSync(join(FREEZES, 'assets/test-font.woff2'), 'utf8'),
      'not really a font',
    );
    assert.ok(existsSync(freeze('menu/open')));
  });

  it('lists the freezes, their records, triggers and outcomes, and the route tree in the manifest', () => {
    assert.deepEqual(manifest(), {
      routes: [
        { path: '', fullPath: '', redirectTo: 'a' },
        // Neither route has a component: both render nothing (qits-2076).
        {
          path: 'a',
          fullPath: 'a',
          rendersNothing: true,
          children: [{ path: 'b/:id', fullPath: 'a/b/:id', rendersNothing: true }],
        },
      ],
      freezes: [
        {
          file: `${FORM}/filled.html`,
          spec: FORM,
          test: 'a filled form',
          name: 'filled',
          kind: null,
          viewport: null,
          route: null,
          records: [],
          triggers: [],
        },
        {
          file: `${FORM}/menu/open.html`,
          spec: FORM,
          test: 'an open menu',
          name: 'menu/open',
          kind: null,
          viewport: null,
          route: null,
          records: [],
          // The hidden button's mark is in the HTML, but not visible in the shot.
          triggers: ['menu:open'],
        },
        {
          file: `${HELD}/shown.html`,
          spec: HELD,
          test: 'a shown box',
          name: 'shown',
          kind: null,
          viewport: null,
          route: null,
          records: [],
          triggers: [],
        },
      ],
      byRoute: {},
      outcomes: {
        declared: [],
        fired: [
          {
            spec: FORM,
            test: 'an open menu',
            route: null,
            interaction: 'menu',
            outcome: 'open',
            kind: 'stay',
            freeze: `${FORM}/menu/open.html`,
          },
        ],
      },
    });
    assert.ok(readFileSync(join(FREEZES, 'manifest.json'), 'utf8').endsWith('}\n'));
  });

  it('freezes the passing shot of a spec that skips a test by declaration', () => {
    assert.match(readFileSync(join(FREEZES, HELD, 'shown.html'), 'utf8'), /data-testid="box"/);
  });

  it('writes the same bytes on the next run, and keeps a filtered spec as it was', async () => {
    const first = tree();
    assert.ok(await runFreezes());
    assert.deepEqual(tree(), first);
    // -t runs only "filled", which now shows another value: the spec's freezes stay as they were.
    put(FORM, spec(true, 'Bob'));
    assert.ok(await runFreezes({ update: true, testNamePattern: 'filled' }));
    assert.deepEqual(tree(), first);
    put(FORM, spec(true));
    assert.ok(await runFreezes({ update: true }));
    assert.deepEqual(tree(), first);
  });

  it('deletes the freeze of a shot no test takes any more, and the freezes of a deleted spec', async () => {
    put(FORM, spec(false));
    assert.ok(await runFreezes());
    assert.ok(existsSync(freeze('filled')));
    assert.ok(!existsSync(join(FREEZES, FORM, 'menu')));
    assert.deepEqual(
      manifest().freezes.map((f) => f.name),
      ['filled', 'shown'],
    );
    rmSync(join(app, FORM));
    put('src/other/other.browser.spec.ts', `import { it } from 'vitest';\nit('runs', () => {});\n`);
    assert.ok(await runFreezes());
    assert.ok(!existsSync(join(FREEZES, 'src/form')));
    assert.ok(!existsSync(join(FREEZES, 'assets')));
    assert.deepEqual(
      manifest().freezes.map((f) => f.spec),
      [HELD],
    );
  });

  // Ticket qits-1998: a page spec under the routes directory that shows its page outside the app's
  // routes fails its shot, and nothing is frozen for it; a spec elsewhere freezes as before.
  it("fails a route-directory page spec's shot of a bare createComponent, naming the spec", async () => {
    const BARE = 'src/app/routes/bare/bare.page.browser.spec.ts';
    put(
      BARE,
      `import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
const BarePage = Component({ selector: 'app-bare', template: '<p data-testid="bare">bare</p>' })(
  class BarePage {},
);

it('a bare page', async () => {
  TestBed.createComponent(BarePage).detectChanges();
  await expect.element(page.getByTestId('bare')).toMatchScreenshot('bare');
});
`,
    );
    const failures = await failuresOf();
    assert.deepEqual(Object.keys(failures), [BARE]);
    const [message] = failures[BARE];
    assert.match(
      message,
      /^freezeScreenshots: src\/app\/routes\/bare\/bare\.page\.browser\.spec\.ts /,
    );
    assert.match(message, /took the screenshot 'bare' in 'a bare page'/);
    assert.match(message, /the TestBed has no router/);
    assert.match(message, /openRoute\(\), or provideRouter\(routes\)/);
    assert.ok(!existsSync(join(FREEZES, BARE)));
    assert.ok(existsSync(join(FREEZES, HELD, 'shown.html')));
    assert.deepEqual(
      manifest().freezes.map((f) => f.spec),
      [HELD],
    );
    rmSync(join(app, 'src/app'), { recursive: true, force: true });
  });
});

// Kinds and preset widths (ticket qits-2046): freezeScreenshots({ requireKind, viewportSpecs }) in a
// real run. The specs under src/pages/ are the viewport specs; the others take one shot.
describe('screenshot kinds and preset widths in a Vitest browser run', { timeout: 300_000 }, () => {
  const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const app = mkdtempSync(join(process.cwd(), 'tmp', 'kinds-run-'));
  after(() => rmSync(app, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), content);
  };
  const FREEZES = join(app, 'src/testing/browser/freezes');
  const manifest = () => JSON.parse(readFileSync(join(FREEZES, 'manifest.json'), 'utf8'));
  const KINDS = 'src/kinds/kinds.browser.spec.ts';
  const REFUSALS = 'src/refusals/refusals.browser.spec.ts';
  const PAGE = 'src/pages/box.page.browser.spec.ts';
  const png = (spec, name) =>
    join(
      app,
      dirname(spec),
      '__screenshots__',
      spec.slice(spec.lastIndexOf('/') + 1),
      `${name}-chromium-${platform()}.png`,
    );
  const freeze = (spec, name) => readFileSync(join(FREEZES, spec, `${name}.html`), 'utf8');

  put('vitest.config.mjs', freezesConfig(app));
  put(
    'src/qits-angular.ts',
    `export * from ${JSON.stringify(join(LIBRARY, 'src/lib/route-telemetry.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/outcomes/outcome-recorder.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/offline/offline-testing.ts'))};
`,
  );
  put(
    'src/setup.ts',
    `import '@angular/compiler';
import { freezeScreenshots } from ${JSON.stringify(join(LIBRARY, 'testing/browser/src/freeze-screenshots.ts'))};
import { recordOutcomes } from ${JSON.stringify(join(LIBRARY, 'testing/browser/src/record-outcomes.ts'))};

recordOutcomes();
freezeScreenshots({ requireKind: true, viewportSpecs: /\\/src\\/pages\\/.*\\.page\\.browser\\.spec\\.ts$/ });
`,
  );
  // The box shows the viewport it was laid out at, so each freeze tells its width.
  const BOX = `const box = () => {
  document.body.innerHTML = '<div data-testid="box" style="width:60px;height:20px;background:teal"></div>';
  const el = document.querySelector('[data-testid="box"]')!;
  const show = () => (el.textContent = innerWidth + 'x' + innerHeight);
  show();
  addEventListener('resize', show);
  return page.getByTestId('box');
};
`;
  put(
    KINDS,
    `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

${BOX}
for (const kind of ['DATA', 'NO_DATA', 'PENDING', 'ERROR']) {
  it('a ' + kind + ' shot', async () => {
    await expect.element(box()).toMatchScreenshot(kind.toLowerCase(), { kind });
  });
}

it('counts every shot', async () => {
  // Vitest numbers an unnamed shot by every call in the test, named or not: this one is "2".
  await expect.element(box()).toMatchScreenshot('first', { kind: 'DATA' });
  await expect.element(box()).toMatchScreenshot({ kind: 'DATA' });
});
`,
  );
  put(
    REFUSALS,
    `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

${BOX}
it('no kind', async () => {
  await expect.element(box()).toMatchScreenshot('bare');
});

it('no reason', async () => {
  await expect.element(box()).toMatchScreenshot('hover', { kind: 'DATA', viewports: ['DESKTOP'] });
});

it('an unknown width', async () => {
  await expect.element(box()).toMatchScreenshot('watch', { kind: 'DATA', viewports: ['WATCH'], reason: 'r' } as never);
});
`,
  );
  put(
    PAGE,
    `import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { recordOutcome } from '@qits/angular';

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

${BOX}
const size = () => [innerWidth, innerHeight];

it('three widths', async () => {
  const before = size();
  recordOutcome({ interaction: 'box', outcome: 'open', kind: 'stay', to: null });
  await expect.element(box()).toMatchScreenshot('three', { kind: 'DATA' });
  expect(size()).toEqual(before);
});

it('a tall page', async () => {
  await page.viewport(800, 3400);
  await expect.element(box()).toMatchScreenshot('tall', { kind: 'NO_DATA' });
  expect(size()).toEqual([800, 3400]);
});

it('an opt-out', async () => {
  await expect.element(box()).toMatchScreenshot('hover', {
    kind: 'DATA',
    viewports: ['DESKTOP'],
    reason: 'needs a fine pointer',
  });
});

it('under fake timers', async () => {
  vi.useFakeTimers();
  try {
    await expect.element(box()).toMatchScreenshot('faked', { kind: 'PENDING' });
  } finally {
    vi.useRealTimers();
  }
});

// Change detection a resize schedules has run before each shot: the settle waits for the app.
const Width = Component({
  selector: 'app-width',
  template: '<p data-testid="width" style="width:60px">{{ width() }}</p>',
  // $event.target: a bare innerWidth in a template is the component's (undefined), not the window's.
  host: { '(window:resize)': 'width.set($any($event.target).innerWidth)' },
})(
  class Width {
    readonly width = signal(innerWidth);
  },
);

it('an Angular view', async () => {
  TestBed.createComponent(Width).detectChanges();
  await expect.element(page.getByTestId('width')).toMatchScreenshot('view', { kind: 'DATA' });
});
`,
  );

  /** One update run's failure messages, per spec (relative to the app). */
  async function failuresOf({ update = true } = {}) {
    const vitest = await startVitest('test', [], {
      root: app,
      watch: false,
      update,
      reporters: ['dot'],
    });
    const failures = {};
    const collect = (task, spec) => {
      for (const error of task.result?.errors ?? []) {
        (failures[spec] ??= []).push(`${task.name}: ${error.message}`);
      }
      for (const child of task.tasks ?? []) collect(child, spec);
    };
    for (const file of vitest.state.getFiles()) collect(file, file.filepath.slice(app.length + 1));
    await vitest.close();
    process.exitCode = 0;
    return failures;
  }

  let failures;
  before(async () => {
    failures = await failuresOf();
  });

  it('records the kind of each shot, with one shot outside the viewport specs', () => {
    assert.deepEqual(Object.keys(failures), [REFUSALS]);
    assert.deepEqual(
      manifest()
        .freezes.filter((f) => f.spec === KINDS)
        .map((f) => [f.file, f.name, f.kind, f.viewport]),
      [
        [`${KINDS}/counts-every-shot-2.html`, 'counts every shot 2', 'DATA', null],
        [`${KINDS}/data.html`, 'data', 'DATA', null],
        [`${KINDS}/error.html`, 'error', 'ERROR', null],
        [`${KINDS}/first.html`, 'first', 'DATA', null],
        [`${KINDS}/no_data.html`, 'no_data', 'NO_DATA', null],
        [`${KINDS}/pending.html`, 'pending', 'PENDING', null],
      ],
    );
    assert.ok(existsSync(png(KINDS, 'data')));
    // The PNG and the freeze of the unnamed shot carry the same number (Vitest slugs the PNG's).
    assert.ok(existsSync(png(KINDS, 'counts-every-shot-2')));
  });

  it('refuses a shot without a kind, and an opt-out without a reason or with an unknown width', () => {
    const [noKind, noReason, unknownWidth] = failures[REFUSALS];
    assert.match(
      noKind,
      /^no kind: freezeScreenshots: src\/refusals\/refusals\.browser\.spec\.ts took the screenshot 'bare' in 'no kind' without a kind\. /,
    );
    assert.match(
      noKind,
      /toMatchScreenshot\(name, \{ kind: 'DATA' \}\).*Nothing was frozen for it\.$/,
    );
    assert.match(noReason, /'hover' in 'no reason' with malformed options: .*without a reason/);
    assert.match(
      unknownWidth,
      /its viewports name "WATCH", not one of 'PHONE', 'TABLET', 'DESKTOP'/,
    );
    // Refused before Vitest's matcher ran: no reference, no freeze.
    for (const name of ['bare', 'hover', 'watch'])
      assert.ok(!existsSync(png(REFUSALS, name)), name);
    assert.ok(!existsSync(join(FREEZES, REFUSALS)));
  });

  it('takes a viewport spec’s shot at each preset width: three PNGs, three freezes', () => {
    const three = manifest().freezes.filter((f) => f.name === 'three');
    assert.deepEqual(
      three.map((f) => [f.file, f.kind, f.viewport]),
      [
        [`${PAGE}/three-desktop.html`, 'DATA', 'DESKTOP'],
        [`${PAGE}/three-phone.html`, 'DATA', 'PHONE'],
        [`${PAGE}/three-tablet.html`, 'DATA', 'TABLET'],
      ],
    );
    for (const width of ['phone', 'tablet', 'desktop']) {
      assert.ok(existsSync(png(PAGE, `three-${width}`)), width);
    }
    assert.ok(!existsSync(png(PAGE, 'three')));
    // Laid out at the preset sizes; Vitest's default viewport is 414x896, taller than TABLET's.
    assert.match(freeze(PAGE, 'three-phone'), />390x896</);
    assert.match(freeze(PAGE, 'three-tablet'), />1024x896</);
    assert.match(freeze(PAGE, 'three-desktop'), />1440x900</);
    // The test asserted its own viewport back after the shot (no failure in PAGE).
  });

  it("keeps a tall test viewport's height, and takes an opt-out at its widths only", () => {
    assert.match(freeze(PAGE, 'tall-phone'), />390x3400</);
    assert.match(freeze(PAGE, 'tall-desktop'), />1440x3400</);
    const hover = manifest().freezes.filter((f) => f.name === 'hover');
    assert.deepEqual(
      hover.map((f) => [f.file, f.viewport]),
      [[`${PAGE}/hover-desktop.html`, 'DESKTOP']],
    );
    assert.ok(existsSync(png(PAGE, 'hover-desktop')));
    assert.ok(!existsSync(png(PAGE, 'hover-phone')));
  });

  it('settles under fake timers, and waits for an Angular view to follow the width', () => {
    for (const width of ['phone', 'tablet', 'desktop']) {
      assert.ok(existsSync(join(FREEZES, PAGE, `faked-${width}.html`)), width);
    }
    assert.match(freeze(PAGE, 'view-phone'), />390</);
    assert.match(freeze(PAGE, 'view-desktop'), />1440</);
  });

  it('links the outcome to the DESKTOP freeze of the shot after it', () => {
    assert.deepEqual(
      manifest().outcomes.fired.map((f) => [f.test, f.freeze]),
      [['three widths', `${PAGE}/three-desktop.html`]],
    );
  });

  it('passes against its own references on the next run', async () => {
    const again = await failuresOf({ update: false });
    assert.deepEqual(Object.keys(again), [REFUSALS]);
  });
});

// Colour schemes (ticket qits-2083): freezeScreenshots({ colorSchemes }) in a real run. The page
// is styled differently under [data-theme="dark"] and under @media (prefers-color-scheme: dark),
// and prints what the media query says, so each PNG and each freeze tells its scheme. The same
// specs in an app without the option take exactly the shots they took before.
describe('colour schemes in a Vitest browser run', { timeout: 300_000 }, () => {
  const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const PAGE = 'src/pages/scheme.page.browser.spec.ts';
  const OWN = 'src/own/own.browser.spec.ts';
  const SETUP_IMPORTS = `import '@angular/compiler';
import { freezeScreenshots } from ${JSON.stringify(join(LIBRARY, 'testing/browser/src/freeze-screenshots.ts'))};
`;
  const VIEWPORT_SPECS = '/\\/src\\/pages\\/.*\\.page\\.browser\\.spec\\.ts$/';
  const BOX = `const CSS = '.box { width: 80px; height: 30px; background: rgb(255, 255, 255); color: rgb(0, 0, 0); }' +
  ' [data-theme="dark"] .box { background: rgb(0, 0, 0); }' +
  ' @media (prefers-color-scheme: dark) { .box { color: rgb(255, 255, 0); } }';
const box = () => {
  document.head.querySelector('style[data-scheme-test]')?.remove();
  const style = document.createElement('style');
  style.dataset.schemeTest = '';
  style.textContent = CSS;
  document.head.append(style);
  document.body.innerHTML = '<div data-testid="box" class="box"></div>';
  const el = document.querySelector('[data-testid="box"]')!;
  const query = matchMedia('(prefers-color-scheme: dark)');
  const show = () => (el.textContent = query.matches ? 'dark' : 'light');
  show();
  query.addEventListener('change', show);
  return page.getByTestId('box');
};
const restored = (theme: string | null) => {
  expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
  expect(matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);
};
`;
  /** A throwaway app with both specs, `options` given to freezeScreenshots(). */
  const makeApp = (prefix, options) => {
    const app = mkdtempSync(join(process.cwd(), 'tmp', prefix));
    const put = (path, content) => {
      mkdirSync(dirname(join(app, path)), { recursive: true });
      writeFileSync(join(app, path), content);
    };
    put('vitest.config.mjs', freezesConfig(app));
    put(
      'src/qits-angular.ts',
      `export * from ${JSON.stringify(join(LIBRARY, 'src/lib/route-telemetry.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/outcomes/outcome-recorder.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/offline/offline-testing.ts'))};
`,
    );
    put('src/setup.ts', `${SETUP_IMPORTS}\nfreezeScreenshots(${options});\n`);
    put(
      PAGE,
      `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

${BOX}
it('both schemes', async () => {
  await expect.element(box()).toMatchScreenshot('scheme', { kind: 'DATA' });
  restored(null);
});

it('an opt-out', async () => {
  document.documentElement.setAttribute('data-theme', 'sepia');
  await expect.element(box()).toMatchScreenshot('chart', {
    kind: 'DATA',
    colorSchemes: ['LIGHT'],
    reason: 'the chart has no dark palette yet',
  });
  restored('sepia');
  document.documentElement.removeAttribute('data-theme');
});
`,
    );
    put(
      OWN,
      `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

${BOX}
it('at its own viewport', async () => {
  await expect.element(box()).toMatchScreenshot('own', { kind: 'DATA' });
  restored(null);
});
`,
    );
    return app;
  };
  const withSchemes = makeApp(
    'schemes-run-',
    `{ colorSchemes: ['LIGHT', 'DARK'], viewportSpecs: ${VIEWPORT_SPECS} }`,
  );
  const without = makeApp('no-schemes-run-', `{ viewportSpecs: ${VIEWPORT_SPECS} }`);
  after(() => {
    rmSync(withSchemes, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
  });
  const freezesOf = (app) => join(app, 'src/testing/browser/freezes');
  const manifestOf = (app) =>
    JSON.parse(readFileSync(join(freezesOf(app), 'manifest.json'), 'utf8'));
  const png = (app, spec, name) =>
    join(
      app,
      dirname(spec),
      '__screenshots__',
      spec.slice(spec.lastIndexOf('/') + 1),
      `${name}-chromium-${platform()}.png`,
    );
  /** The PNG names under a spec's screenshot directory, without the browser and platform. */
  const pngs = (app, spec) =>
    readdirSync(dirname(png(app, spec, 'x')))
      .map((file) => file.replace(`-chromium-${platform()}.png`, ''))
      .sort();
  const freezeHtml = (app, spec, name) =>
    readFileSync(join(freezesOf(app), spec, `${name}.html`), 'utf8');

  /** One update run's failure messages, per spec (relative to the app). */
  async function failuresOf(app, { update = true } = {}) {
    const vitest = await startVitest('test', [], {
      root: app,
      watch: false,
      update,
      reporters: ['dot'],
    });
    const failures = {};
    const collect = (task, spec) => {
      for (const error of task.result?.errors ?? []) {
        (failures[spec] ??= []).push(`${task.name}: ${error.message}`);
      }
      for (const child of task.tasks ?? []) collect(child, spec);
    };
    for (const file of vitest.state.getFiles()) collect(file, file.filepath.slice(app.length + 1));
    await vitest.close();
    process.exitCode = 0;
    return failures;
  }

  let failures;
  before(async () => {
    failures = await failuresOf(withSchemes);
  });

  it('takes each shot in both schemes at each width: two PNGs and two freezes per width', () => {
    assert.deepEqual(failures, {});
    const widths = ['desktop', 'phone', 'tablet'];
    assert.deepEqual(pngs(withSchemes, PAGE), [
      ...widths.map((width) => `chart-${width}-light`),
      ...widths.flatMap((width) => [`scheme-${width}-dark`, `scheme-${width}-light`]),
    ]);
    assert.deepEqual(pngs(withSchemes, OWN), ['own-dark', 'own-light']);
    const { colorSchemes, freezes } = manifestOf(withSchemes);
    assert.deepEqual(colorSchemes, ['LIGHT', 'DARK']);
    assert.deepEqual(
      freezes
        .filter((f) => f.name === 'scheme' || f.name === 'own')
        .map((f) => [f.file, f.viewport, f.colorScheme, f.colorSchemeReason]),
      [
        [`${OWN}/own-dark.html`, null, 'DARK', null],
        [`${OWN}/own-light.html`, null, 'LIGHT', null],
        ...widths.flatMap((width) =>
          ['dark', 'light'].map((scheme) => [
            `${PAGE}/scheme-${width}-${scheme}.html`,
            width.toUpperCase(),
            scheme.toUpperCase(),
            null,
          ]),
        ),
      ],
    );
  });

  it('emulates the media query and sets the theme attribute for each scheme', () => {
    for (const [spec, name] of [
      [PAGE, 'scheme-phone'],
      [PAGE, 'scheme-desktop'],
      [OWN, 'own'],
    ]) {
      const light = readFileSync(png(withSchemes, spec, `${name}-light`));
      const dark = readFileSync(png(withSchemes, spec, `${name}-dark`));
      assert.ok(!light.equals(dark), `${name}: the two schemes' pixels differ`);
      assert.match(freezeHtml(withSchemes, spec, `${name}-dark`), /<html[^>]* data-theme="dark"/);
      assert.match(freezeHtml(withSchemes, spec, `${name}-dark`), /class="box">dark</);
      assert.match(freezeHtml(withSchemes, spec, `${name}-light`), /<html[^>]* data-theme="light"/);
      assert.match(freezeHtml(withSchemes, spec, `${name}-light`), /class="box">light</);
    }
    // The tests asserted the attribute (absent, or the one they set) and the emulation (reset)
    // back after each shot: no failure above.
  });

  it('takes an opt-out in its own schemes only, recording its reason', () => {
    const chart = manifestOf(withSchemes).freezes.filter((f) => f.name === 'chart');
    assert.deepEqual(
      chart.map((f) => [f.file, f.colorScheme, f.colorSchemeReason]),
      ['desktop', 'phone', 'tablet'].map((width) => [
        `${PAGE}/chart-${width}-light.html`,
        'LIGHT',
        'the chart has no dark palette yet',
      ]),
    );
  });

  it('passes against its own references on the next run', async () => {
    assert.deepEqual(await failuresOf(withSchemes, { update: false }), {});
  });

  it('takes exactly the shots of today without the option', async () => {
    assert.deepEqual(await failuresOf(without), {});
    const widths = ['desktop', 'phone', 'tablet'];
    assert.deepEqual(pngs(without, PAGE), [
      ...widths.map((width) => `chart-${width}`),
      ...widths.map((width) => `scheme-${width}`),
    ]);
    assert.deepEqual(pngs(without, OWN), ['own']);
    const written = manifestOf(without);
    assert.deepEqual(Object.keys(written), ['routes', 'freezes', 'byRoute', 'outcomes']);
    assert.deepEqual(Object.keys(written.freezes[0]), [
      'file',
      'spec',
      'test',
      'name',
      'kind',
      'viewport',
      'route',
      'records',
      'triggers',
    ]);
    assert.deepEqual(
      written.freezes.map((f) => f.file),
      [
        `${OWN}/own.html`,
        ...widths.map((width) => `${PAGE}/chart-${width}.html`),
        ...widths.map((width) => `${PAGE}/scheme-${width}.html`),
      ],
    );
    // No switching: the page stays light, and no theme attribute is set.
    assert.doesNotMatch(freezeHtml(without, OWN, 'own'), /data-theme/);
    assert.match(freezeHtml(without, OWN, 'own'), /class="box">light</);
  });
});

// Offline shots (ticket qits-2151): freezeScreenshots({ offline: true }) in a real run. The page's
// navigator.onLine is overridden by goOffline() and back after the test; every payload carries the
// connectivity, and offlineShotsNotTaken() reaches the manifest through its own command.
describe('offline shots in a Vitest browser run', { timeout: 300_000 }, () => {
  const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const SPEC = 'src/notes/notes.browser.spec.ts';
  const app = mkdtempSync(join(process.cwd(), 'tmp', 'offline-run-'));
  after(() => rmSync(app, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), content);
  };
  const SHOTS = join(LIBRARY, 'testing/browser/src/offline-shots.ts');
  put('vitest.config.mjs', freezesConfig(app));
  put(
    'src/qits-angular.ts',
    `export * from ${JSON.stringify(join(LIBRARY, 'src/lib/route-telemetry.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/outcomes/outcome-recorder.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/offline/offline-testing.ts'))};
`,
  );
  put(
    'src/setup.ts',
    `import '@angular/compiler';
import { freezeScreenshots } from ${JSON.stringify(join(LIBRARY, 'testing/browser/src/freeze-screenshots.ts'))};

freezeScreenshots({ offline: true });
`,
  );
  put(
    SPEC,
    `import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { goOffline, offlineShotsNotTaken } from ${JSON.stringify(SHOTS)};

offlineShotsNotTaken({ reason: 'the notes are read live', operations: ['qits-notes-service#renameNote'] });

const box = () => {
  document.body.innerHTML = '<p data-testid="box">' + (navigator.onLine ? 'online' : 'offline') + '</p>';
  return page.getByTestId('box');
};

it('offline', async () => {
  goOffline();
  await expect.element(box()).toMatchScreenshot('offline', { kind: 'DATA' });
});

it('back online in the next test', async () => {
  expect(navigator.onLine).toBe(true);
  await expect.element(box()).toMatchScreenshot('online', { kind: 'DATA' });
});
`,
  );

  it('records the network of each shot, and the spec’s opt-out', async () => {
    const vitest = await startVitest('test', [], {
      root: app,
      watch: false,
      update: true,
      reporters: ['dot'],
    });
    const failures = vitest.state.getCountOfFailedTests();
    await vitest.close();
    process.exitCode = 0;
    assert.equal(failures, 0);
    const manifest = JSON.parse(
      readFileSync(join(app, 'src/testing/browser/freezes/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.offline, true);
    const empty = { outbox: [], cacheResources: [], queueMutations: [] };
    assert.deepEqual(
      manifest.freezes.map((f) => [f.name, f.connectivity]),
      [
        ['offline', { network: 'OFFLINE', ...empty }],
        ['online', { network: 'ONLINE', ...empty }],
      ],
    );
    assert.deepEqual(manifest.offlineOptOuts, [
      {
        spec: SPEC,
        reason: 'the notes are read live',
        network: false,
        operations: ['qits-notes-service#renameNote'],
      },
    ]);
    assert.match(
      readFileSync(join(app, 'src/testing/browser/freezes', SPEC, 'offline.html'), 'utf8'),
      />offline</,
    );
  });
});
