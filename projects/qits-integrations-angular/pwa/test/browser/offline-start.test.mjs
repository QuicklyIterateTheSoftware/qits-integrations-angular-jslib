// node --test: `qits-angular pwa --check` with the real offline start, in Playwright's Chromium,
// on an app shell built under <repo>/tmp (git-ignored) with Angular's real ngsw-worker.js and an
// ngsw.json made by its `ngsw-config`. Part of `pnpm test:browser`, which needs Chromium;
// `pnpm test` runs the file checks in ../pwa.test.mjs with a stand-in for this step.
import { after, describe, it } from 'node:test';
import { copyFileSync, cpSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { strict as assert } from 'node:assert';
import { pwa } from '../../cli.mjs';
import { INDEX_HTML, opted } from '../fixtures.mjs';

const require = createRequire(import.meta.url);
const SERVICE_WORKER = dirname(require.resolve('@angular/service-worker/package.json'));

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** The shell's script: renders into `<app-root>` and registers the worker, as `provideQitsPwa` does. */
const MAIN_JS = `document.querySelector('app-root').innerHTML = '<h1>Offline Demo</h1>';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () =>
    navigator.serviceWorker.controller?.postMessage({ action: 'INITIALIZE' }),
  );
  navigator.serviceWorker.register('ngsw-worker.js').catch(() => undefined);
}
`;

/** The README's recommended prefetch group, or one that leaves the scripts out of it. */
const ngswConfig = (files) => ({
  $schema: './node_modules/@angular/service-worker/config/schema.json',
  index: '/index.html',
  assetGroups: [{ name: 'app', installMode: 'prefetch', resources: { files } }],
  navigationUrls: ['/**', '!/**/*.*', '!/api/**'],
});
const RECOMMENDED = ['/index.html', '/manifest.webmanifest', '/*.css', '/*.js', '/icons/*.png'];

/** An opted-in app, written and built: the shell, the manifest, the icons, ngsw.json and the worker. */
async function built(files = RECOMMENDED) {
  const app = opted('pwa-offline-');
  roots.push(app.root);
  assert.equal(await pwa(['--write'], { cwd: app.root, out: () => undefined }), 0);
  const dist = join(app.root, 'dist/demo/browser');
  cpSync(join(app.root, 'public'), dist, { recursive: true });
  app.write('dist/demo/browser/index.html', INDEX_HTML);
  app.write('dist/demo/browser/main.js', MAIN_JS);
  app.write('dist/demo/browser/styles.css', 'body { margin: 0; }\n');
  app.write('ngsw-config.json', JSON.stringify(ngswConfig(files)));
  execFileSync(
    process.execPath,
    [join(SERVICE_WORKER, 'ngsw-config.js'), relative(app.root, dist), 'ngsw-config.json'],
    { cwd: app.root },
  );
  copyFileSync(join(SERVICE_WORKER, 'ngsw-worker.js'), join(dist, 'ngsw-worker.js'));
  return { ...app, dist };
}

/** Runs `--check` with the real offline start; resolves the exit code and every line. */
async function check(root, timeout) {
  const out = [];
  const err = [];
  const code = await pwa(['--check', '--dist', 'dist/demo/browser', '--timeout', String(timeout)], {
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

describe('qits-angular pwa --check, offline start', { timeout: 180_000 }, () => {
  it('passes an app shell that installs and starts offline', async () => {
    const { root } = await built();
    const { code, out, err } = await check(root, 60);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(out, ['dist/demo/browser installs and starts offline']);
  });

  it('fails with "service worker not registered" when the worker is removed', async () => {
    const { root, dist } = await built();
    unlinkSync(join(dist, 'ngsw-worker.js'));
    const { code, err } = await check(root, 5);
    assert.equal(code, 1);
    assert.equal(err.length, 2, err.join('\n'));
    assert.equal(err[0], `worker: ngsw-worker.js is not in ${dist}`);
    assert.match(err[1], /^offline start: service worker not registered/);
  });

  it('fails when the offline start shows no shell', async () => {
    // The worker caches the index but not the script that renders into it.
    const { root } = await built(['/index.html', '/manifest.webmanifest', '/icons/*.png']);
    const { code, err } = await check(root, 10);
    assert.equal(code, 1);
    assert.deepEqual(err, [
      'offline start: app-root shows nothing offline (no child element in 10 s)',
    ]);
  });
});
