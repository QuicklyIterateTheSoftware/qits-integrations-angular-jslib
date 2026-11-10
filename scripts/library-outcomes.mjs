// The library's own outcomes() declarations (ticket qits-2044), read from its source with the same
// reader an app's go through, into projects/qits-integrations-angular/screenshots/outcomes.json.
// That file ships in the package beside outcomes.mjs, which merges an entry into an app's declared
// outcomes when the app imports one of the entry's `provides`.
//
//   pnpm outcomes:library            rewrites the file
//   pnpm outcomes:library --check    exits 1 when the committed file is not what it would write
//
// The reading itself is `libraryOutcomesText()`, which the screenshots tests hold the committed
// file against.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { readOutcomes } from '../projects/qits-integrations-angular/screenshots/outcomes.mjs';

const PROJECT = fileURLToPath(new URL('../projects/qits-integrations-angular/', import.meta.url));

/** Where the declarations are read, relative to the project. */
const SOURCES = 'src/lib';

/** The outcome API itself: it declares nothing. */
const API = 'src/lib/outcomes';

/** The file written, relative to the project. */
export const LIBRARY_OUTCOMES = 'screenshots/outcomes.json';

/** The same, relative to the repository, for the messages. */
const SHOWN = `projects/qits-integrations-angular/${LIBRARY_OUTCOMES}`;

/** The command that regenerates it, for the messages. */
export const REGENERATE = 'pnpm outcomes:library';

/**
 * Each declaring file's scope, and the exports that bring its declarations into an app. A file that
 * declares outcomes and is missing here fails the run: its scope is a decision, not a default.
 */
const SCOPES = {
  'src/lib/sign-in/auth-callback.page.ts': {
    route: 'auth/callback',
    global: false,
    provides: ['qitsAuthCallbackRoute', 'provideQitsBearerSignIn'],
  },
  'src/lib/sign-in/qits-session.ts': {
    route: null,
    global: true,
    provides: ['qitsSignedInGuard', 'QitsSession'],
  },
};

const isSource = (name) => name.endsWith('.ts') && !name.endsWith('.d.ts');
const isSpec = (name) => /\.spec\.ts$/.test(name);

function sourcesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(join(PROJECT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (path === API) continue;
    if (entry.isDirectory()) found.push(...sourcesUnder(path));
    else if (isSource(entry.name) && !isSpec(entry.name)) found.push(path);
  }
  return found.sort();
}

/** An import of the outcome API from a library file: the relative path resolves to it. */
const fromApi = (specifier, file) =>
  specifier.startsWith('.') &&
  posix.normalize(posix.join(posix.dirname(file), specifier)) === `${API}/outcomes`;

/** The entries `outcomes.json` holds, read from the library's source now. */
export function libraryOutcomesEntries() {
  const ts = createRequire(import.meta.url)('typescript');
  const files = sourcesUnder(SOURCES)
    .map((file) => ({ file, text: readFileSync(join(PROJECT, file), 'utf8') }))
    .filter(({ text }) => text.includes('outcomes'));
  const { declared, unreadable } = readOutcomes({
    ts,
    files: files.map(({ file, text }) => ({
      file,
      text,
      scope: SCOPES[file] ?? { route: null, global: true },
    })),
    from: fromApi,
  });
  const problems = unreadable.map(({ file, line, why }) => `${file}:${line}: ${why}`);
  for (const file of new Set(declared.map((entry) => entry.file))) {
    if (!SCOPES[file]) {
      problems.push(`${file} declares outcomes but has no scope: add it to SCOPES in this script.`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`library outcomes: ${problems.join('; ')}`);
  }
  return declared.map((entry) => ({
    ...entry,
    file: `@qits/angular/${entry.file}`,
    provides: SCOPES[entry.file].provides,
  }));
}

/** `outcomes.json` as this run would write it, formatted as the repository's prettier does. */
export async function libraryOutcomesText() {
  const path = join(PROJECT, LIBRARY_OUTCOMES);
  const options = (await resolveConfig(path)) ?? {};
  return format(JSON.stringify(libraryOutcomesEntries()), { ...options, parser: 'json' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = join(PROJECT, LIBRARY_OUTCOMES);
  const text = await libraryOutcomesText();
  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(path, 'utf8');
    } catch {
      // Missing: as stale as a different one.
    }
    if (committed !== text) {
      console.error(`${SHOWN} is stale: run ${REGENERATE}.`);
      process.exit(1);
    }
    console.log(`${SHOWN} is current.`);
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${SHOWN}`);
  }
}
