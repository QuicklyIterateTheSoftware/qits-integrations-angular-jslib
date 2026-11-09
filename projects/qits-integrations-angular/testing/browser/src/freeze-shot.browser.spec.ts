import {
  BLOB_PLACEHOLDER,
  FREEZE_ASSET_PREFIX,
  freezeShot,
  splitSelectors,
  stripPseudo,
} from './freeze-shot';

/** Mounts `html` in a fresh body, with `css` as the only stylesheet of the test. */
function mount(html: string, css = ''): void {
  document.head.querySelectorAll('style[data-freeze-spec]').forEach((s) => s.remove());
  const style = document.createElement('style');
  style.dataset['freezeSpec'] = '';
  style.textContent = css;
  document.head.append(style);
  document.body.innerHTML = html;
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const styleOf = (html: string) => /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? '';
const bodyOf = (html: string) => /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';

afterEach(() => {
  document.body.innerHTML = '';
  document.head.querySelectorAll('style[data-freeze-spec]').forEach((s) => s.remove());
});

describe('freezeShot', () => {
  it('keeps the ancestors as empty shells and the element whole', () => {
    mount(
      '<main class="app"><nav>menu</nav><section class="page"><p>before</p>' +
        '<article id="shot"><h1>Title</h1><p>text</p></article></section></main>',
    );
    const { html } = freezeShot(byId('shot'));
    expect(html.startsWith('<!doctype html>\n<html')).toBe(true);
    expect(html.endsWith('</body></html>\n')).toBe(true);
    expect(html).toContain('<head><meta charset="utf-8"><style>');
    expect(bodyOf(html)).toBe(
      '<main class="app"><section class="page"><article id="f0"><h1>Title</h1><p>text</p>' +
        '</article></section></main>',
    );
  });

  it('freezes the body with everything in it for the page or the body', () => {
    mount('<p>one</p><p>two</p>');
    expect(bodyOf(freezeShot(null).html)).toBe('<p>one</p><p>two</p>');
    expect(bodyOf(freezeShot(document.body).html)).toBe('<p>one</p><p>two</p>');
    expect(bodyOf(freezeShot(document.documentElement).html)).toBe('<p>one</p><p>two</p>');
  });

  it('drops scripts, handlers, javascript: URLs, preload links, comments and Angular noise', () => {
    mount(
      '<div id="shot" ng-version="22.0.0" ng-reflect-value="x"><!--container-->' +
        '<script>window.ran = 1</script><noscript>no</noscript><template><b>t</b></template>' +
        '<link rel="modulepreload" href="/x.js"><link rel="stylesheet" href="/y.css">' +
        '<a href="javascript:alert(1)" onclick="alert(1)">a</a>' +
        '<a href=" JavaScript:alert(1)">b</a><a href="/next">c</a>' +
        '<iframe srcdoc="<script>1</script>"></iframe>' +
        '<svg><script>1</script><circle onload="x()" r="1"></circle></svg></div>',
    );
    const body = bodyOf(freezeShot(byId('shot')).html);
    expect(body).toBe(
      '<div id="f0"><a>a</a><a>b</a><a href="/next">c</a><iframe></iframe>' +
        '<svg><circle r="1"></circle></svg></div>',
    );
  });

  it('writes live form state, open state and canvas pixels into the markup', () => {
    mount(
      '<form id="shot"><input id="name" value="old"><input type="checkbox" id="c1" checked>' +
        '<input type="radio" name="r" id="r1"><textarea id="t">old</textarea>' +
        '<select id="s"><option value="a" selected>A</option><option value="b">B</option></select>' +
        '<details id="d"><summary>more</summary>x</details><dialog id="g">hi</dialog>' +
        '<canvas id="cv" width="2" height="2" class="chart"></canvas></form>',
    );
    (byId('name') as HTMLInputElement).value = 'typed';
    (byId('c1') as HTMLInputElement).checked = false;
    (byId('r1') as HTMLInputElement).checked = true;
    (byId('t') as HTMLTextAreaElement).value = 'new text';
    (byId('s') as HTMLSelectElement).value = 'b';
    (byId('d') as HTMLDetailsElement).open = true;
    (byId('g') as HTMLDialogElement).show();
    const context = (byId('cv') as HTMLCanvasElement).getContext('2d')!;
    context.fillStyle = 'red';
    context.fillRect(0, 0, 2, 2);

    const body = bodyOf(freezeShot(byId('shot')).html);
    expect(body).toContain('<input id="f1" value="typed">');
    expect(body).toContain('<input type="checkbox" id="f2">');
    expect(body).toContain('<input type="radio" name="r" id="f3" checked="">');
    expect(body).toContain('<textarea id="f4">new text</textarea>');
    expect(body).toContain('<option value="a">A</option><option value="b" selected="">B</option>');
    expect(body).toContain('<details id="f6" open="">');
    expect(body).toContain('<dialog id="f7" open="">');
    expect(body).toMatch(
      /<img id="f8" width="2" height="2" class="chart" src="data:image\/png;base64,[^"]+">/,
    );
    expect(body).not.toContain('<canvas');
  });

  it('renames _ngcontent/_nghost ids and element ids in order, with what refers to them', () => {
    mount(
      '<app-card id="shot" _nghost-ng-c991="">' +
        '<label for="email-7" _ngcontent-ng-c991="">Mail</label>' +
        '<input id="email-7" aria-describedby="hint-3 err-3" list="opts" _ngcontent-ng-c991="">' +
        '<p id="hint-3">hint</p><datalist id="opts"></datalist>' +
        '<ui-badge _nghost-ng-c12="" _ngcontent-ng-c991=""><a href="#hint-3">h</a></ui-badge>' +
        '<svg><defs><linearGradient id="grad-42"></linearGradient></defs>' +
        '<rect fill="url(#grad-42)"></rect></svg></app-card>',
      '[_nghost-ng-c991] { display: block; } label[_ngcontent-ng-c991] { color: red; }' +
        ' [_nghost-ng-c12] { color: blue; } #hint-3 { color: green; }',
    );
    const { html } = freezeShot(byId('shot'));
    expect(bodyOf(html)).toBe(
      '<app-card id="f0" _nghost-c0="">' +
        '<label for="f1" _ngcontent-c0="">Mail</label>' +
        '<input id="f1" aria-describedby="f2 f5" list="f3" _ngcontent-c0="">' +
        '<p id="f2">hint</p><datalist id="f3"></datalist>' +
        '<ui-badge _nghost-c1="" _ngcontent-c0=""><a href="#f2">h</a></ui-badge>' +
        '<svg><defs><linearGradient id="f4"></linearGradient></defs>' +
        '<rect fill="url(#f4)"></rect></svg></app-card>',
    );
    const css = styleOf(html);
    expect(css).toContain('[_nghost-c0] { display: block; }');
    expect(css).toContain('label[_ngcontent-c0] { color: red; }');
    expect(css).toContain('[_nghost-c1] { color: blue; }');
    expect(css).toContain('#f2 { color: green; }');
    expect(html).not.toMatch(/ng-c\d|email-7|hint-3|grad-42/);
  });

  it('keeps only the rules that can apply, with pseudo-classes and pseudo-elements stripped', () => {
    mount(
      '<div class="shell dark"><div class="frame"><section id="shot" class="card">' +
        '<button class="btn md:wide">go</button></section></div><aside class="other"></aside></div>',
      [
        ':root { --gap: 4px; }',
        '* { box-sizing: border-box; }',
        'html { color: black; }',
        'body { margin: 0px; }',
        '.dark .card { background: black; }',
        '.card > .btn:hover { color: red; }',
        '.btn::before { content: "x"; }',
        '.md\\:wide { width: 100%; }',
        '.frame:has(.card) { padding: 1px; }',
        '.other { color: blue; }',
        ':is(.absent > *) { margin-top: 1px; }',
        ':is(.card > *) { margin-top: 2px; }',
        ':where(.absent > :not(:last-child)) { margin-left: 1px; }',
        ':where(.card > :not(:last-child)) { margin-left: 3px; }',
        '.missing, .btn:focus-visible { color: red; }',
        '@media (min-width: 1px) { .card { margin: 1px; } .other { margin: 2px; } }',
        '@media print { .other { margin: 3px; } }',
        '@supports (display: grid) { .btn { display: grid; } }',
        '@layer base, components;',
        '@layer components { .btn { font-weight: 600; } .other { font-weight: 100; } }',
        '@property --spin { syntax: "<angle>"; inherits: false; initial-value: 0deg; }',
        '@keyframes spin { to { rotate: 1turn; } }',
      ].join('\n'),
    );
    const css = styleOf(freezeShot(byId('shot')).html);
    for (const kept of [
      ':root { --gap: 4px; }',
      '* { box-sizing: border-box; }',
      'html { color: black; }',
      'body { margin: 0px; }',
      '.dark .card { background: black; }',
      '.card > .btn:hover { color: red; }',
      '.btn::before { content: "x"; }',
      '.md\\:wide { width: 100%; }',
      '.frame:has(.card) { padding: 1px; }',
      '.missing, .btn:focus-visible { color: red; }',
      '@media (min-width: 1px) {\n.card { margin: 1px; }\n}',
      '@supports (display: grid) {\n.btn { display: grid; }\n}',
      '@layer base, components;',
      '@layer components {\n.btn { font-weight: 600; }\n}',
      '@property --spin {',
    ]) {
      expect(css).toContain(kept);
    }
    expect(css).not.toContain('.other');
    expect(css).not.toContain('.absent');
    expect(css).toContain(':is(.card > *) { margin-top: 2px; }');
    expect(css).toContain(':where(.card > :not(:last-child)) { margin-left: 3px; }');
    expect(css).not.toContain('@media print');
    expect(css).not.toContain('@keyframes');
  });

  it('keeps @font-face for the families in use, and marks same-origin assets', () => {
    mount(
      '<div id="shot" style="background: url(/img/bg.png)">' +
        '<img src="/img/logo.svg?v=2" srcset="/img/a.png 1x, https://cdn.test/b.png 2x">' +
        '<img src="https://projects.test/avatar.png"><img src="data:image/png;base64,AAAA">' +
        '<svg><use href="/img/icons.svg#star"></use></svg></div>',
      `@font-face { font-family: "Used Face"; src: url("/fonts/used.woff2") format("woff2"); }
       @font-face { font-family: "Other Face"; src: url("/fonts/other.woff2") format("woff2"); }
       body { font-family: "Used Face", sans-serif; }
       #shot { background-image: url(https://cdn.test/x.png); }`,
    );
    const { html, assets } = freezeShot(byId('shot'));
    const css = styleOf(html);
    expect(css).toContain(`url("${FREEZE_ASSET_PREFIX}/fonts/used.woff2")`);
    expect(css).not.toContain('Other Face');
    expect(css).toContain('url("https://cdn.test/x.png")');
    const body = bodyOf(html);
    expect(body).toContain(
      `style="background: url(&quot;${FREEZE_ASSET_PREFIX}/img/bg.png&quot;)"`,
    );
    expect(body).toContain(`src="${FREEZE_ASSET_PREFIX}/img/logo.svg"`);
    expect(body).toContain(
      `srcset="${FREEZE_ASSET_PREFIX}/img/a.png 1x, https://cdn.test/b.png 2x"`,
    );
    expect(body).toContain('src="https://projects.test/avatar.png"');
    expect(body).toContain('src="data:image/png;base64,AAAA"');
    expect(body).toContain(`href="${FREEZE_ASSET_PREFIX}/img/icons.svg#star"`);
    expect(assets).toEqual([
      '/fonts/used.woff2',
      '/img/a.png',
      '/img/bg.png',
      '/img/icons.svg',
      '/img/logo.svg',
    ]);
  });

  it('gives the same bytes for the same DOM however the ids were generated', () => {
    const shot = (n: number) => {
      mount(
        `<div id="shot" _nghost-ng-c${n}=""><label for="i${n}" _ngcontent-ng-c${n}="">L</label>` +
          `<input id="i${n}" _ngcontent-ng-c${n}=""></div>`,
        `[_nghost-ng-c${n}] { color: red; }`,
      );
      return freezeShot(byId('shot')).html;
    };
    expect(shot(1)).toBe(shot(2));
  });
});

describe('freezeShot in a shared page', () => {
  const extra: HTMLStyleElement[] = [];
  const inject = (css: string) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    extra.push(style);
  };
  afterEach(() => extra.splice(0).forEach((style) => style.remove()));

  it('keeps a rule once however often its sheet was injected', () => {
    const SETUP = `@font-face { font-family: "Inter Test"; src: url("/fonts/inter.woff2"); }
      html, body { margin: 0px; font-family: "Inter Test", sans-serif; }
      * { caret-color: transparent; }
      @media (min-width: 1px) { .card { padding: 1px; } }`;
    mount('<section id="shot" class="card">x</section>');
    inject(SETUP);
    const once = freezeShot(byId('shot')).html;
    inject(SETUP);
    inject(SETUP);
    const thrice = freezeShot(byId('shot')).html;
    expect(thrice).toBe(once);
    const css = styleOf(once);
    expect(css.match(/@font-face/g)).toHaveLength(1);
    expect(css.match(/\* \{ caret-color/g)).toHaveLength(1);
    expect(css.match(/\.card \{ padding: 1px; \}/g)).toHaveLength(1);
    // The same rule in another context is another rule.
    inject('@media print { .card { padding: 1px; } }');
    expect(styleOf(freezeShot(byId('shot')).html)).toContain(
      '@media print {\n.card { padding: 1px; }\n}',
    );
  });

  it('renumbers counter-numbered class names in order of appearance, in the HTML and the CSS', () => {
    const shot = (n: number) => {
      mount(
        `<div id="shot"><div class="xterm xterm-dom-renderer-owner-${n} p-4"><span class="row">a</span></div>` +
          `<div class="xterm-dom-renderer-owner-${n + 3}">b</div></div>`,
        `.xterm-dom-renderer-owner-${n} .row { color: red; }` +
          ` .xterm-dom-renderer-owner-${n + 3} { color: blue; } .p-4 { padding: 1rem; }`,
      );
      return freezeShot(byId('shot')).html;
    };
    const html = shot(7);
    expect(html).toBe(shot(12));
    expect(bodyOf(html)).toBe(
      '<div id="f0"><div class="xterm xterm-dom-renderer-owner-0 p-4"><span class="row">a</span></div>' +
        '<div class="xterm-dom-renderer-owner-1">b</div></div>',
    );
    const css = styleOf(html);
    expect(css).toContain('.xterm-dom-renderer-owner-0 .row { color: red; }');
    expect(css).toContain('.xterm-dom-renderer-owner-1 { color: blue; }');
    expect(css).toContain('.p-4 { padding: 1rem; }');
    // Other patterns replace the default; a class that is not matched whole stays.
    mount('<div id="shot" class="tile-3 xterm-dom-renderer-owner-9 tile-3-x"></div>');
    expect(bodyOf(freezeShot(byId('shot'), document, { renameClasses: [/tile-\d+/] }).html)).toBe(
      '<div id="f0" class="tile-0 xterm-dom-renderer-owner-9 tile-3-x"></div>',
    );
  });

  it("drops xterm's measured row transform, and only the properties and elements named", () => {
    mount(
      '<div id="shot"><div class="xterm-accessibility" style="width: 835px;">' +
        '<div role="list" class="xterm-accessibility-tree">' +
        '<div role="listitem" style="height: 15px; transform: scaleX(0.996885);">a</div>' +
        '<div role="listitem" style="transform: scaleX(0.99);">b</div></div></div>' +
        '<p style="transform: scaleX(0.5);">kept</p></div>',
    );
    const body = bodyOf(freezeShot(byId('shot')).html);
    expect(body).not.toContain('scaleX(0.99');
    expect(body).toContain('<div role="listitem" style="height: 15px;">a</div>');
    expect(body).toContain('<div role="listitem">b</div>');
    expect(body).toContain('<div class="xterm-accessibility" style="width: 835px;">');
    expect(body).toContain('<p style="transform: scaleX(0.5);">kept</p>');
    // Other rules replace the default.
    const own = freezeShot(byId('shot'), document, {
      dropInlineStyles: [{ selector: 'p', properties: ['transform'] }],
    }).html;
    expect(bodyOf(own)).toContain('<p>kept</p>');
    expect(bodyOf(own)).toContain('transform: scaleX(0.996885)');
  });

  it('inlines a loaded blob image as PNG data and turns any other blob URL into a placeholder', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 3;
    canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 3, 2);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), 'image/png'));
    const url = URL.createObjectURL(blob);
    mount(
      `<div id="shot" style="background: url(${url})"><img id="loaded" src="${url}">` +
        '<img id="dead" src="blob:http://localhost/0000-gone"></div>',
      `#shot { background-image: url("${url}"); }`,
    );
    const loaded = byId('loaded') as HTMLImageElement;
    await loaded.decode();
    const html = freezeShot(byId('shot')).html;
    URL.revokeObjectURL(url);
    expect(html).not.toContain('blob:');
    expect(bodyOf(html)).toMatch(/<img id="f1" src="data:image\/png;base64,[^"]+">/);
    expect(bodyOf(html)).toContain(`<img id="f2" src="${BLOB_PLACEHOLDER}">`);
    expect(bodyOf(html)).toContain(`style="background: url(&quot;${BLOB_PLACEHOLDER}&quot;)"`);
    expect(styleOf(html)).toContain(`#f0 { background-image: url("${BLOB_PLACEHOLDER}"); }`);
  });
});

describe('splitSelectors / stripPseudo', () => {
  it('splits a list outside parentheses, brackets and escapes', () => {
    expect(splitSelectors('.a, :is(.b, .c) .d, [data-x="1,2"], .e\\,f')).toEqual([
      '.a',
      ':is(.b, .c) .d',
      '[data-x="1,2"]',
      '.e\\,f',
    ]);
  });

  it('strips pseudo-classes and pseudo-elements, and fills an emptied compound with *', () => {
    expect(stripPseudo('.a:hover')).toBe('.a');
    expect(stripPseudo('.a::before')).toBe('.a');
    expect(stripPseudo('.a > :first-child')).toBe('.a > *');
    expect(stripPseudo(':root')).toBe('*');
    expect(stripPseudo(':not(.x):hover ~ .y')).toBe('* ~ .y');
    expect(stripPseudo('.hover\\:bg:hover')).toBe('.hover\\:bg');
    expect(stripPseudo('[data-a=":b"]:focus')).toBe('[data-a=":b"]');
    expect(stripPseudo('.a:is(.b, .c)  .d')).toBe('.a:is(.b, .c) .d');
  });

  it('keeps :is/:where/:matches/:-webkit-any/:has with stripped arguments, and drops :not', () => {
    expect(stripPseudo(':is(.a:hover, .b)')).toBe(':is(.a, .b)');
    expect(stripPseudo(':is(.\\*\\:col-span-full > *)')).toBe(':is(.\\*\\:col-span-full > *)');
    expect(stripPseudo(':where(.space-x-4 > :not(:last-child))')).toBe(':where(.space-x-4 > *)');
    expect(stripPseudo(':where(:hover)')).toBe(':where(*)');
    expect(stripPseudo(':matches(.a::before)')).toBe(':matches(.a)');
    expect(stripPseudo(':-webkit-any(.a:focus)')).toBe(':-webkit-any(.a)');
    expect(stripPseudo('.card:has(> .icon:hover)')).toBe('.card:has(> .icon)');
    expect(stripPseudo('.card:has(.x, + .y)')).toBe('.card:has(.x, + .y)');
    expect(stripPseudo('.a:not(:hover)')).toBe('.a');
    expect(stripPseudo(':not(.x)')).toBe('*');
    expect(stripPseudo(':is(:not(.x))')).toBe(':is(*)');
    expect(stripPseudo('.a:nth-child(2n + 1)::after')).toBe('.a');
  });
});
