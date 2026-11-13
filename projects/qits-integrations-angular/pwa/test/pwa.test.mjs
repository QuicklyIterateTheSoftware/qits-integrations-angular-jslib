// node --test: `qits-angular pwa --write | --check` on throwaway apps under <repo>/tmp
// (git-ignored). The offline start (step 5) needs Chromium: here a stand-in takes its place, and
// browser/offline-start.test.mjs (`pnpm test:browser`) runs the real one.
import { after, describe, it } from 'node:test';
import { cpSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { pwa } from '../cli.mjs';
import { pngSize } from '../checks.mjs';
import { CONFIG, ICONS, INDEX_HTML, ngswJson, opted, png } from './fixtures.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Runs the command in `root`; resolves its exit code and what it printed. */
async function run(root, args, io = {}) {
  const out = [];
  const err = [];
  const code = await pwa(args, {
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    offlineStart: async () => [],
    ...io,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), errors: err };
}

/** An opted-in app (its own root, so the theme cache never crosses fixtures). */
function app(config) {
  const fixture = opted('pwa-', config);
  roots.push(fixture.root);
  return fixture;
}

/** An app with its manifest written and a build output that passes steps 1-4. */
async function built(config) {
  const fixture = app(config);
  assert.equal((await run(fixture.root, ['--write'])).code, 0);
  cpSync(join(fixture.root, 'public'), join(fixture.root, 'dist/demo/browser'), {
    recursive: true,
  });
  fixture.write('dist/demo/browser/index.html', INDEX_HTML);
  fixture.write(
    'dist/demo/browser/main.js',
    'document.querySelector("app-root").innerHTML = "<h1>Demo</h1>";\n',
  );
  fixture.write('dist/demo/browser/ngsw-worker.js', '// the worker\n');
  fixture.write('dist/demo/browser/ngsw.json', ngswJson());
  return fixture;
}

const CHECK = ['--check', '--dist', 'dist/demo/browser'];
const manifestOf = (root) =>
  JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));

describe('qits-angular pwa --help', () => {
  it('lists its options', async () => {
    const { code, out } = await run(process.cwd(), ['--help']);
    assert.equal(code, 0);
    for (const option of ['--write', '--check', '--dist', '--config', '--root', '--timeout'])
      assert.match(out, new RegExp(`^  ${option}`, 'm'));
  });

  it('refuses a call without a mode, both modes, or --check without --dist', async () => {
    assert.equal((await run(process.cwd(), [])).code, 2);
    assert.equal((await run(process.cwd(), ['--write', '--check'])).code, 2);
    assert.equal((await run(process.cwd(), ['--check'])).code, 2);
    assert.equal((await run(process.cwd(), ['--bogus'])).code, 2);
  });
});

describe('qits-angular pwa --write', () => {
  it('writes the manifest with the colours of the theme tokens, light values', async () => {
    const { root } = app();
    const { code, out } = await run(root, ['--write']);
    assert.equal(code, 0, out);
    assert.deepEqual(manifestOf(root), {
      background_color: '#ffffff',
      description: 'An app that starts offline',
      display: 'standalone',
      icons: ICONS.map((icon) => Object.fromEntries(Object.entries(icon).sort())),
      name: 'Offline Demo',
      scope: './',
      short_name: 'Demo',
      start_url: './',
      theme_color: '#1d4ed8',
    });
  });

  it('writes stable, sorted JSON', async () => {
    const { root } = app();
    await run(root, ['--write']);
    const first = readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8');
    await run(root, ['--write']);
    assert.equal(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'), first);
    assert.ok(first.endsWith('}\n'));
    assert.deepEqual(Object.keys(JSON.parse(first)), Object.keys(JSON.parse(first)).sort());
  });

  it('takes other tokens, fields and an output', async () => {
    const { root } = app({
      ...CONFIG,
      description: undefined,
      themeColor: 'fg',
      backgroundColor: 'accent',
      display: 'minimal-ui',
      startUrl: '/start',
      output: 'public/app.webmanifest',
    });
    assert.equal((await run(root, ['--write'])).code, 0);
    const manifest = JSON.parse(readFileSync(join(root, 'public/app.webmanifest'), 'utf8'));
    assert.equal(manifest.theme_color, '#111827');
    assert.equal(manifest.background_color, '#1d4ed8');
    assert.equal(manifest.display, 'minimal-ui');
    assert.equal(manifest.start_url, '/start');
    assert.equal('description' in manifest, false);
  });

  it('reads another config with --config', async () => {
    const fixture = app();
    fixture.write('pwa/other.json', JSON.stringify({ ...CONFIG, name: 'Other' }));
    assert.equal((await run(fixture.root, ['--write', '--config', 'pwa/other.json'])).code, 0);
    assert.equal(manifestOf(fixture.root).name, 'Other');
  });

  it('exits 1 and names an unknown token', async () => {
    const { root } = app({ ...CONFIG, themeColor: 'brand' });
    const { code, err } = await run(root, ['--write']);
    assert.equal(code, 1);
    assert.match(err, /themeColor: "brand" is not a semantic @theme colour of src\/styles\.css/);
  });

  it('exits 1 on a palette step, which is no semantic token', async () => {
    const { root } = app({ ...CONFIG, backgroundColor: 'brand-700' });
    const { code, err } = await run(root, ['--write']);
    assert.equal(code, 1);
    assert.match(err, /backgroundColor: "brand-700" is not a semantic @theme colour/);
  });

  it('exits 1 and names a token that leads to no literal colour', async () => {
    const { root } = app({ ...CONFIG, themeColor: 'ghost' });
    const { code, err } = await run(root, ['--write']);
    assert.equal(code, 1);
    assert.match(err, /themeColor: "ghost" does not resolve to a literal colour/);
  });

  it('exits 1 without a config, or without its required fields', async () => {
    const fixture = app();
    unlinkSync(join(fixture.root, 'qits-pwa.json'));
    assert.match((await run(fixture.root, ['--write'])).err, /qits-pwa\.json not found/);
    fixture.write('qits-pwa.json', JSON.stringify({ name: 'x' }));
    const { code, err } = await run(fixture.root, ['--write']);
    assert.equal(code, 1);
    assert.match(err, /has no "shortName"/);
  });
});

describe('qits-angular pwa --check', () => {
  it('passes an installable build, and runs the offline start with the shell', async () => {
    const { root } = await built();
    const calls = [];
    const { code, out, err } = await run(root, [...CHECK, '--timeout', '5'], {
      offlineStart: async (options) => (calls.push(options), []),
    });
    assert.equal(code, 0, err);
    assert.match(out, /installs and starts offline/);
    assert.deepEqual(calls, [
      { root, dist: join(root, 'dist/demo/browser'), shell: 'app-root', timeout: 5000 },
    ]);
  });

  it('fails what the offline start finds', async () => {
    const { root } = await built();
    const { code, errors } = await run(root, CHECK, {
      offlineStart: async () => ['offline start: service worker not registered'],
    });
    assert.equal(code, 1);
    assert.deepEqual(errors, ['offline start: service worker not registered']);
  });

  it('fails a stale manifest', async () => {
    const fixture = await built();
    // The config moved on after the last --write. (The theme is read once per process, so a
    // changed token file would go unseen here; a fresh process sees it.)
    fixture.write('qits-pwa.json', JSON.stringify({ ...CONFIG, shortName: 'Renamed' }));
    const { code, errors } = await run(fixture.root, CHECK);
    assert.equal(code, 1);
    assert.deepEqual(errors, [
      'fresh: public/manifest.webmanifest is stale, run qits-angular pwa --write',
    ]);
  });

  it('fails a missing committed manifest', async () => {
    const fixture = await built();
    unlinkSync(join(fixture.root, 'public/manifest.webmanifest'));
    const { errors } = await run(fixture.root, CHECK);
    assert.match(errors[0], /^fresh: .*run qits-angular pwa --write$/);
  });

  it('takes a reformatted manifest as fresh', async () => {
    const { root } = await built();
    const path = join(root, 'public/manifest.webmanifest');
    writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))));
    assert.equal((await run(root, CHECK)).code, 0);
  });

  it('fails a manifest without both icon sizes', async () => {
    const { root } = await built({ ...CONFIG, icons: [ICONS[0]] });
    const { code, errors } = await run(root, CHECK);
    assert.equal(code, 1);
    assert.deepEqual(errors, ['manifest: manifest.webmanifest has no 512x512 PNG icon']);
  });

  it('fails an icon whose file is missing, or whose PNG is another size', async () => {
    const fixture = await built();
    unlinkSync(join(fixture.root, 'dist/demo/browser/icons/icon-192.png'));
    fixture.write('dist/demo/browser/icons/icon-512.png', png(256, 256));
    const { code, errors } = await run(fixture.root, CHECK);
    assert.equal(code, 1);
    assert.deepEqual(errors, [
      `manifest: icon icons/icon-192.png is not in ${join(fixture.root, 'dist/demo/browser')}`,
      'manifest: icon icons/icon-512.png is 256x256, its sizes say 512x512',
    ]);
  });

  it('fails a built manifest that is missing, or neither installable nor named', async () => {
    const fixture = await built();
    const dist = join(fixture.root, 'dist/demo/browser');
    fixture.write('dist/demo/browser/manifest.webmanifest', JSON.stringify({ display: 'browser' }));
    const { errors } = await run(fixture.root, CHECK);
    assert.deepEqual(errors, [
      'manifest: manifest.webmanifest has neither name nor short_name',
      'manifest: manifest.webmanifest has no start_url',
      'manifest: manifest.webmanifest has display "browser", not one of standalone, fullscreen, minimal-ui',
      'manifest: manifest.webmanifest has no 192x192 PNG icon',
      'manifest: manifest.webmanifest has no 512x512 PNG icon',
    ]);
    unlinkSync(join(dist, 'manifest.webmanifest'));
    assert.deepEqual((await run(fixture.root, CHECK)).errors, [
      `manifest: manifest.webmanifest is not in ${dist}`,
    ]);
  });

  it('fails an index that does not link the manifest', async () => {
    const fixture = await built();
    fixture.write(
      'dist/demo/browser/index.html',
      INDEX_HTML.replace(
        '<link rel="manifest" href="manifest.webmanifest" />',
        '<!-- <link rel="manifest" href="manifest.webmanifest"> -->',
      ),
    );
    const { code, errors } = await run(fixture.root, CHECK);
    assert.equal(code, 1);
    assert.deepEqual(errors, [
      'linked: index.html has no <link rel="manifest" href="manifest.webmanifest">',
    ]);
  });

  it('fails a build without ngsw.json', async () => {
    const fixture = await built();
    const dist = join(fixture.root, 'dist/demo/browser');
    unlinkSync(join(dist, 'ngsw.json'));
    const { code, errors } = await run(fixture.root, CHECK);
    assert.equal(code, 1);
    assert.deepEqual(errors, [
      `worker: ngsw.json is not in ${dist} (add "serviceWorker": "ngsw-config.json" to the production build)`,
    ]);
  });

  it('fails a build without the worker script', async () => {
    const fixture = await built();
    const dist = join(fixture.root, 'dist/demo/browser');
    unlinkSync(join(dist, 'ngsw-worker.js'));
    assert.deepEqual((await run(fixture.root, CHECK)).errors, [
      `worker: ngsw-worker.js is not in ${dist}`,
    ]);
  });

  it('fails a worker that does not prefetch the index', async () => {
    const fixture = await built();
    fixture.write(
      'dist/demo/browser/ngsw.json',
      ngswJson('/index.html').replace('"installMode":"prefetch"', '"installMode":"lazy"'),
    );
    assert.deepEqual((await run(fixture.root, CHECK)).errors, [
      'worker: no prefetch asset group in ngsw.json holds /index.html',
    ]);
    fixture.write('dist/demo/browser/ngsw.json', ngswJson('/other.html'));
    assert.deepEqual((await run(fixture.root, CHECK)).errors, [
      'worker: ngsw.json has index "/other.html", not /index.html',
    ]);
  });

  it('passes an SSR build, whose index is index.csr.html', async () => {
    const fixture = await built();
    const dist = join(fixture.root, 'dist/demo/browser');
    fixture.write('dist/demo/browser/index.csr.html', readFileSync(join(dist, 'index.html')));
    unlinkSync(join(dist, 'index.html'));
    fixture.write('dist/demo/browser/ngsw.json', ngswJson('/index.csr.html'));
    const { code, err } = await run(fixture.root, CHECK);
    assert.equal(code, 0, err);
  });

  it('fails a build output that does not exist', async () => {
    const { root } = app();
    await run(root, ['--write']);
    const { code, err } = await run(root, CHECK);
    assert.equal(code, 1);
    assert.match(err, /the build output dist\/demo\/browser does not exist/);
  });
});

describe('pngSize', () => {
  it('reads the IHDR size, and nothing from a file that is not a PNG', () => {
    assert.deepEqual(pngSize(png(48, 16)), { width: 48, height: 16 });
    assert.equal(pngSize(Buffer.from('<svg/>')), undefined);
  });
});
