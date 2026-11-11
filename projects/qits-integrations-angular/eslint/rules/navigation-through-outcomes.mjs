import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  LiteralArray,
  TmplAstRecursiveVisitor,
  parseTemplate,
  tmplAstVisitAll,
} from '@angular/compiler';
import {
  globRegex,
  isComponentClass,
  isSpec,
  literalText,
  nearestPackage,
  property,
} from '../project.mjs';

/** The app code the rule reads, relative to the project root, unless it is told otherwise. */
export const DEFAULT_INCLUDE = ['src/app/**'];

/** The generated clients: they navigate nowhere, and they are not ours to edit. */
export const DEFAULT_EXCLUDE = ['src/app/api/**'];

const NAVIGATE = new Set(['navigate', 'navigateByUrl']);

/** `x!`, `x as T`, `x satisfies T`: the expression inside. */
function unwrap(node) {
  while (
    node &&
    ['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression'].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

/** A member's name when it is plain (`.x`, `.#x`, `['x']`); otherwise undefined. */
function memberName(node) {
  if (!node.computed) return node.property.name;
  return typeof node.property.value === 'string' ? node.property.value : undefined;
}

/** A class member's key as `x` / `#x`, or undefined when it is computed. */
function keyName(member) {
  if (member.computed) return undefined;
  if (member.key.type === 'PrivateIdentifier') return `#${member.key.name}`;
  return member.key.name ?? member.key.value;
}

/** Whether `relativeTo`'s value is a plain identifier or a `this.<name>` / `this.#name` member. */
function isLocalRelativeTo(value) {
  value = unwrap(value);
  if (!value) return false;
  if (value.type === 'Identifier') return true;
  return (
    value.type === 'MemberExpression' &&
    !value.computed &&
    value.object.type === 'ThisExpression' &&
    (value.property.type === 'Identifier' || value.property.type === 'PrivateIdentifier')
  );
}

/**
 * Whether a `navigate(...)` call is a local click under owner decision 4 (epic qits-2000, ticket
 * qits-2038): an empty command array keeps the current route and changes only the query or
 * fragment, so it names no other route. A second argument, when there is one, has to agree: no
 * `relativeTo` at all, or one that cannot name another route either. `navigateByUrl` never
 * qualifies; callers check the method themselves.
 */
function isLocalNavigate(node) {
  const commands = unwrap(node.arguments[0]);
  if (commands?.type !== 'ArrayExpression' || commands.elements.length !== 0) return false;
  if (node.arguments.length < 2) return true;
  const options = unwrap(node.arguments[1]);
  if (options?.type !== 'ObjectExpression') return false;
  const relativeTo = property(options, 'relativeTo');
  return !relativeTo || isLocalRelativeTo(relativeTo.value);
}

/**
 * Whether a `routerLink` attribute's expression is an empty array literal (`[routerLink]="[]"`):
 * it keeps the current route and changes only the query or fragment — a local click under owner
 * decision 4 (epic qits-2000, ticket qits-2038) — so it is not reported. A static `routerLink="…"`
 * attribute has no `.ast` at all and is never exempted this way.
 */
function isEmptyRouterLink(attr) {
  const ast = attr.value?.ast;
  return ast instanceof LiteralArray && ast.expressions.length === 0;
}

/** Every `routerLink` attribute or bound input in a parsed template, once each. */
function routerLinks(nodes) {
  const found = new Map();
  const check = (attrs) => {
    for (const attr of attrs) {
      if (attr.name === 'routerLink' && !isEmptyRouterLink(attr))
        found.set(attr.sourceSpan.start.offset, attr.sourceSpan);
    }
  };
  class Visitor extends TmplAstRecursiveVisitor {
    visitElement(element) {
      check(element.attributes);
      check(element.inputs);
      super.visitElement(element);
    }
    // An `<ng-template>`, and the wrapper a structural directive (`*ngIf`) puts round an element;
    // the wrapper repeats the element's attributes, which the offset key reports once.
    visitTemplate(template) {
      check(template.attributes);
      check(template.inputs);
      check(template.templateAttrs);
      super.visitTemplate(template);
    }
  }
  tmplAstVisitAll(new Visitor(), nodes);
  return [...found.values()].sort((a, b) => a.start.offset - b.start.offset);
}

/** The `routerLink` spans of one template's text; none when it does not parse at all. */
function templateLinks(text, url) {
  try {
    return routerLinks(parseTemplate(text, url, { preserveWhitespaces: true }).nodes);
  } catch {
    return [];
  }
}

/**
 * A page navigates through the outcomes it declares (`outcomes()` / `exit()` from `@qits/angular`,
 * then `.go(params)` or `<a [qitsExit]>`), never past them: a `Router.navigate` /
 * `Router.navigateByUrl` call or a raw `routerLink` in a component template is an outcome no one
 * lists or tests. The app's code (option `include`, default `src/app/**`, minus `exclude`, default
 * `src/app/api/**`, both relative to the nearest `package.json`) is read; specs are not. The
 * library holds its own code to the rule too (`include: ['src/lib/**']`): only the outcome API's
 * implementation, whose `QitsExit` and `go()` navigate by design, is left out, by the library's own
 * `exclude: ['src/lib/outcomes/**']`. There is no type information, so the `Router` is found syntactically: the
 * names it is imported under from `@angular/router`, then `inject(Router)` (from `@angular/core`),
 * a `this.<name>` whose class property is `inject(Router)` or typed `Router` (a constructor
 * parameter property included), and a parameter or variable typed `Router` or initialised with
 * `inject(Router)`. `createUrlTree` / `parseUrl` do not navigate and are not reported. Templates
 * are parsed with `@angular/compiler`: an inline `template:` (a string, or a template literal
 * without `${}`) is reported where the attribute sits, an external `templateUrl:` on that
 * property with the `.html` file, line and column in the message. A real exception opts out
 * with an `eslint-disable-next-line` comment giving the reason.
 *
 * An empty command list — `router.navigate([], …)` (never `navigateByUrl`) or a template
 * `[routerLink]="[]"` — keeps the current route and changes only the query or fragment (a tabs
 * `?tab=`, a file picker `?path=`, a `#fragment`), so it names no other route and is not a
 * navigation an outcome would declare: a local click under owner decision 4 (epic qits-2000,
 * ticket qits-2038). `navigate([])`'s second argument, when there is one, has to agree: an object
 * literal without `relativeTo`, or with a `relativeTo` that is a plain identifier or a
 * `this.<name>` / `this.#name` member expression — anything that could still name another route
 * (`.parent`, `.root`, `.firstChild`, a call, a computed member, or a `relativeTo` behind a
 * variable the rule cannot see into) keeps the call reported.
 */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Navigation goes through a declared outcome: no Router.navigate / navigateByUrl calls and no raw routerLink in templates.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      navigate:
        "Navigate through a declared outcome, not Router.{{method}}: declare it with outcomes('<interaction>', { <name>: exit('<route path>') }) from @qits/angular and call .go(params).",
      routerLink:
        'A raw routerLink{{where}} is a navigation no outcome declares: use <a [qitsExit]="outcomes.<name>" [exitParams]="{…}"> (or .go() from a click) with outcomes()/exit() from @qits/angular.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const absolute = context.physicalFilename ?? context.filename;
    if (isSpec(absolute)) return {};
    const pkg = nearestPackage(absolute);
    const root = pkg?.dir ?? context.cwd;
    const file = relative(root, absolute).split(sep).join('/');
    const include = (options.include ?? DEFAULT_INCLUDE).map(globRegex);
    const exclude = (options.exclude ?? DEFAULT_EXCLUDE).map(globRegex);
    if (!include.some((g) => g.test(file)) || exclude.some((g) => g.test(file))) return {};

    const { sourceCode } = context;
    const routers = new Set();
    const injects = new Set();

    const isInjectRouter = (node) => {
      node = unwrap(node);
      return (
        node?.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        injects.has(node.callee.name) &&
        node.arguments[0]?.type === 'Identifier' &&
        routers.has(node.arguments[0].name)
      );
    };
    const isRouterType = (annotation) => {
      const type = annotation?.typeAnnotation;
      return (
        type?.type === 'TSTypeReference' &&
        type.typeName.type === 'Identifier' &&
        routers.has(type.typeName.name)
      );
    };

    /** Whether `this.<name>` in `node`'s class is a Router. */
    const isRouterField = (node, name) => {
      let body = node.parent;
      while (body && body.type !== 'ClassBody') body = body.parent;
      if (!body) return false;
      return body.body.some((member) => {
        if (member.type === 'PropertyDefinition' && keyName(member) === name)
          return isInjectRouter(member.value) || isRouterType(member.typeAnnotation);
        if (member.type !== 'MethodDefinition' || member.kind !== 'constructor') return false;
        return member.value.params.some(
          (p) =>
            p.type === 'TSParameterProperty' &&
            p.parameter.type === 'Identifier' &&
            p.parameter.name === name &&
            isRouterType(p.parameter.typeAnnotation),
        );
      });
    };

    /** Whether an identifier names a parameter or variable that holds a Router. */
    const isRouterVariable = (node) => {
      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (!variable) continue;
        return variable.defs.some((def) => {
          if (def.type === 'Variable')
            return isRouterType(def.name.typeAnnotation) || isInjectRouter(def.node.init);
          if (def.type === 'Parameter') return isRouterType(def.name.typeAnnotation);
          return false;
        });
      }
      return false;
    };

    const isRouterRef = (node, at) => {
      node = unwrap(node);
      if (isInjectRouter(node)) return true;
      if (node.type === 'Identifier') return isRouterVariable(node);
      if (node.type === 'MemberExpression' && node.object.type === 'ThisExpression') {
        const name =
          node.property.type === 'PrivateIdentifier' ? `#${node.property.name}` : memberName(node);
        return name !== undefined && isRouterField(at, name);
      }
      return false;
    };

    const reportTemplate = (component) => {
      const decorator = component.decorators?.find((d) => {
        const callee = d.expression?.type === 'CallExpression' ? d.expression.callee : undefined;
        const name = callee?.type === 'MemberExpression' ? callee.property.name : callee?.name;
        return name === 'Component' && d.expression.arguments[0]?.type === 'ObjectExpression';
      });
      const meta = decorator?.expression.arguments[0];
      if (!meta) return;
      const inline = property(meta, 'template');
      const text = literalText(inline?.value);
      if (text !== undefined) {
        const literal = inline.value;
        const raw =
          literal.type === 'Literal' ? literal.raw.slice(1, -1) : literal.quasis[0].value.raw;
        const start = literal.range[0] + 1;
        for (const span of templateLinks(text, absolute)) {
          const loc =
            raw === text
              ? {
                  start: sourceCode.getLocFromIndex(start + span.start.offset),
                  end: sourceCode.getLocFromIndex(start + span.end.offset),
                }
              : undefined;
          context.report({ node: inline, loc, messageId: 'routerLink', data: { where: '' } });
        }
      }
      const external = property(meta, 'templateUrl');
      const url = literalText(external?.value);
      if (url !== undefined) {
        const html = resolve(dirname(absolute), url);
        let content;
        try {
          content = readFileSync(html, 'utf8');
        } catch {
          return; // the build reports a missing template
        }
        const name = relative(root, html).split(sep).join('/');
        for (const span of templateLinks(content, html)) {
          const where = ` (${name}:${span.start.line + 1}:${span.start.col + 1})`;
          context.report({ node: external, messageId: 'routerLink', data: { where } });
        }
      }
    };
    const component = (node) => {
      if (isComponentClass(node)) reportTemplate(node);
    };

    return {
      Program(program) {
        for (const node of program.body) {
          if (node.type !== 'ImportDeclaration') continue;
          const from = node.source.value;
          if (from !== '@angular/router' && from !== '@angular/core') continue;
          for (const s of node.specifiers) {
            if (s.type !== 'ImportSpecifier') continue;
            const imported = s.imported.name ?? s.imported.value;
            if (from === '@angular/router' && imported === 'Router') routers.add(s.local.name);
            if (from === '@angular/core' && imported === 'inject') injects.add(s.local.name);
          }
        }
      },
      ClassDeclaration: component,
      ClassExpression: component,
      CallExpression(node) {
        if (routers.size === 0) return;
        const callee = unwrap(node.callee);
        if (callee.type !== 'MemberExpression') return;
        const method = memberName(callee);
        if (!NAVIGATE.has(method) || !isRouterRef(callee.object, node)) return;
        if (method === 'navigate' && isLocalNavigate(node)) return;
        context.report({ node: callee.property, messageId: 'navigate', data: { method } });
      },
    };
  },
};
