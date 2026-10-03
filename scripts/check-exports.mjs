// Guards the thing that actually ships: dist/qits-integrations-angular/package.json, the manifest
// ng-packagr generates from projects/qits-integrations-angular/package.json and that `npm publish`
// uploads verbatim. The root manifest is the workspace harness — it is not the package and must
// never become publishable again.
//
// Run after `pnpm build`; the CI pipeline builds before it publishes, so every failure here is a
// failure before anything reaches the registry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist/qits-integrations-angular';
const SOURCE = 'projects/qits-integrations-angular/package.json';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
const dist = JSON.parse(readFileSync(join(DIST, 'package.json'), 'utf8'));

let failed = false;
const fail = (message) => {
  console.error(message);
  failed = true;
};

// The root is the harness. `private: true` here is what stops a stray publish from the checkout
// root shipping the workspace instead of the library.
if (root.private !== true) {
  fail('the workspace root must keep "private": true — it is the harness, not the package');
}
for (const field of ['files', 'exports']) {
  if (root[field]) {
    fail(
      `the workspace root declares "${field}" — that is the retired git-install shape; the published manifest is ${DIST}/package.json`,
    );
  }
}

// projects/…/package.json is the single source of truth for identity; ng-packagr copies it through.
if (dist.name !== source.name) {
  fail(`name drift: ${SOURCE} says ${source.name}, ${DIST} says ${dist.name}`);
}
if (dist.version !== source.version) {
  fail(`version drift: ${SOURCE} says ${source.version}, ${DIST} says ${dist.version}`);
}

// A private manifest is one npm refuses to publish, so the publish step would fail at the very end
// of a long green pipeline. Fail here instead, and fix it in SOURCE — never by editing dist/.
if (dist.private) {
  fail(
    `${DIST}/package.json carries "private": true — npm publish refuses it; remove it from ${SOURCE}`,
  );
}
for (const field of ['description', 'license']) {
  if (!dist[field]) {
    fail(`${DIST}/package.json has no "${field}" — add it to ${SOURCE}`);
  }
}

// The entry points a consumer resolves have to be in the tarball, not just in the manifest.
const entry = dist.exports?.['.'] ?? {};
for (const key of ['types', 'default']) {
  const target = entry[key];
  if (!target) {
    fail(`${DIST}/package.json exports["."].${key} is missing`);
  } else if (!existsSync(join(DIST, target))) {
    fail(`${DIST}/package.json exports["."].${key} points at ${target}, which is not in ${DIST}`);
  }
}

// Every other entry point and every command must be in the tarball too: the plain-ESM ones
// (eslint, screenshots, bin) are copied as assets, so a missing glob only shows here.
for (const [subpath, conditions] of Object.entries(dist.exports ?? {})) {
  if (subpath === '.' || subpath === './package.json') continue;
  const targets = typeof conditions === 'string' ? [conditions] : Object.values(conditions);
  for (const target of targets) {
    if (typeof target === 'string' && !existsSync(join(DIST, target))) {
      fail(
        `${DIST}/package.json exports["${subpath}"] points at ${target}, which is not in ${DIST}`,
      );
    }
  }
}
for (const [command, target] of Object.entries(dist.bin ?? {})) {
  if (!existsSync(join(DIST, target))) {
    fail(`${DIST}/package.json bin["${command}"] points at ${target}, which is not in ${DIST}`);
  }
}

// The workspace builds and tests against its own node_modules while the consumer resolves what the
// published manifest declares. Both directions of drift ship a package whose imports resolve for
// nobody but us.
for (const [pkg, range] of Object.entries(dist.dependencies ?? {})) {
  if (root.dependencies?.[pkg] !== range) {
    fail(
      `dependency drift: the published manifest declares ${pkg}@${range}, the workspace root has ${root.dependencies?.[pkg]}`,
    );
  }
}
for (const pkg of Object.keys(root.dependencies ?? {})) {
  if (!dist.dependencies?.[pkg]) {
    fail(
      `dependency drift: the workspace root declares ${pkg}, missing from the published manifest (add it to ${SOURCE})`,
    );
  }
}

// Peers are the consumer's to provide, but they must be resolvable here or neither the build nor
// the specs prove anything about a peer range this package actually declares.
for (const [pkg, range] of Object.entries(dist.peerDependencies ?? {})) {
  if (!root.devDependencies?.[pkg]) {
    fail(
      `peer drift: the published manifest declares peer ${pkg}@${range}, the workspace root does not devDepend on it`,
    );
  }
}

if (failed) process.exit(1);
console.log(
  `publishable: ${dist.name}@${dist.version} in ${DIST} (identity, entry points, deps and peers check out)`,
);
