import { nearestPackage } from '../project.mjs';

/** The roles a repository name ends in (`<component>[-<modifier>]-<role>[-<tech>]`). */
export const ROLES = ['service', 'frontend', 'app', 'daemon', 'oci', 'cli', 'javalib', 'jslib'];

const REPOSITORY = new RegExp(`^[a-z0-9]+(-[a-z0-9]+)*-(${ROLES.join('|')})$`);
const PACT_CLASSES = new Set(['PactV4', 'PactV3', 'Pact']);

/** The string a node stands for: a literal, a plain template, or a const holding one. */
function stringValue(node, context) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') {
    return stringValue(node.expression, context);
  }
  if (node.type === 'Identifier') {
    for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
      const variable = scope.set.get(node.name);
      if (!variable) continue;
      const def = variable.defs[0];
      if (def?.type === 'Variable' && def.parent.kind === 'const') {
        return stringValue(def.node.init, context);
      }
      return undefined;
    }
  }
  return undefined;
}

const property = (object, name) =>
  object?.type === 'ObjectExpression'
    ? object.properties.find(
        (p) =>
          p.type === 'Property' &&
          ((p.key.type === 'Identifier' && p.key.name === name) || p.key.value === name),
      )
    : undefined;

const calleeName = (callee) =>
  callee.type === 'Identifier'
    ? callee.name
    : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
      ? callee.property.name
      : undefined;

/**
 * In a `*.pact.spec.ts`, pacts name both sides by full repository name: the consumer is this
 * project's package.json `name`, and the provider ends in a role (`qits-projects-service`, never
 * the bare `qits-projects`), so a component's frontend and backend stay distinct.
 *
 * Checked call sites: `new PactV4({ consumer, provider })` (and PactV3 / Pact), and
 * `addGoldenInteraction(pact, masters, { provider, trigger: { app } })` from `@qits/angular/testing`,
 * where `trigger.app` is this project too.
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Pacts name consumer and provider by full repository name.' },
    schema: [],
    messages: {
      consumer:
        "The pact consumer is '{{value}}', but this project is '{{name}}' (package.json name).",
      provider:
        "The pact provider '{{value}}' is not a full repository name: it must end in -{{roles}}.",
      unresolved:
        'The pact {{field}} cannot be checked: give it as a string literal or a const holding one.',
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (!/\.pact\.spec\.[mc]?[jt]sx?$/.test(file)) return {};
    const name = nearestPackage(file)?.name;

    const check = (prop, field) => {
      if (!prop) return;
      const value = stringValue(prop.value, context);
      if (value === undefined) {
        context.report({ node: prop.value, messageId: 'unresolved', data: { field } });
      } else if (field === 'provider' && !REPOSITORY.test(value)) {
        context.report({
          node: prop.value,
          messageId: 'provider',
          data: { value, roles: ROLES.join('|-') },
        });
      } else if (field !== 'provider' && name && value !== name) {
        context.report({ node: prop.value, messageId: 'consumer', data: { value, name } });
      }
    };

    return {
      NewExpression(node) {
        if (!PACT_CLASSES.has(calleeName(node.callee))) return;
        check(property(node.arguments[0], 'consumer'), 'consumer');
        check(property(node.arguments[0], 'provider'), 'provider');
      },
      CallExpression(node) {
        if (calleeName(node.callee) !== 'addGoldenInteraction') return;
        const options = node.arguments[2];
        check(property(options, 'provider'), 'provider');
        check(property(property(options, 'trigger')?.value, 'app'), 'trigger app');
      },
    };
  },
};
