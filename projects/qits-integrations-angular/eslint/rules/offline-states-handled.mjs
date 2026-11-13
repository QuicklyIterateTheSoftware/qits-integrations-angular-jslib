import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ASTWithSource,
  Binary,
  Call,
  ImplicitReceiver,
  LiteralPrimitive,
  NonNullAssert,
  ParenthesizedExpression,
  PropertyRead,
  SafeCall,
  SafePropertyRead,
  ThisReceiver,
  TmplAstSwitchBlock,
  parseTemplate,
} from '@angular/compiler';
import {
  isComponentClass,
  isSpec,
  literalText,
  memberName,
  property,
  unwrap,
} from '../project.mjs';

/** `computed(() => …)` and `linkedSignal(() => …)`: a field whose value the template reads. */
const DERIVING = new Set(['computed', 'linkedSignal']);

/** The comparisons that show a state. */
const COMPARE = new Set(['===', '!==', '==', '!=']);

/** The status signal each kind is compared through. */
const STATUS = { resource: 'qitsStatus', mutation: 'status' };

/** The reads that show a resource at all: a template reading none of them renders nothing of it. */
const RENDERS = ['value', 'hasValue', 'qitsStatus'];

/** A read that shows a state by itself: `cachedAt()` the stored value's time, `conflict()` the server's record. */
const SHOWS = { cachedAt: 'cached', conflict: 'conflict' };

/** Template keys that hold positions or i18n metadata, never an expression or a node. */
const skippedKey = (key) => /span$/i.test(key) || key === 'i18n' || key === 'location';

/** A class member's key as `x` / `#x`, or undefined when it is computed. */
function keyName(member) {
  if (member.computed) return undefined;
  if (member.key.type === 'PrivateIdentifier') return `#${member.key.name}`;
  return member.key.name ?? member.key.value;
}

/** A call's callee as a plain name: `qitsResource(...)` or `ns.qitsResource(...)`. */
function calleeName(call) {
  const callee = unwrap(call?.callee);
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression') return memberName(callee);
  return undefined;
}

/**
 * What a state needs, by the policy a resource or mutation declares (ticket qits-2150): the
 * offline states are reached only through the qits signals, so a template written the usual way
 * shows stale data as fresh, an empty page with no message when offline, a queued write as done
 * with nothing sent, and never the conflict the person has to resolve. For each field of a
 * component class initialised with `qitsResource(...)` (option `resource`) or `qitsMutation(...)`
 * (option `mutation`), only the states it can reach are required:
 *
 * - a resource with `offline: 'cache'` that the template renders (it reads `value()`, `hasValue()`
 *   or `qitsStatus()`): `cached` and `offline`;
 * - a mutation that is run (`.run(` on the field, in the template or anywhere in the class):
 *   `conflict`, which an `online-only` one reaches too (a direct send answered 412 under
 *   `provideQitsOffline`), plus `pending` when its policy is `queue`.
 *
 * A state is handled when the template compares the field's status signal (`qitsStatus()` for a
 * resource, `status()` for a mutation) with the state's string (`===`, `!==`, `==`, `!=`, or
 * `@case ('<state>')` under `@switch (<field>.<signal>())`), or calls a `computed` /
 * `linkedSignal` field of the same class whose body does (one level; a `switch` there counts too).
 * Reading `cachedAt()` also shows `cached`, and reading `conflict()` also shows `conflict`. A
 * resource rendered only through such a field counts as rendered. One report per missing state,
 * on the field's declaration.
 *
 * A resource without `offline: 'cache'` needs nothing. A field whose policy is not a string literal
 * (no options, a spread, a variable) is skipped: `offline-policy-declared` reports it. The template
 * is the inline `template`, or the `templateUrl` file read from disk, parsed with
 * `@angular/compiler`. It needs typed linting, as `data-through-fields` does; without it the rule
 * says so once per component class instead of passing. Specs are not read.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A component template shows every offline state its qitsResource and qitsMutation fields can reach: cached and offline for a cache resource, conflict (and pending when queued) for a mutation it runs.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          resource: { type: 'string', minLength: 1 },
          mutation: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unhandled: "'{{field}}' can be {{state}}, and the template never shows it",
      typedLinting:
        'offline-states-handled needs typed linting: set languageOptions.parserOptions.projectService',
    },
  },
  create(context) {
    const absolute = context.physicalFilename ?? context.filename;
    if (isSpec(absolute)) return {};
    const options = context.options[0] ?? {};
    const resourceName = options.resource ?? 'qitsResource';
    const mutationName = options.mutation ?? 'qitsMutation';
    const { sourceCode } = context;
    const services = sourceCode.parserServices;
    const typed = Boolean(services?.program?.getTypeChecker() && services?.esTreeNodeToTSNodeMap);

    /** The resource and mutation fields of a class, with their literal policy (or null). */
    const offlineFields = (body) => {
      const fields = new Map();
      for (const member of body.body) {
        if (member.type !== 'PropertyDefinition' || member.static) continue;
        const name = keyName(member);
        const init = unwrap(member.value);
        if (name === undefined || init?.type !== 'CallExpression') continue;
        const callee = calleeName(init);
        const kind =
          callee === resourceName ? 'resource' : callee === mutationName ? 'mutation' : undefined;
        if (!kind) continue;
        const arg = unwrap(init.arguments[kind === 'resource' ? 2 : 1]);
        const offline = arg?.type === 'ObjectExpression' ? property(arg, 'offline') : undefined;
        const policy = offline ? (literalText(offline.value) ?? null) : null;
        fields.set(name, { kind, member, policy });
      }
      return fields;
    };

    /** What a piece of code or a template shows: states compared per field, signals read per field. */
    const shown = () => ({ states: new Set(), reads: new Set(), calls: new Set() });
    const merge = (into, from) => {
      for (const key of ['states', 'reads', 'calls']) for (const v of from[key]) into[key].add(v);
    };

    // ----- class code (ESTree) -----

    /** `this.<field>.<member>(…)` (`?.` and `!` included): `{ field, member }`, or undefined. */
    const thisCall = (node) => {
      node = unwrap(node);
      if (node?.type === 'ChainExpression') node = unwrap(node.expression);
      if (node?.type !== 'CallExpression') return undefined;
      let callee = unwrap(node.callee);
      if (callee?.type === 'ChainExpression') callee = unwrap(callee.expression);
      if (callee?.type !== 'MemberExpression') return undefined;
      const object = unwrap(callee.object);
      if (object?.type !== 'MemberExpression' || unwrap(object.object)?.type !== 'ThisExpression')
        return undefined;
      const field =
        object.property.type === 'PrivateIdentifier'
          ? `#${object.property.name}`
          : memberName(object);
      const member = memberName(callee);
      return field !== undefined && member !== undefined ? { field, member } : undefined;
    };

    /** Every node of an ESTree subtree, depth first. */
    const walkCode = (node, visit) => {
      if (!node || typeof node.type !== 'string') return;
      visit(node);
      for (const key of sourceCode.visitorKeys[node.type] ?? []) {
        for (const child of [node[key]].flat()) walkCode(child, visit);
      }
    };

    /** What one piece of class code shows of the fields' states and signals. */
    const codeShows = (fields, root) => {
      const found = shown();
      const status = (call) =>
        call && fields.get(call.field) && STATUS[fields.get(call.field).kind] === call.member
          ? call.field
          : undefined;
      walkCode(root, (node) => {
        const call = thisCall(node);
        if (call) found.reads.add(`${call.field}.${call.member}`);
        if (node.type === 'BinaryExpression' && COMPARE.has(node.operator)) {
          for (const [a, b] of [
            [node.left, node.right],
            [node.right, node.left],
          ]) {
            const field = status(thisCall(a));
            const state = literalText(unwrap(b));
            if (field && state !== undefined) found.states.add(`${field}:${state}`);
          }
        }
        if (node.type === 'SwitchStatement') {
          const field = status(thisCall(node.discriminant));
          for (const c of field ? node.cases : []) {
            const state = literalText(unwrap(c.test));
            if (state !== undefined) found.states.add(`${field}:${state}`);
          }
        }
      });
      return found;
    };

    // ----- the template (@angular/compiler) -----

    const bare = (ast) => {
      for (;;) {
        if (ast instanceof ASTWithSource) ast = ast.ast;
        else if (ast instanceof ParenthesizedExpression || ast instanceof NonNullAssert)
          ast = ast.expression;
        else return ast;
      }
    };
    /** A field of the component read in the template (`x`, `this.x`): its name, or undefined. */
    const fieldRead = (ast) => {
      ast = bare(ast);
      if (!(ast instanceof PropertyRead || ast instanceof SafePropertyRead)) return undefined;
      const own = ast.receiver instanceof ImplicitReceiver || ast.receiver instanceof ThisReceiver;
      return own ? ast.name : undefined;
    };
    /** `<field>.<member>(…)`: `{ field, member }`, or undefined. */
    const templateCall = (ast) => {
      ast = bare(ast);
      if (!(ast instanceof Call || ast instanceof SafeCall)) return undefined;
      const callee = bare(ast.receiver);
      if (!(callee instanceof PropertyRead || callee instanceof SafePropertyRead)) return undefined;
      const field = fieldRead(callee.receiver);
      return field !== undefined ? { field, member: callee.name } : undefined;
    };
    const stringOf = (ast) => {
      ast = bare(ast);
      return ast instanceof LiteralPrimitive && typeof ast.value === 'string'
        ? ast.value
        : undefined;
    };

    /** What a template shows; undefined when it does not parse. */
    const templateShows = (fields, text, url) => {
      let nodes;
      try {
        const parsed = parseTemplate(text, url, { preserveWhitespaces: true });
        if (parsed.errors?.length) return undefined;
        nodes = parsed.nodes;
      } catch {
        return undefined;
      }
      const found = shown();
      const status = (call) =>
        call && fields.get(call.field) && STATUS[fields.get(call.field).kind] === call.member
          ? call.field
          : undefined;
      const seen = new Set();
      const walk = (value) => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (value instanceof Call || value instanceof SafeCall) {
          const call = templateCall(value);
          if (call) found.reads.add(`${call.field}.${call.member}`);
          const own = fieldRead(value.receiver);
          if (own !== undefined && value.args.length === 0) found.calls.add(own);
        }
        if (value instanceof Binary && COMPARE.has(value.operation)) {
          for (const [a, b] of [
            [value.left, value.right],
            [value.right, value.left],
          ]) {
            const field = status(templateCall(a));
            const state = stringOf(b);
            if (field && state !== undefined) found.states.add(`${field}:${state}`);
          }
        }
        if (value instanceof TmplAstSwitchBlock) {
          const field = status(templateCall(value.expression));
          const cases = [...(value.cases ?? []), ...(value.groups ?? []).flatMap((g) => g.cases)];
          for (const c of field ? cases : []) {
            const state = c.expression && stringOf(c.expression);
            if (state !== undefined) found.states.add(`${field}:${state}`);
          }
        }
        for (const [key, child] of Object.entries(value)) {
          if (!skippedKey(key)) walk(child);
        }
      };
      walk(nodes);
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

    /**
     * The component's template text and its URL; null when it has none, undefined when the rule
     * cannot read it (not a literal, or a missing file).
     */
    const templateOf = (meta) => {
      const inline = property(meta, 'template');
      if (inline) {
        const text = literalText(inline.value);
        return text === undefined ? undefined : { text, url: absolute };
      }
      const external = property(meta, 'templateUrl');
      if (!external) return null;
      const url = literalText(external.value);
      if (url === undefined) return undefined;
      const html = resolve(dirname(absolute), url);
      try {
        return { text: readFileSync(html, 'utf8'), url: html };
      } catch {
        return undefined; // the build reports a missing template
      }
    };

    const component = (node) => {
      if (!isComponentClass(node)) return;
      if (!typed) {
        context.report({ node: node.id ?? node, messageId: 'typedLinting' });
        return;
      }
      const fields = offlineFields(node.body);
      if (![...fields.values()].some((f) => f.policy !== null)) return;
      const meta = componentMeta(node);
      if (!meta) return;
      const template = templateOf(meta);
      if (template === undefined) return;
      const inTemplate = template ? templateShows(fields, template.text, template.url) : shown();
      if (!inTemplate) return;

      // One level of `computed` / `linkedSignal`: what the fields the template calls show.
      const view = shown();
      merge(view, inTemplate);
      for (const member of node.body.body) {
        if (member.type !== 'PropertyDefinition' || member.static) continue;
        const name = keyName(member);
        const init = unwrap(member.value);
        if (!inTemplate.calls.has(name) || init?.type !== 'CallExpression') continue;
        if (DERIVING.has(calleeName(init))) merge(view, codeShows(fields, init.arguments[0]));
      }
      // A run anywhere in the class code counts; what the class code compares does not show it.
      const runs = codeShows(fields, node.body).reads;

      for (const [name, field] of fields) {
        if (field.policy === null) continue;
        const reads = (member) => view.reads.has(`${name}.${member}`);
        let needs = [];
        if (field.kind === 'resource') {
          if (field.policy === 'cache' && RENDERS.some(reads)) needs = ['cached', 'offline'];
        } else if (reads('run') || runs.has(`${name}.run`)) {
          needs = field.policy === 'queue' ? ['pending', 'conflict'] : ['conflict'];
        }
        for (const state of needs) {
          const handled =
            view.states.has(`${name}:${state}`) ||
            Object.entries(SHOWS).some(([member, shows]) => shows === state && reads(member));
          if (!handled)
            context.report({
              node: field.member,
              messageId: 'unhandled',
              data: { field: name, state },
            });
        }
      }
    };

    return { ClassDeclaration: component, ClassExpression: component };
  },
};
