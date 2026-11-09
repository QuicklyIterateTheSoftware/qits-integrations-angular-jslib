/**
 * @qits/angular/eslint: the qits rules for Angular apps, as an ESLint flat-config plugin.
 *
 *   import qits from '@qits/angular/eslint';
 *   export default [...yourConfig, ...qits.configs.recommended];
 *
 * The rules read TypeScript, so the app's config must already parse `.ts` (typescript-eslint or
 * angular-eslint does).
 */
import browserSpecDataFromGoldenMasters from './rules/browser-spec-data-from-golden-masters.mjs';
import clientOnlyInStores from './rules/client-only-in-stores.mjs';
import consumeClientCalls from './rules/consume-client-calls.mjs';
import navigationThroughOutcomes from './rules/navigation-through-outcomes.mjs';
import pactNames from './rules/pact-names.mjs';
import pageHasScreenshots from './rules/page-has-screenshots.mjs';
import pageLocation from './rules/page-location.mjs';
import pageScreenshotsThroughRoutes from './rules/page-screenshots-through-routes.mjs';
import pageSuffix from './rules/page-suffix.mjs';
import routeMatchesDirectory from './rules/route-matches-directory.mjs';
import routePaths from './rules/route-paths.mjs';
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
    'page-screenshots-through-routes': pageScreenshotsThroughRoutes,
    'route-matches-directory': routeMatchesDirectory,
    'route-paths': routePaths,
    'navigation-through-outcomes': navigationThroughOutcomes,
    'browser-spec-data-from-golden-masters': browserSpecDataFromGoldenMasters,
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
      'qits/page-screenshots-through-routes': 'error',
      'qits/route-matches-directory': 'error',
      'qits/route-paths': 'error',
      // warn until the apps navigate through outcomes (qits-2005 turns it to error in the app)
      'qits/navigation-through-outcomes': 'warn',
      'qits/browser-spec-data-from-golden-masters': 'error',
    },
  },
];

export default plugin;
