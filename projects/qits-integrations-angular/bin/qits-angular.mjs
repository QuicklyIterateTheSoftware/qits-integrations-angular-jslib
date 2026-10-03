#!/usr/bin/env node
// qits-angular: the command-line tools of @qits/angular.
import { screenshots } from '../screenshots/cli.mjs';

const COMMANDS = { screenshots };
const [command, ...args] = process.argv.slice(2);

if (!Object.hasOwn(COMMANDS, command ?? '')) {
  console.error(
    'Usage: qits-angular <command> [options]\n\nCommands:\n' +
      '  screenshots  find reference screenshots no test uses (--help)',
  );
  process.exitCode = command === '--help' || command === '-h' ? 0 : 2;
} else {
  process.exitCode = COMMANDS[command](args);
}
