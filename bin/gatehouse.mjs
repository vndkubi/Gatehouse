#!/usr/bin/env node
// Entry shim: runs the TypeScript CLI through tsx without a build step.
import { register } from 'tsx/esm/api';

// node:sqlite is still flagged experimental on Node 22; the warning is noise for CLI users.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...args);
};

register();
const { main } = await import('../packages/cli/src/main.ts');
process.exitCode = await main(process.argv.slice(2));
