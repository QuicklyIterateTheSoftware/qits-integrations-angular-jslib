#!/usr/bin/env node
// qits-angular: the command-line tools of @qits/angular.
import { pwa } from '../pwa/cli.mjs';
import { screenshots } from '../screenshots/cli.mjs';

const COMMANDS = { pwa, screenshots };
const [command, ...args] = process.argv.slice(2);

if (!Object.hasOwn(COMMANDS, command ?? '')) {
  console.error(
    'Usage: qits-angular <command> [options]\n\nCommands:\n' +
      '  pwa          write the web manifest, check an installable offline build (--help)\n' +
      '  screenshots  find reference screenshots no test uses, and outcome gaps (--help)',
  );
  process.exitCode = command === '--help' || command === '-h' ? 0 : 2;
} else {
  // A command answers its exit code, or a promise of it (pwa --check drives a browser).
  process.exitCode = await COMMANDS[command](args);
}
