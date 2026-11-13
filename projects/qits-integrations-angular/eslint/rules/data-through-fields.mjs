import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  ASTWithSource,
  BindingPipe,
  BindingType,
  Binary,
  Call,
  ImplicitReceiver,
  Interpolation,
  KeyedRead,
  LiteralArray,
  LiteralMap,
  LiteralPrimitive,
  NonNullAssert,
  ParenthesizedExpression,
  PropertyRead,
  SafeCall,
  SafeKeyedRead,
  SafePropertyRead,
  ThisReceiver,
  TmplAstBoundText,
  TmplAstComponent,
  TmplAstElement,
  TmplAstForLoopBlock,
  TmplAstIfBlock,
  TmplAstLetDeclaration,
  TmplAstTemplate,
  parseTemplate,
} from '@angular/compiler';
import {
  CLIENTS_SCHEMA,
  DEFAULT_CLIENTS,
  clientMatcher,
  clientMatcherFor,
  isComponentClass,
  isSpec,
  literalText,
  memberName,
  nearestPackage,
  property,
  unwrap,
} from '../project.mjs';

/** The tag prefixes whose inputs show what they are given, unless the rule is told otherwise. */
export const DEFAULT_DISPLAY = ['ui-'];

/** The bindings that show their value as an element's content. */
const CONTENT = new Set(['textContent', 'innerText', 'innerHTML']);

/** The marks' own inputs (and the bindings that style rather than show): never a render. */
const NOT_SHOWN = new Set([
  'qitsEntityList',
  'qitsEntity',
  'entityKey',
  'entitySource',
  'fieldOf',
  'qitsField',
  'class',
  'className',
  'ngClass',
  'style',
  'ngStyle',
]);

/** `computed(() => …)` and `linkedSignal(() => …)`: a field whose value is its body's. */
const DERIVING = new Set(['computed', 'linkedSignal']);

/** The signal functions that declare a component input. */
const INPUTS = new Set(['input', 'model']);

/*
 * What an expression evaluates to, in both the template and a `computed` body:
 *
 * - `undefined`: static, it reads no root;
 * - `{ path: [...] }`: a plain path, the keys read after the nearest entity root;
 * - `{ reads: Set }`: derived, with the field paths it reads (a read of a whole entity adds none);
 * - `{ field }`: a class field not yet called (a signal), which shows nothing by itself;
 * - `{ value: field }`: a resource's `value` not yet called;
 * - `{ receiver: 'implicit' | 'this' }`: the template's own receiver.
 */
const isData = (v) => v !== undefined && (v.path !== undefined || v.reads !== undefined);
const pathText = (v) => v.path.join('.');

/**
 * Derived data from several values: the union of what each reads, or static when none is data.
 * A trailing `.length` reads the value it is the length of: a count is computed, not a field.
 */
function derived(values) {
  const reads = new Set();
  let data = false;
  for (const v of values) {
    if (!isData(v)) continue;
    data = true;
    if (v.reads) for (const read of v.reads) reads.add(read);
    else if (v.path.length) reads.add(pathText(v));
  }
  return data ? { reads } : undefined;
}

/** A plain path one key further, `.length` read as derived. */
function step(value, key) {
  if (key === 'length') return derived([value]);
  return { path: [...value.path, key] };
}

/** `?? 'x'`, `|| 0`, `?? []`: a fallback that keeps a plain path plain. */
const isTemplateFallback = (node) =>
  node instanceof LiteralPrimitive ||
  (node instanceof LiteralArray && node.expressions.length === 0);
const isCodeFallback = (node) =>
  (node?.type === 'Literal' && !node.regex) ||
  (node?.type === 'ArrayExpression' && node.elements.length === 0);

/** A class member's key as `x` / `#x`, or undefined when it is computed. */
function keyName(member) {
  if (member.computed) return undefined;
  if (member.key.type === 'PrivateIdentifier') return `#${member.key.name}`;
  return member.key.name ?? member.key.value;
}

/** A call's callee as `name` / `name.member` (`input.required`), or undefined. */
function calleeName(call) {
  const callee = unwrap(call?.callee);
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && callee.object.type === 'Identifier')
    return `${callee.object.name}.${memberName(callee)}`;
  return undefined;
}

/** What a `qitsField` mark says: `{ path }`, `{ derived: [...] }`, `{ dynamic: true }`, or undefined. */
function fieldMark(element) {
  const text = element.attributes.find((a) => a.name === 'qitsField');
  if (text) return { path: text.value, span: text.sourceSpan };
  const bound = element.inputs.find(
    (a) => a.name === 'qitsField' && a.type === BindingType.Property,
  );
  if (!bound) return undefined;
  let ast = bound.value instanceof ASTWithSource ? bound.value.ast : bound.value;
  while (ast instanceof ParenthesizedExpression) ast = ast.expression;
  const span = bound.sourceSpan;
  if (ast instanceof LiteralPrimitive && typeof ast.value === 'string')
    return { path: ast.value, span };
  if (ast instanceof LiteralMap && ast.keys.length === 1 && ast.keys[0].key === 'derived') {
    const list = ast.values[0];
    const paths = list instanceof LiteralArray ? list.expressions : [];
    const literal = (e) => e instanceof LiteralPrimitive && typeof e.value === 'string';
    if (list instanceof LiteralArray && paths.every(literal))
      return { derived: new Set(paths.map((e) => e.value)), span };
  }
  return { dynamic: true, span };
}

/** Whether an element carries `qitsEntity` or `qitsEntityList`, static or bound. */
const marksEntity = (element) =>
  [...element.attributes, ...element.inputs].some(
    (a) => a.name === 'qitsEntity' || a.name === 'qitsEntityList',
  );

/**
 * Every field of what a page shows names the entity and the field it comes from (ticket qits-2142):
 * the UI builder reads the data marks (`QitsEntityList`, `QitsEntity`, `QitsField` from
 * `@qits/angular`) out of a frozen page, and whatever no mark covers is read as static copy. A
 * component's template (the inline `template`, or the `templateUrl` file read from disk) is parsed
 * with `@angular/compiler` and its API data traced from two roots:
 *
 * - a class field initialised with `qitsResource(...)` (option `resource`): `x.value()` is the
 *   root value, its entity paths read after it;
 * - an `input<T>()` / `input.required<T>()` / `model<T>()` field whose `T` is an API type — the
 *   type, a union member, an array element or a type argument (of its alias too, so `Consumed<Agent,
 *   [...]>` counts) declared in a file under the `clients` globs. This takes the TypeScript type
 *   checker, so without typed linting the rule says so once per component class instead of passing.
 *
 * A plain path is a root followed only by property reads (`?.`, `!`, `['x']` included), ending in
 * a literal or empty-array fallback at most; its field path is the dot path after the entity root
 * (the root value, an `@for` item, a `@let` / `@if (…; as x)` alias of either, or a local an
 * element marks `[qitsEntity]`, such as a joined record). A class field
 * `computed(() => <plain path>)` (or `linkedSignal`) is an alias of that path; any other value
 * computed from a root — a pipe, a call, an operator, a template literal, a ternary, a `.length`, a
 * `computed` doing more — is derived, with the field paths it reads. Stores and helper bodies are
 * not followed.
 *
 * Interpolations, `[textContent]` / `[innerText]` / `[innerHTML]`, and every input of an element
 * whose tag starts with an option `display` prefix (default `ui-`) render; class, style, `attr.*`
 * and the marks' own inputs do not, nor do control-flow conditions. Reported: rendered data with
 * no `qitsField` at or above it (`unmarked`); a `qitsField` with no `qitsEntity` /
 * `qitsEntityList` at or above it in the same template (`noEntity`); derived data under a plain
 * path mark (`notDerived`); a plain path under a literal mark naming another path (`wrongField`);
 * and a read a literal `{ derived: [...] }` mark leaves out (`missingDerived`). A bound,
 * non-literal mark is trusted for the last two.
 *
 * An app turns it on route by route with a `files` glob, so it is not in `recommended`. Specs and
 * the generated clients are not read.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'API data a component renders sits under a qitsField that names the field it shows (or the fields it is derived from), inside a qitsEntity or qitsEntityList.',
    },
    schema: [
      {
        ...CLIENTS_SCHEMA,
        properties: {
          ...CLIENTS_SCHEMA.properties,
          resource: { type: 'string', minLength: 1 },
          display: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
    ],
    messages: {
      unmarked:
        '\'{{expression}}\'{{where}} renders API data outside any qitsField: mark the element that shows it with [fieldOf]="<entity>" qitsField="<path>" (or [qitsField]="{ derived: [...] }"), or the builder reads it as static copy.',
      noEntity:
        'qitsField{{where}} has no qitsEntity or qitsEntityList at or above it in this template: mark the element that shows the entity the field belongs to.',
      notDerived:
        '\'{{expression}}\'{{where}} is computed from API data, not shown as is: mark it [qitsField]="{ derived: [{{paths}}] }" rather than with a field path.',
      wrongField:
        "'{{expression}}'{{where}} shows '{{path}}', but the qitsField it sits under names '{{mark}}'.",
      missingDerived:
        "'{{expression}}'{{where}} reads {{missing}}, which the derived qitsField it sits under does not list.",
      typedLinting:
        'data-through-fields needs typed linting: set languageOptions.parserOptions.projectService',
    },
  },
  create(context) {
    const absolute = context.physicalFilename ?? context.filename;
    if (isSpec(absolute) || clientMatcher(context).inClients) return {};
    const options = context.options[0] ?? {};
    const clients = options.clients ?? DEFAULT_CLIENTS;
    const resourceName = options.resource ?? 'qitsResource';
    const display = options.display ?? DEFAULT_DISPLAY;
    const { sourceCode } = context;
    const root = nearestPackage(absolute)?.dir ?? context.cwd;
    const services = sourceCode.parserServices;
    const checker = services?.program?.getTypeChecker();
    const toTs = services?.esTreeNodeToTSNodeMap;

    const apiFiles = new Map();
    /** Whether a declaration's file lies under the clients globs. */
    const inApi = (file) => {
      if (!apiFiles.has(file))
        apiFiles.set(file, clientMatcherFor(file, clients, context.cwd).inClients);
      return apiFiles.get(file);
    };

    /** Whether a type is, holds as a union member / element / type argument, an API type. */
    const isApiType = (type, seen = new Set()) => {
      if (!type || seen.has(type)) return false;
      seen.add(type);
      for (const symbol of [type.aliasSymbol, type.getSymbol?.()]) {
        if (symbol?.declarations?.some((d) => inApi(d.getSourceFile().fileName))) return true;
      }
      const inner = [...(type.aliasTypeArguments ?? [])];
      if (type.isUnionOrIntersection?.()) inner.push(...type.types);
      if (type.target) inner.push(...checker.getTypeArguments(type));
      return inner.some((t) => isApiType(t, seen));
    };

    /** Whether an `input<T>()` field's `T` is an API type. */
    const isApiInput = (field) => {
      const typeArgument = (field.value.typeArguments ?? field.value.typeParameters)?.params[0];
      const node = typeArgument && toTs.get(typeArgument);
      if (node) return isApiType(checker.getTypeFromTypeNode(node));
      const name = toTs.get(field)?.name;
      const signal = name && checker.getTypeAtLocation(name);
      return isApiType(signal?.getCallSignatures()[0]?.getReturnType());
    };

    /** The fields of a component class that hold, or compute from, API data. */
    const classFields = (body, typed) => {
      const fields = new Map();
      for (const member of body.body) {
        if (member.type !== 'PropertyDefinition' || member.static) continue;
        const name = keyName(member);
        const init = unwrap(member.value);
        if (name === undefined || init?.type !== 'CallExpression') continue;
        const callee = calleeName(init);
        if (callee === resourceName) fields.set(name, { kind: 'resource' });
        else if (DERIVING.has(callee)) fields.set(name, { kind: 'computed', init });
        else if (typed && INPUTS.has(callee?.split('.')[0]) && isApiInput(member))
          fields.set(name, { kind: 'input' });
      }
      return fields;
    };

    /** A `computed` body's value, as the template sees `name()`; a cycle reads as static. */
    const computedValue = (fields, field) => {
      if ('value' in field) return field.value;
      field.value = undefined;
      const fn = field.init.arguments[0];
      let body;
      if (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') {
        body = fn.body;
        const only = body.type === 'BlockStatement' && body.body.length === 1 ? body.body[0] : null;
        if (only?.type === 'ReturnStatement') body = only.argument;
      } else body = fn;
      const value = body ? code(fields, body) : undefined;
      field.value = value?.path !== undefined || value === undefined ? value : derived([value]);
      return field.value;
    };

    /** A called field (`x()`): an API input's root, a computed's value; anything else static. */
    const called = (fields, target) => {
      if (target?.value) return { path: [] };
      if (!target?.field) return undefined;
      if (target.field.kind === 'input') return { path: [] };
      if (target.field.kind === 'computed') return computedValue(fields, target.field);
      return undefined;
    };

    /** A `this.x` read in class code. */
    const thisField = (fields, node) => {
      if (node.object.type !== 'ThisExpression') return undefined;
      const name =
        node.property.type === 'PrivateIdentifier' ? `#${node.property.name}` : memberName(node);
      const field = fields.get(name);
      return field ? { field } : undefined;
    };

    /** What an ESTree expression in a class field (a `computed` body) evaluates to. */
    const code = (fields, node) => {
      node = unwrap(node);
      if (node?.type === 'ChainExpression') return code(fields, node.expression);
      if (!node || typeof node.type !== 'string') return undefined;
      if (node.type === 'MemberExpression') {
        const own = thisField(fields, node);
        if (own) return own;
        const object = code(fields, node.object);
        const key = memberName(node);
        if (object?.field?.kind === 'resource' && key === 'value') return { value: object.field };
        if (object?.path && key !== undefined) return step(object, key);
        return derived([object, node.computed ? code(fields, node.property) : undefined]);
      }
      if (node.type === 'CallExpression') {
        const callee = unwrap(node.callee);
        const inner = callee?.type === 'ChainExpression' ? unwrap(callee.expression) : callee;
        if (node.arguments.length === 0) {
          const target = code(fields, inner);
          if (target?.field || target?.value) return called(fields, target);
        }
        const receiver = inner?.type === 'MemberExpression' ? inner.object : inner;
        return derived([code(fields, receiver), ...node.arguments.map((a) => code(fields, a))]);
      }
      if (node.type === 'LogicalExpression' && node.operator !== '&&') {
        const left = code(fields, node.left);
        if (left?.path && isCodeFallback(unwrap(node.right))) return left;
        return derived([left, code(fields, node.right)]);
      }
      const values = [];
      for (const key of sourceCode.visitorKeys[node.type] ?? []) {
        for (const child of [node[key]].flat()) if (child) values.push(code(fields, child));
      }
      return derived(values);
    };

    /** What a template expression evaluates to, in a scope of template locals. */
    const expression = (fields, scope, ast) => {
      const at = (child) => expression(fields, scope, child);
      if (ast instanceof ASTWithSource) return at(ast.ast);
      if (ast instanceof ImplicitReceiver && !(ast instanceof ThisReceiver))
        return { receiver: 'implicit' };
      if (ast instanceof ThisReceiver) return { receiver: 'this' };
      if (ast instanceof ParenthesizedExpression || ast instanceof NonNullAssert)
        return at(ast.expression);
      if (ast instanceof PropertyRead || ast instanceof SafePropertyRead) {
        const object = at(ast.receiver);
        if (object?.receiver) {
          if (object.receiver === 'implicit' && scope.has(ast.name)) return scope.get(ast.name);
          const field = fields.get(ast.name);
          return field ? { field } : undefined;
        }
        if (object?.field?.kind === 'resource' && ast.name === 'value')
          return { value: object.field };
        if (object?.path) return step(object, ast.name);
        return derived([object]);
      }
      if (ast instanceof KeyedRead || ast instanceof SafeKeyedRead) {
        const object = at(ast.receiver);
        if (
          object?.path &&
          ast.key instanceof LiteralPrimitive &&
          typeof ast.key.value === 'string'
        )
          return step(object, ast.key.value);
        return derived([object, at(ast.key)]);
      }
      if (ast instanceof Call || ast instanceof SafeCall) {
        if (ast.args.length === 0) {
          const target = at(ast.receiver);
          if (target?.field || target?.value) return called(fields, target);
        }
        const method =
          ast.receiver instanceof PropertyRead || ast.receiver instanceof SafePropertyRead;
        const receiver = method ? at(ast.receiver.receiver) : at(ast.receiver);
        return derived([receiver, ...ast.args.map(at)]);
      }
      if (ast instanceof Binary && (ast.operation === '??' || ast.operation === '||')) {
        const left = at(ast.left);
        if (left?.path && isTemplateFallback(ast.right)) return left;
        return derived([left, at(ast.right)]);
      }
      if (ast instanceof Interpolation) {
        const values = ast.expressions.map(at);
        const bare = values.length === 1 && ast.strings.every((s) => s.trim() === '');
        return bare ? values[0] : derived(values);
      }
      if (ast instanceof BindingPipe) return derived([at(ast.exp), ...ast.args.map(at)]);
      // Anything else (an operator, a ternary, a template literal, a literal, `typeof`, `!`): the
      // union of what its parts read.
      const values = [];
      for (const [key, child] of Object.entries(ast ?? {})) {
        if (key === 'span' || key === 'sourceSpan' || key === 'nameSpan') continue;
        for (const part of [child].flat()) {
          if (part && typeof part === 'object' && typeof part.visit === 'function')
            values.push(at(part));
        }
      }
      return derived(values);
    };

    /**
     * Every finding in one template's text, as `{ start, end, messageId, data }` with offsets into
     * that text; none when it does not parse.
     */
    const findings = (fields, text, url) => {
      let nodes;
      try {
        nodes = parseTemplate(text, url, { preserveWhitespaces: true }).nodes;
      } catch {
        return [];
      }
      const found = [];
      const report = (span, messageId, data = {}) =>
        found.push({ start: span.start, end: span.end, messageId, data });
      const offsets = (span) =>
        span.start?.offset === undefined
          ? span
          : { start: span.start.offset, end: span.end.offset };
      const source = (span) => text.slice(span.start, span.end).trim();
      const quoted = (paths) => [...paths].map((p) => `'${p}'`).join(', ');

      /** One rendered value under the nearest mark. */
      const rendered = (value, span, mark) => {
        if (!isData(value)) return;
        span = offsets(span);
        const data = { expression: source(span) };
        if (!mark) return report(span, 'unmarked', data);
        if (mark.dynamic) return;
        const reads = value.reads ?? new Set(value.path.length ? [pathText(value)] : []);
        if (mark.path !== undefined) {
          if (value.reads) return report(span, 'notDerived', { ...data, paths: quoted(reads) });
          // The entity itself has no field path for a literal mark to name.
          if (value.path.length && pathText(value) !== mark.path)
            report(span, 'wrongField', { ...data, path: pathText(value), mark: mark.path });
          return;
        }
        const missing = [...reads].filter((p) => !mark.derived.has(p));
        if (missing.length) report(span, 'missingDerived', { ...data, missing: quoted(missing) });
      };

      /**
       * The scope inside an element whose `[qitsEntity]` is a template local holding API data: the
       * mark makes that local an entity root there, so a joined record (`@if (hosted(slot); as
       * host)`, then `[qitsEntity]="host"`) shows its fields as plain paths, relative to it.
       */
      const entityScope = (element, scope) => {
        const bound = element.inputs.find((a) => a.name === 'qitsEntity');
        let ast = bound?.value instanceof ASTWithSource ? bound.value.ast : bound?.value;
        while (ast instanceof ParenthesizedExpression || ast instanceof NonNullAssert)
          ast = ast.expression;
        const local =
          ast instanceof PropertyRead &&
          ast.receiver instanceof ImplicitReceiver &&
          !(ast.receiver instanceof ThisReceiver) &&
          scope.has(ast.name) &&
          isData(scope.get(ast.name));
        if (!local) return scope;
        return new Map(scope).set(ast.name, { path: [] });
      };

      const visit = (list, scope, mark, entity) => {
        scope = new Map(scope);
        for (const node of list ?? []) {
          if (node instanceof TmplAstLetDeclaration) {
            scope.set(node.name, expression(fields, scope, node.value));
          } else if (node instanceof TmplAstBoundText) {
            const ast = node.value instanceof ASTWithSource ? node.value.ast : node.value;
            for (const part of ast instanceof Interpolation ? ast.expressions : [ast])
              rendered(expression(fields, scope, part), part.sourceSpan, mark);
          } else if (node instanceof TmplAstElement || node instanceof TmplAstComponent) {
            const own = fieldMark(node);
            const hasEntity = entity || marksEntity(node);
            if (own && !hasEntity) report(offsets(own.span), 'noEntity');
            const near = own ?? mark;
            const tag = node.name ?? node.tagName ?? '';
            const shows = display.some((prefix) => tag.startsWith(prefix));
            const inner = entityScope(node, scope);
            for (const input of node.inputs) {
              if (input.type !== BindingType.Property && input.type !== BindingType.TwoWay)
                continue;
              if (NOT_SHOWN.has(input.name)) continue;
              if (!shows && !CONTENT.has(input.name)) continue;
              rendered(expression(fields, inner, input.value), input.sourceSpan, near);
            }
            visit(node.children, inner, near, hasEntity);
          } else if (node instanceof TmplAstTemplate) {
            // `<ng-template let-x>` and a structural directive's wrapper: its variables are unknown.
            const inner = new Map(scope);
            for (const variable of node.variables) inner.set(variable.name, undefined);
            visit(node.children, inner, mark, entity);
          } else if (node instanceof TmplAstForLoopBlock) {
            const items = expression(fields, scope, node.expression);
            const inner = new Map(scope);
            // An item of a list of API data is an entity of its own, filtered or sorted or not.
            inner.set(node.item.name, isData(items) ? { path: [] } : undefined);
            for (const variable of node.contextVariables) inner.set(variable.name, undefined);
            visit(node.children, inner, mark, entity);
            visit(node.empty?.children, scope, mark, entity);
          } else if (node instanceof TmplAstIfBlock) {
            for (const branch of node.branches) {
              const inner = new Map(scope);
              if (branch.expressionAlias && branch.expression)
                inner.set(
                  branch.expressionAlias.name,
                  expression(fields, scope, branch.expression),
                );
              visit(branch.children, inner, mark, entity);
            }
          } else {
            // @switch, @defer and the rest: their content in the same scope.
            visit(node.children, scope, mark, entity);
            for (const group of node.groups ?? []) visit(group.children, scope, mark, entity);
            for (const key of ['placeholder', 'loading', 'error'])
              visit(node[key]?.children, scope, mark, entity);
          }
        }
      };
      visit(nodes, new Map(), undefined, false);
      return found;
    };

    /** The `@Component({...})` argument of a class, or undefined. */
    const componentMeta = (node) => {
      for (const d of node.decorators ?? []) {
        const arg = d.expression?.type === 'CallExpression' ? d.expression.arguments[0] : undefined;
        if (arg?.type === 'ObjectExpression') return arg;
      }
      return undefined;
    };

    const component = (node) => {
      if (!isComponentClass(node)) return;
      const typed = Boolean(checker && toTs);
      if (!typed) context.report({ node: node.id ?? node, messageId: 'typedLinting' });
      const meta = componentMeta(node);
      if (!meta) return;
      const fields = classFields(node.body, typed);

      const inline = property(meta, 'template');
      const text = literalText(inline?.value);
      if (text !== undefined) {
        const literal = inline.value;
        const raw =
          literal.type === 'Literal' ? literal.raw.slice(1, -1) : literal.quasis[0].value.raw;
        const start = literal.range[0] + 1;
        for (const f of findings(fields, text, absolute)) {
          const loc =
            raw === text
              ? {
                  start: sourceCode.getLocFromIndex(start + f.start),
                  end: sourceCode.getLocFromIndex(start + f.end),
                }
              : undefined;
          context.report({
            node: inline,
            loc,
            messageId: f.messageId,
            data: { ...f.data, where: '' },
          });
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
        for (const f of findings(fields, content, html)) {
          const before = content.slice(0, f.start).split('\n');
          const where = ` (${name}:${before.length}:${before.at(-1).length + 1})`;
          context.report({
            node: external,
            messageId: f.messageId,
            data: { ...f.data, where },
          });
        }
      }
    };

    return { ClassDeclaration: component, ClassExpression: component };
  },
};
