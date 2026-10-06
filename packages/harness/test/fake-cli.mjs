// Stand-in for copilot/codex in tests. Reports what it saw as JSON so tests can assert isolation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
// Env is scrubbed by the adapter (as it should be), so the test passes its mode via a file.
const modeFile = join(process.cwd(), '.gatehouse', 'fake-mode');
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok';
const report = {
  answer: 'pong',
  sawGithubToken: Boolean(process.env.GITHUB_TOKEN),
  providerKeyPrefix: (process.env.COPILOT_PROVIDER_API_KEY ?? '').slice(0, 4),
  offline: process.env.COPILOT_OFFLINE ?? '',
  tools: args.find((a) => a.startsWith('--available-tools=')) ?? '',
  hasAuthCopy: process.env.CODEX_HOME ? existsSync(join(process.env.CODEX_HOME, 'auth.json')) : false,
};

if (args[0] === 'exec') {
  // codex: prompt on stdin, answer to the -o file
  const stdin = readFileSync(0, 'utf8');
  report.promptHasContract = stdin.includes('Output contract');
  writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(report));
} else {
  const counter = join(process.cwd(), '.gatehouse', 'calls');
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
  writeFileSync(counter, String(n));
  if (mode === 'invalid-first' && n === 1) process.stdout.write('Sure! Here is the answer: {"answer": 42}');
  else process.stdout.write('```json\n' + JSON.stringify(report) + '\n```\n');
}
