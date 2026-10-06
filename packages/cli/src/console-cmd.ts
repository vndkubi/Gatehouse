import { ConsoleServer, publishRun } from '@gatehouse/console';
import { ApproverStore } from '@gatehouse/gates';
import { JobQueue, openRuntime } from '@gatehouse/app';

const out = (s = '') => process.stdout.write(`${s}\n`);

export async function serveCmd(): Promise<number> {
  const rt = openRuntime();
  const queue = new JobQueue(Math.max(1, rt.config.scheduler.maxParallelRuns));
  const server = new ConsoleServer({ rt, queue, port: rt.config.console.port });
  const url = await server.start();
  out(`Gatehouse console: ${url}  (bound to 127.0.0.1; open it as localhost so passkeys work)`);
  if (!rt.approvers.list().length) out('No approver yet: run `gatehouse approver enroll` in another terminal, then open /approvers.');
  out('Runs started from the console execute in this process. Ctrl+C to stop.');
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  await server.stop();
  rt.close();
  return 0;
}

export function approverEnrollCmd(): number {
  const rt = openRuntime();
  const approvers = new ApproverStore(rt.paths.db);
  try {
    const code = approvers.issueCode();
    out(`One-time enrollment code (valid 10 minutes): ${code}`);
    out(`Open http://localhost:${rt.config.console.port}/approvers while \`gatehouse serve\` runs, enter the code, and create a passkey.`);
    if (approvers.list().length) out('An approver already exists, so one of them must confirm this enrollment with their passkey.');
    return 0;
  } finally {
    approvers.close();
    rt.close();
  }
}

/** Retries publishing an approved run; the publishers re-verify the signed decision like the console does. */
export async function publishCmd(runId: string): Promise<number> {
  const rt = openRuntime();
  try {
    const r = await publishRun(rt, rt.web, runId);
    out(r.url ? `Published: ${r.url}` : `${r.status}${r.reason ? `: ${r.reason}` : ''}`);
    return r.status === 'refused' || r.status === 'failed' ? 1 : 0;
  } finally {
    rt.close();
  }
}
