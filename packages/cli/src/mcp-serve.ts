import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { consoleApiToken } from '@gatehouse/console';
import { gatehousePaths, loadConfig } from '@gatehouse/core';
import { untrusted } from '@gatehouse/workflows';

type Args = Record<string, unknown>;
interface ToolDef {
  tool: Tool;
  call: (a: Args) => Promise<unknown>;
  /** Results carrying repo- or agent-authored text are wrapped as untrusted data. */
  untrusted?: boolean;
}

async function parseJson(res: Response, base: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`unexpected reply from ${base} (HTTP ${res.status}); an older \`gatehouse serve\` may be running there, restart it`);
  }
}

const str = (description: string) => ({ type: 'string', description });

/**
 * MCP server for IDE agents (VS Code Copilot, Codex, Claude Code). It is a thin client of the
 * running console: jobs execute in the console's queue under the same walls as anything else.
 * It can start work and read state. It cannot approve, publish, change settings or read secrets.
 */
export function ideTools(base: string, token: string, fetchImpl: typeof fetch = fetch): ToolDef[] {
  const get = async (path: string) => {
    const res = await fetchImpl(`${base}${path}`).catch(() => {
      throw new Error(`Gatehouse console is not running at ${base}; start it with \`gatehouse serve\``);
    });
    const body = await parseJson(res, base);
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    return body;
  };
  const post = async (path: string, payload: Args) => {
    const res = await fetchImpl(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }).catch(() => {
      throw new Error(`Gatehouse console is not running at ${base}; start it with \`gatehouse serve\``);
    });
    const body = (await parseJson(res, base)) as { job?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return { ...body, dashboard: `${base}/`, note: 'Queued in Gatehouse. Gates are approved by the user in the console with their passkey.' };
  };
  const id = (a: Args, k: string) => {
    const v = String(a[k] ?? '');
    if (!/^[\w.-]+$/.test(v)) throw new Error(`${k} is required`);
    return v;
  };

  return [
    { tool: { name: 'list_repos', description: 'Repositories registered in Gatehouse, with PCI scope and verified environment level', inputSchema: { type: 'object', properties: {} } }, call: () => get('/api/repos') },
    {
      tool: { name: 'list_pull_requests', description: 'Open pull requests of a registered GitHub repository', inputSchema: { type: 'object', properties: { repo: str('Gatehouse repo name') }, required: ['repo'] } },
      call: (a) => get(`/api/prs?repo=${encodeURIComponent(id(a, 'repo'))}`),
      untrusted: true,
    },
    { tool: { name: 'list_runs', description: 'Recent Gatehouse runs with status; runs awaiting a gate need the user in the console', inputSchema: { type: 'object', properties: {} } }, call: () => get('/api/runs') },
    { tool: { name: 'list_jobs', description: 'The console job queue (queued, running, finished jobs with recent log lines)', inputSchema: { type: 'object', properties: {} } }, call: () => get('/api/jobs'), untrusted: true },
    {
      tool: { name: 'run_status', description: 'Status of one run and its console link', inputSchema: { type: 'object', properties: { runId: str('Run id') }, required: ['runId'] } },
      call: (a) => get(`/api/runs/${id(a, 'runId')}`),
    },
    {
      tool: { name: 'get_summary', description: 'The Markdown summary of a run (review findings, ticket package, coverage report)', inputSchema: { type: 'object', properties: { runId: str('Run id') }, required: ['runId'] } },
      call: (a) => get(`/api/runs/${id(a, 'runId')}/summary`),
      untrusted: true,
    },
    {
      tool: {
        name: 'start_pr_review',
        description: 'Queue a Gatehouse review of a pull request. It stops at GATE_5; nothing is posted until the user approves in the console.',
        inputSchema: { type: 'object', properties: { repo: str('Gatehouse repo name'), pr: { type: 'integer', minimum: 1, description: 'Pull request number' } }, required: ['repo', 'pr'] },
      },
      call: (a) => post('/api/jobs/review', { repo: id(a, 'repo'), pr: Number(a.pr) }),
    },
    {
      tool: {
        name: 'start_branch_review',
        description: 'Queue a local review of a pushed branch against a base ref (default branch if omitted). Nothing is posted.',
        inputSchema: { type: 'object', properties: { repo: str('Gatehouse repo name'), head: str('Head ref (branch name)'), base: str('Base ref (optional)') }, required: ['repo', 'head'] },
      },
      call: (a) => post('/api/jobs/branch-review', { repo: id(a, 'repo'), head: String(a.head ?? ''), base: a.base ? String(a.base) : undefined }),
    },
    {
      tool: {
        name: 'start_ticket',
        description: 'Queue the ticket → draft PR pipeline. Each artifact waits for the user\'s approval in the console.',
        inputSchema: { type: 'object', properties: { repo: str('Gatehouse repo name'), ticket: str('Ticket key, e.g. SHOP-123'), text: str('Ticket text, when no tracker MCP is configured (optional)') }, required: ['repo', 'ticket'] },
      },
      call: (a) => post('/api/jobs/ticket', { repo: id(a, 'repo'), ticket: String(a.ticket ?? ''), text: a.text ? String(a.text) : undefined }),
    },
    {
      tool: {
        name: 'start_legacy_tests',
        description: 'Queue characterization tests for the least-covered classes (measured with JaCoCo).',
        inputSchema: { type: 'object', properties: { repo: str('Gatehouse repo name'), scope: str('Package prefix (optional)'), top: { type: 'integer', minimum: 1, maximum: 10, description: 'Max classes (optional)' } }, required: ['repo'] },
      },
      call: (a) => post('/api/jobs/legacy', { repo: id(a, 'repo'), scope: a.scope ? String(a.scope) : undefined, top: a.top ? Number(a.top) : undefined }),
    },
  ];
}

export async function mcpServeCmd(): Promise<number> {
  const { config } = loadConfig({ projectDir: process.cwd() });
  const paths = gatehousePaths(config.paths.home);
  const base = `http://localhost:${config.console.port}`;
  const tools = ideTools(base, consoleApiToken(paths.keys));
  const server = new Server({ name: 'gatehouse', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => t.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = tools.find((t) => t.tool.name === request.params.name);
    if (!def) return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
    try {
      const result = await def.call((request.params.arguments ?? {}) as Args);
      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text: def.untrusted ? untrusted(`gatehouse:${def.tool.name}`, text) : text }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  });
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.once('SIGINT', resolve);
  });
  await server.close();
  return 0;
}
