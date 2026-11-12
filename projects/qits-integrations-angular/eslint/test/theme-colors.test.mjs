// node --test: qits/theme-colors against a throwaway app tree under <repo>/tmp (git-ignored).
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
const app = mkdtempSync(join(process.cwd(), 'tmp', 'eslint-theme-colors-'));
after(() => rmSync(app, { recursive: true, force: true }));

const touch = (path, content = '') => {
  mkdirSync(dirname(join(app, path)), { recursive: true });
  writeFileSync(join(app, path), content);
};
const at = (path) => join(app, path);

const CINNABAR_600 = 'oklch(0.577 0.245 27.325)';

touch('package.json', JSON.stringify({ name: 'qits-demo-app' }));
// The entry stylesheet: Tailwind (not followed), a local theme, and the shared tokens.
touch(
  'src/styles.css',
  [
    "@import 'tailwindcss';",
    "@import './theme.css';",
    "@import '@qits/ui-components/theme.css' layer(theme);",
    '',
  ].join('\n'),
);
// The local palette steps; its import of the entry stylesheet is a cycle the reader survives.
touch(
  'src/theme.css',
  [
    '@import url("./styles.css");',
    '/* steps the app adds to the palette */',
    '@theme {',
    '  --color-charcoal-brown-600: oklch(0.45 0.03 50);',
    '  --color-cinnabar-100: oklch(0.94 0.03 30);',
    `  --color-cinnabar-600: ${CINNABAR_600};`,
    '}',
    '',
  ].join('\n'),
);
touch(
  'node_modules/@qits/ui-components/package.json',
  JSON.stringify({
    name: '@qits/ui-components',
    exports: { './theme.css': { style: './dist/theme.css' } },
  }),
);
// The semantic tokens, their light values, and dark overrides that must not drive suggestions:
// were they read, `--surface` (declared first) would match charcoal-brown-600 and white would
// match `fg-muted`.
touch(
  'node_modules/@qits/ui-components/dist/theme.css',
  [
    '@theme inline {',
    '  --color-surface: var(--surface);',
    '  --color-fg-muted: var(--fg-muted);',
    '  --color-danger: var(--danger);',
    '}',
    ':root {',
    '  --surface: var(--color-white);',
    '  --fg-muted: var(--color-charcoal-brown-600);',
    `  --danger: ${CINNABAR_600};`,
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root { --surface: var(--color-charcoal-brown-600); --fg-muted: var(--color-white); }',
    '}',
    '[data-theme="dark"] { --surface: var(--color-charcoal-brown-600); --danger: #fff; }',
    '@custom-variant dark { --fg-muted: var(--color-white); }',
    '',
  ].join('\n'),
);
// Another stylesheet for the `theme` option.
touch('src/alt.css', '@theme {\n  --color-paper: var(--color-white);\n}\n');

touch(
  'src/app/badge/badge.html',
  '<span class="p-1">\n  <b class="font-bold text-charcoal-brown-600">x</b>\n</span>\n',
);
touch('src/app/badge/plain.html', '<span class="bg-surface text-fg-muted">x</span>\n');
touch(
  'src/app/badge/badge.css',
  '#badge { color: #fff; }\n.a { background: url(#gradient); }\n.b { color: var(--color-surface); }\n',
);

const FILE = at('src/app/badge/badge.ts');
const component = (template, extra = '') =>
  `import { Component } from '@angular/core';\n@Component({\n  selector: 'app-x',${extra}\n  template: \`${template}\`,\n})\nexport class X {}`;
const styled = (styles) =>
  `import { Component } from '@angular/core';\n@Component({\n  selector: 'app-x',\n  template: '',\n  styles: ${styles},\n})\nexport class X {}`;
const fixed = (name, hint, where = '') =>
  `${name} is a fixed colour; use a semantic token from the theme${hint ? ` (${hint})` : ''}${where}`;
/** One reported token with its suggestion: the error, given the code it sits in. */
const swap = (code, name, replacement, extra = {}) => ({
  message: fixed(name, replacement),
  ...(replacement && {
    suggestions: [
      { messageId: 'replace', data: { replacement }, output: code.replace(name, replacement) },
    ],
  }),
  ...extra,
});
/** A test whose only error is `name` replaced by `replacement`. */
const invalid = (code, name, replacement, extra = {}) => ({
  filename: FILE,
  code,
  errors: [swap(code, name, replacement, extra)],
});

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const rule = qits.rules['theme-colors'];

const ALLOWED = [
  'bg-surface',
  'text-fg-muted/50',
  'hover:bg-surface',
  'dark:text-danger',
  'bg-[var(--color-surface)]',
  'bg-(--color-surface)',
  'text-current',
  'bg-transparent',
  'border-inherit',
  'text-sm',
  'border-2',
  'bg-cover',
  'text-center',
  'shadow-lg',
  'text-[13px]',
  'bg-[url(/img/a.png)]',
  'bg-brand',
  'border-xs',
];

tester.run('theme-colors', rule, {
  valid: [
    // Semantic tokens, colour keywords, non-colour suffixes and unknown names.
    { filename: FILE, code: component(`<div class="${ALLOWED.join(' ')}"></div>`) },
    { filename: FILE, code: `const c = '${ALLOWED.join(' ')}';` },
    {
      filename: FILE,
      code: component('<div [class.bg-surface]="on" [ngClass]="{ \'p-2\': on }"></div>'),
    },
    // Raw colours in TypeScript strings are not utilities.
    {
      filename: FILE,
      code: "const blank = getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)';\nconst brand = '#2563eb';\nconst word = 'red';",
    },
    // Interpolated parts are never checked, and a token touching `${}` is not a whole token.
    { filename: FILE, code: 'const c = `bg-${tone}-500 text-${x}`;' },
    { filename: FILE, code: 'const c = `text-white${suffix} ${x}bg-black`;' },
    { filename: FILE, code: component('<div class="{{ a }}bg-white p-1"></div>') },
    { filename: FILE, code: component('<p class="bg-${tone}-500 text-white${x}">x</p>') },
    // Module names are not text.
    { filename: FILE, code: "import x from 'bg-white';" },
    // Styles: semantic vars, keywords, `#id` selectors, hex inside url(), names in name properties.
    {
      filename: FILE,
      code: styled(
        '[`#main .bg-white { color: var(--color-surface); background: url(#fff); border-color: currentColor; outline-color: transparent; }`, \'.a { animation-name: tomato; font-family: Tan, serif; content: "red"; }\']',
      ),
    },
    {
      filename: FILE,
      code: component('<div style="color: var(--color-fg-muted); width: 2px"></div>'),
    },
    {
      filename: FILE,
      code: component('<div [style.color]="tone" [ngStyle]="{ color: tone }"></div>'),
    },
    { filename: FILE, code: styled("'.a { @apply bg-surface text-fg-muted p-2; }'") },
    // An external template and stylesheet with only semantic colours.
    {
      filename: FILE,
      code: component('', "\n  templateUrl: './plain.html',").replace('\n  template: ``,', ''),
    },
    // An unreadable templateUrl is the build's problem.
    {
      filename: FILE,
      code: component('', "\n  templateUrl: './missing.html',").replace('\n  template: ``,', ''),
    },
    // Under another theme, the default one's tokens are unknown names.
    { filename: FILE, code: "const c = 'bg-paper';", options: [{ theme: 'src/alt.css' }] },
  ],
  invalid: [
    // Inline template: precise location, suggestion keeps the family.
    {
      ...invalid(
        component('<p class="p-1 text-charcoal-brown-600">x</p>'),
        'text-charcoal-brown-600',
        'text-fg-muted',
      ),
      errors: [
        swap(
          component('<p class="p-1 text-charcoal-brown-600">x</p>'),
          'text-charcoal-brown-600',
          'text-fg-muted',
          { line: 4, column: 28, endLine: 4, endColumn: 51 },
        ),
      ],
    },
    // Variants, important and opacity are kept; the dark overrides do not drive the suggestion.
    invalid(
      component('<p class="hover:bg-white/50">x</p>'),
      'hover:bg-white/50',
      'hover:bg-surface/50',
    ),
    invalid(component('<p class="dark:bg-gray-900">x</p>'), 'dark:bg-gray-900', undefined),
    invalid(component('<p class="!bg-white">x</p>'), '!bg-white', '!bg-surface'),
    invalid(component('<p class="bg-white!">x</p>'), 'bg-white!', 'bg-surface!'),
    invalid(
      component('<p class="md:hover:border-x-cinnabar-600">x</p>'),
      'md:hover:border-x-cinnabar-600',
      'md:hover:border-x-danger',
    ),
    // Arbitrary values and the var shorthand.
    invalid(component('<p class="bg-[#fff]">x</p>'), 'bg-[#fff]', 'bg-surface'),
    invalid(
      component('<p class="text-[oklch(50%_0.1_20)]">x</p>'),
      'text-[oklch(50%_0.1_20)]',
      undefined,
    ),
    invalid(
      component('<p class="bg-(--color-charcoal-brown-600)">x</p>'),
      'bg-(--color-charcoal-brown-600)',
      'bg-fg-muted',
    ),
    invalid(
      component('<p class="bg-[var(--color-white)]">x</p>'),
      'bg-[var(--color-white)]',
      'bg-surface',
    ),
    invalid(
      component('<p class="text-[color:var(--color-cinnabar-600)]">x</p>'),
      'text-[color:var(--color-cinnabar-600)]',
      'text-danger',
    ),
    invalid(component('<p class="ring-offset-red-500">x</p>'), 'ring-offset-red-500', undefined),
    // A step the theme declares but no semantic token resolves to.
    invalid(component('<p class="bg-cinnabar-100">x</p>'), 'bg-cinnabar-100', undefined),
    // Bound classes: [class.x], [ngClass] keys and literals, a ternary in [class], a template literal.
    invalid(component('<p [class.bg-white]="on">x</p>'), 'bg-white', 'bg-surface'),
    invalid(
      component('<p [ngClass]="{ \'p-1 text-cinnabar-600\': on }">x</p>'),
      'text-cinnabar-600',
      'text-danger',
    ),
    invalid(component('<p [ngClass]="[\'bg-black\', other]">x</p>'), 'bg-black', undefined),
    invalid(component("<p [class]=\"on ? 'bg-white' : 'p-2'\">x</p>"), 'bg-white', 'bg-surface'),
    invalid(component('<p class="p-1 {{ a }} bg-white">x</p>'), 'bg-white', 'bg-surface'),
    // Inside a structural directive the attribute is reported once.
    invalid(component('<p *ngIf="on" class="bg-white">x</p>'), 'bg-white', 'bg-surface'),
    // Styles in templates.
    invalid(component('<p style="color: #fff">x</p>'), '#fff', 'var(--color-surface)'),
    invalid(component('<p [style.color]="\'#fff\'">x</p>'), '#fff', 'var(--color-surface)'),
    invalid(
      component('<p [ngStyle]="{ color: \'oklch(0.577 0.245 27.325)\' }">x</p>'),
      CINNABAR_600,
      'var(--color-danger)',
    ),
    invalid(
      component('<p [style]="\'background: var(--color-charcoal-brown-600)\'">x</p>'),
      'var(--color-charcoal-brown-600)',
      'var(--color-fg-muted)',
    ),
    // TypeScript strings: class maps and plain strings, utilities only.
    invalid("const classes = { 'bg-white': on, 'p-1': true };", 'bg-white', 'bg-surface'),
    invalid(
      'const c = `p-1 text-charcoal-brown-600 ${x} m-2`;',
      'text-charcoal-brown-600',
      'text-fg-muted',
    ),
    invalid(
      "@Component({ selector: 'x', host: { class: 'bg-white' } })\nclass X {}",
      'bg-white',
      'bg-surface',
    ),
    // An Angular expression held in a string: the quotes end the token.
    invalid(
      `const host = { '[class]': "on ? 'p-1 bg-white/25' : 'p-2'" };`,
      'bg-white/25',
      'bg-surface/25',
    ),
    // Inline styles: raw colours in values, palette vars, @apply.
    invalid(styled("'.a { color: #fff; }'"), '#fff', 'var(--color-surface)'),
    invalid(styled("['.b { color: red; }']"), 'red', undefined),
    invalid(
      styled('`.a {\n  border: 1px solid oklch(0.577 0.245 27.325);\n}`'),
      CINNABAR_600,
      'var(--color-danger)',
    ),
    invalid(
      styled("'.a { background: color-mix(in oklab, var(--color-surface) 50%, transparent); }'"),
      'color-mix(in oklab, var(--color-surface) 50%, transparent)',
      undefined,
    ),
    invalid(styled("'.a { @apply p-2 bg-white; }'"), 'bg-white', 'bg-surface'),
    // Escapes shift the offsets: reported on the template property, without a suggestion.
    {
      filename: FILE,
      code: styled("''").replace("template: ''", "template: '<p class=\"bg-white\">it\\'s</p>'"),
      errors: [{ message: fixed('bg-white', 'bg-surface'), line: 4, column: 13 }],
    },
    // A template with `${}` is parsed with each `${}` filled in; its static classes are read.
    invalid(component('<p class="bg-white ${x}">x</p>'), 'bg-white', 'bg-surface'),
    // External template: reported on templateUrl, with the location in the message.
    {
      filename: FILE,
      code: component('', "\n  templateUrl: './badge.html',").replace('\n  template: ``,', ''),
      errors: [
        {
          message: fixed(
            'text-charcoal-brown-600',
            'text-fg-muted',
            ' (src/app/badge/badge.html:2:23)',
          ),
          line: 4,
        },
      ],
    },
    // External stylesheet: the declaration value only, never the `#badge` selector.
    {
      filename: FILE,
      code: component('', "\n  styleUrl: './badge.css',"),
      errors: [
        {
          message: fixed('#fff', 'var(--color-surface)', ' (src/app/badge/badge.css:1:17)'),
          line: 4,
        },
      ],
    },
    {
      filename: FILE,
      code: component('', "\n  styleUrls: ['./badge.css'],"),
      errors: [
        { message: fixed('#fff', 'var(--color-surface)', ' (src/app/badge/badge.css:1:17)') },
      ],
    },
    // The `theme` option: another stylesheet's tokens.
    {
      ...invalid("const c = 'bg-white';", 'bg-white', 'bg-paper'),
      options: [{ theme: 'src/alt.css' }],
    },
    // A missing theme: still reported, with the no-theme message.
    {
      filename: FILE,
      code: "const c = 'bg-white text-charcoal-brown-600';",
      options: [{ theme: 'src/nope.css' }],
      errors: [
        {
          messageId: 'fixedNoTheme',
          data: { name: 'bg-white', theme: 'src/nope.css', where: '' },
        },
      ],
    },
  ],
});

describe('theme-colors messages', () => {
  it('names the missing theme', () => {
    const messages = new Linter().verify(
      "const c = 'bg-white';",
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { qits },
          rules: { 'qits/theme-colors': ['error', { theme: 'src/nope.css' }] },
        },
      ],
      FILE,
    );
    assert.deepEqual(
      messages.map((m) => m.message),
      [
        '`bg-white` is a fixed colour; the theme src/nope.css was not found, so no semantic token is known',
      ],
    );
  });
});

describe('theme-colors in recommended', () => {
  const code = `${component('<p class="bg-white text-gray-500" style="color: #fff">x</p>')}\nconst c = 'bg-black';`;
  const lint = (rules) =>
    new Linter()
      .verify(
        code,
        [
          {
            files: ['**/*.ts'],
            languageOptions: { parser: tseslint.parser },
            ...qits.configs.recommended[0],
          },
          ...(rules ? [{ files: ['**/*.ts'], rules }] : []),
        ],
        FILE,
      )
      .filter((m) => m.ruleId === 'qits/theme-colors');
  it('is not enabled by recommended', () => {
    assert.equal(qits.configs.recommended[0].rules['qits/theme-colors'], undefined);
    assert.deepEqual(lint(), []);
  });
  it('reports once an app enables it', () => {
    assert.deepEqual(
      lint({ 'qits/theme-colors': 'error' }).map((m) => m.message),
      [
        fixed('bg-white', 'bg-surface'),
        fixed('text-gray-500'),
        fixed('#fff', 'var(--color-surface)'),
        fixed('bg-black'),
      ],
    );
  });
});
