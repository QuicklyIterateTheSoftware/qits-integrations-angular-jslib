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
import consumeClientCalls from './rules/consume-client-calls.mjs';
import pactNames from './rules/pact-names.mjs';
import pageHasScreenshots from './rules/page-has-screenshots.mjs';
import pageLocation from './rules/page-location.mjs';
import pageSuffix from './rules/page-suffix.mjs';
import routeMatchesDirectory from './rules/route-matches-directory.mjs';
import storeHasPact from './rules/store-has-pact.mjs';

const plugin = {
  meta: { name: '@qits/angular/eslint' },
  rules: {
    'client-only-in-stores': clientOnlyInStores,
    'consume-client-calls': consumeClientCalls,
    'store-has-pact': storeHasPact,
    'pact-names': pactNames,
    'page-location': pageLocation,
    'page-suffix': pageSuffix,
    'page-has-screenshots': pageHasScreenshots,
    'route-matches-directory': routeMatchesDirectory,
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
      'qits/consume-client-calls': 'error',
      'qits/store-has-pact': 'error',
      'qits/pact-names': 'error',
      'qits/page-location': 'error',
      'qits/page-suffix': 'error',
      'qits/page-has-screenshots': 'error',
      'qits/route-matches-directory': 'error',
    },
  },
];

export default plugin;
