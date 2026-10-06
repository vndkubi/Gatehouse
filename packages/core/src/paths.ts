import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Root of all Gatehouse machine state (event store, mirrors, run workspaces). */
export function gatehouseHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GATEHOUSE_HOME;
  return override ? resolve(override) : join(homedir(), '.gatehouse');
}

export interface GatehousePaths {
  home: string;
  db: string;
  machineConfig: string;
  mirrors: string;
  runs: string;
  artifacts: string;
  secrets: string;
  keys: string;
}

export function gatehousePaths(home: string = gatehouseHome()): GatehousePaths {
  return {
    home,
    db: join(home, 'gatehouse.db'),
    machineConfig: join(home, 'config.local.yaml'),
    mirrors: join(home, 'mirrors'),
    runs: join(home, 'runs'),
    artifacts: join(home, 'artifacts'),
    secrets: join(home, 'secrets'),
    keys: join(home, 'keys'),
  };
}
