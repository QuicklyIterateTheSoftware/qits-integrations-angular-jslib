/**
 * @qits/angular/eslint: the qits rules for Angular apps, as an ESLint flat-config plugin.
 *
 *   import qits from '@qits/angular/eslint';
 *   export default [...yourConfig, ...qits.configs.recommended];
 *
 * The rules read TypeScript, so the app's config must already parse `.ts` (typescript-eslint or
 * angular-eslint does).
 */
import clientOnlyInStores from './rules/client-only-in-stores.mjs';
import pactNames from './rules/pact-names.mjs';
import storeHasPact from './rules/store-has-pact.mjs';

const plugin = {
  meta: { name: '@qits/angular/eslint' },
  rules: {
    'client-only-in-stores': clientOnlyInStores,
    'store-has-pact': storeHasPact,
    'pact-names': pactNames,
  },
  configs: {},
};

plugin.configs.recommended = [
  {
    name: 'qits/recommended',
    files: ['**/*.ts'],
    plugins: { qits: plugin },
    rules: {
      'qits/client-only-in-stores': 'error',
      'qits/store-has-pact': 'error',
      'qits/pact-names': 'error',
    },
  },
];

export default plugin;
