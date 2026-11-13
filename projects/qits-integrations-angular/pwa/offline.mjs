/**
 * Step 5 of `qits-angular pwa --check` (ticket qits-2152): the built app starts offline. It serves
 * the build output from an in-process static server on 127.0.0.1 (localhost is a secure context,
 * so a service worker registers there), opens it in the consumer's Playwright Chromium, waits for
 * the worker to control the page and cache the prefetched shell, then reloads offline and looks
 * for the shell's content.
 *
 * Playwright is the consumer's, resolved from the project root: the library depends on no browser.
 * Only the `app` recipe's renderer image (`node-browser-base`) carries Chromium.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findIndex } from './checks.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serves `dist` on 127.0.0.1 at a free port: a file as itself, any other path without an extension
 * as the index (the SPA fallback), anything else 404. Nothing is cached by the browser's HTTP cache,
 * so what works offline is the worker's doing. Resolves `{ url, close() }`.
 */
export function serveStatic(dist) {
  const root = resolve(dist);
  const index = findIndex(root) ?? 'index.html';
  const server = createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const isFile = (f) => existsSync(f) && statSync(f).isFile();
    if (!isFile(file)) {
      if (extname(path) && !path.endsWith('/')) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      file = join(root, index);
      if (!isFile(file)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/** The URLs `ngsw.json` prefetches at install: what must be cached before the app goes offline. */
function prefetchUrls(dist) {
  try {
    const control = JSON.parse(readFileSync(join(dist, 'ngsw.json'), 'utf8'));
    return (control.assetGroups ?? [])
      .filter((group) => group.installMode === 'prefetch')
      .flatMap((group) => group.urls ?? []);
  } catch {
    return [];
  }
}

/** Playwright's `chromium`, from the consumer's own `playwright`, resolved from `root`. */
async function loadChromium(root) {
  const require = createRequire(join(resolve(root), 'package.json'));
  const module = await import(pathToFileURL(require.resolve('playwright')).href);
  const chromium = module.chromium ?? module.default?.chromium;
  if (!chromium) throw new Error('it exports no chromium');
  return chromium;
}

const firstLine = (error) =>
  String(error?.message ?? error)
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? 'unknown error';

/**
 * Whether a worker controls the page within `timeout` ms: `controlled`, `ready` (a worker is active
 * but this page is not its client yet; a reload makes it one), or `none`.
 */
function controlState(page, timeout) {
  return page.evaluate(
    (ms) =>
      new Promise((done) => {
        const sw = navigator.serviceWorker;
        if (!sw) return done('none');
        if (sw.controller) return done('controlled');
        let active = false;
        const timer = setTimeout(
          () => done(sw.controller ? 'controlled' : active ? 'ready' : 'none'),
          ms,
        );
        sw.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          done('controlled');
        });
        sw.ready.then(() => {
          active = true;
          // A worker that claims its clients does so right after it activates.
          setTimeout(() => {
            clearTimeout(timer);
            done(sw.controller ? 'controlled' : 'ready');
          }, 1000);
        });
      }),
    timeout,
  );
}

/** Polls `predicate` in the page every 250 ms until it is true or `timeout` ms pass. */
async function pollPage(page, predicate, argument, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(predicate, argument).catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 250));
  }
}

/**
 * Runs step 5 and resolves its failures (none: the app started offline). `timeout` (ms) bounds each
 * wait: the worker taking control, it caching the shell, and the offline start.
 *
 * @param {{ root: string, dist: string, shell: string, timeout: number }} options
 */
export async function checkOfflineStart({ root, dist, shell, timeout }) {
  let chromium;
  try {
    chromium = await loadChromium(root);
  } catch (error) {
    return [
      `offline start: needs the renderer image (playwright is not resolvable from ${root}: ${firstLine(error)})`,
    ];
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return [
      `offline start: needs the renderer image (Chromium did not start: ${firstLine(error)})`,
    ];
  }
  const server = await serveStatic(dist);
  const seconds = `${Math.round(timeout / 1000)} s`;
  try {
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    try {
      await page.goto(server.url, { waitUntil: 'load', timeout });
    } catch (error) {
      return [`offline start: ${server.url} did not load online: ${firstLine(error)}`];
    }
    let state = await controlState(page, timeout);
    if (state === 'ready') {
      await page.reload({ waitUntil: 'load', timeout });
      state = await controlState(page, timeout);
    }
    if (state !== 'controlled')
      return [
        `offline start: service worker not registered (no worker controlled the page in ${seconds})`,
      ];

    const urls = prefetchUrls(dist);
    const cached = await pollPage(
      page,
      async (list) => {
        for (const url of list) if (!(await caches.match(url))) return false;
        return true;
      },
      urls,
      timeout,
    );
    if (!cached)
      return [`offline start: the worker did not cache the prefetched app shell in ${seconds}`];

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: 'load', timeout });
    } catch (error) {
      return [`offline start: the app did not load offline: ${firstLine(error)}`];
    }
    const shown = await pollPage(
      page,
      (selector) => !!document.querySelector(selector)?.firstElementChild,
      shell,
      timeout,
    );
    if (!shown) {
      const attached = await page
        .evaluate((s) => !!document.querySelector(s), shell)
        .catch(() => false);
      return [
        attached
          ? `offline start: ${shell} shows nothing offline (no child element in ${seconds})`
          : `offline start: ${shell} is not on the page offline`,
      ];
    }
    return [];
  } finally {
    await browser.close().catch(() => undefined);
    await server.close();
  }
}
