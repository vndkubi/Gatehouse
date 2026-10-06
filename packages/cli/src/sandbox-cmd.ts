import { bootstrapCheck, envParity, openRuntime } from '@gatehouse/app';

const out = (s = '') => process.stdout.write(`${s}\n`);

/** B0: does the cell reproduce the host's test baseline? */
export async function envParityCmd(repo: string, json: boolean): Promise<number> {
  const rt = openRuntime();
  try {
    const r = await envParity(rt, repo);
    if (json) {
      out(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    const line = (name: string, s: typeof r.host) =>
      out(`${name.padEnd(5)} ${s ? `${s.level}  ${s.summary.passed}/${s.summary.total} passed, ${s.summary.failed} failed, ${s.summary.flaky} flaky  (${s.run})` : 'no L2 baseline'}`);
    line('host', r.host);
    line('cell', r.cell);
    for (const d of r.differences.slice(0, 30)) out(`  differs  ${d.test}: host ${d.host}, cell ${d.cell}`);
    for (const t of r.onlyOnHost.slice(0, 15)) out(`  host only  ${t}`);
    for (const t of r.onlyInCell.slice(0, 15)) out(`  cell only  ${t}`);
    for (const t of r.needsContainerRuntime.slice(0, 15)) out(`  expected   ${t} (needs a container runtime)`);
    for (const n of r.notes) out(`  note: ${n}`);
    out(r.ok ? 'PARITY: the cell reproduces the host baseline.' : r.host && r.cell ? 'NO PARITY: fix the cell image/spec before trusting cell results (or keep this repo on host).' : '');
    return r.ok ? 0 : 1;
  } finally {
    rt.close();
  }
}

/** B4: what this machine still needs for sandbox cells. Read-only. */
export async function bootstrapCheckCmd(json: boolean): Promise<number> {
  const rt = openRuntime();
  try {
    const checks = await bootstrapCheck(rt);
    if (json) out(JSON.stringify(checks, null, 2));
    else {
      for (const c of checks) {
        out(`${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'FAIL'}  ${c.name.padEnd(22)} ${c.detail}`);
        if (c.fix) out(`      ${''.padEnd(22)} → ${c.fix}`);
      }
    }
    return checks.some((c) => c.status === 'fail') ? 1 : 0;
  } finally {
    rt.close();
  }
}
