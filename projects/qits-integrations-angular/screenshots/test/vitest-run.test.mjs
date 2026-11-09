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

  put(
    'vitest.config.mjs',
    `import { playwright } from '@vitest/browser-playwright';
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
      '@angular/compiler',
      '@angular/core',
      '@angular/core/testing',
      '@angular/common/http',
      '@angular/common/http/testing',
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
`,
  );
  put(
    'src/qits-angular.ts',
    `export * from ${JSON.stringify(join(LIBRARY, 'src/lib/route-telemetry.ts'))};
export * from ${JSON.stringify(join(LIBRARY, 'src/lib/outcomes/outcome-recorder.ts'))};
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
        { path: 'a', fullPath: 'a', children: [{ path: 'b/:id', fullPath: 'a/b/:id' }] },
      ],
      freezes: [
        {
          file: `${FORM}/filled.html`,
          spec: FORM,
          test: 'a filled form',
          name: 'filled',
          route: null,
          records: [],
          triggers: [],
        },
        {
          file: `${FORM}/menu/open.html`,
          spec: FORM,
          test: 'an open menu',
          name: 'menu/open',
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
});
