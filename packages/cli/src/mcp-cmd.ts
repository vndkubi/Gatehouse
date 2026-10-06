import { mcpProxy, openRuntime } from '@gatehouse/app';

const out = (s = '') => process.stdout.write(`${s}\n`);

export async function mcpInspectCmd(server: string): Promise<number> {
  const rt = openRuntime();
  const proxy = mcpProxy(rt);
  try {
    const tools = await proxy.inspect(server);
    out(`${server}: ${tools.length} tool(s)\n`);
    for (const t of tools) {
      const hint = t.cls === 'undeclared' ? `  -> add to tools.${t.suggested} if appropriate` : '';
      out(`  ${t.cls.padEnd(10)} ${t.name}${hint}`);
    }
    out('\nUndeclared and denied tools are never callable. Write tools are never offered to agents.');
    return 0;
  } finally {
    await proxy.close();
    rt.close();
  }
}
