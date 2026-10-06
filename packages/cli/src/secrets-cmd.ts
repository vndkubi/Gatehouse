import { gatehousePaths, loadConfig } from '@gatehouse/core';
import { SecretStore } from '@gatehouse/secrets';

export function secretStore(): SecretStore {
  const { config } = loadConfig({ projectDir: process.cwd() });
  return new SecretStore(gatehousePaths(config.paths.home).secrets);
}

/** Reads the value from stdin (piped) or a no-echo prompt (TTY); never from argv. */
export async function secretSet(name: string): Promise<number> {
  const value = process.stdin.isTTY ? await promptHidden(`Value for ${name}: `) : (await readStdin()).replace(/\r?\n$/, '');
  if (!value) {
    process.stderr.write('error: empty value, nothing stored\n');
    return 1;
  }
  const store = secretStore();
  await store.set(name, value);
  process.stdout.write(`Stored ${name} (${store.backend}).\n`);
  return 0;
}

/** Moves a value you already have in an environment variable into the store without echoing it. */
export async function secretImportEnv(variable: string, name: string): Promise<number> {
  const value = process.env[variable];
  if (!value) {
    process.stderr.write(`error: ${variable} is not set in this shell\n`);
    return 1;
  }
  const store = secretStore();
  await store.set(name, value);
  process.stdout.write(`Stored ${name} from ${variable} (${store.backend}). You may now unset ${variable}.\n`);
  return 0;
}

export function secretList(): number {
  const store = secretStore();
  const names = store.list();
  process.stdout.write(names.length ? `${names.map((n) => `${n}  (set)`).join('\n')}\n` : 'No secrets stored.\n');
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}
