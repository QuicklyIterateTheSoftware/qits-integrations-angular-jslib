// node --test: screenshotReferences() in a real Vitest browser run (Chromium, through Playwright),
// on a throwaway app under <repo>/tmp (git-ignored). Part of `pnpm test:browser`, which needs
// Chromium; `pnpm test` runs the stand-in tests in screenshots.test.mjs instead.
import { after, before, describe, it } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
