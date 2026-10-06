import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { sha256Value, type EventStore, type McpServerConfig, type RunTokenSigner } from '@gatehouse/core';
import { redact, type DlpOptions } from '@gatehouse/dlp';
import { scrubEnv } from '@gatehouse/targets';

export type ToolClass = 'read' | 'write' | 'deny' | 'undeclared';

const matches = (pattern: string, name: string) =>
  new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);

/** Manifest lookup. deny wins; anything not listed is undeclared, which is treated as deny. */
export function classify(manifest: McpServerConfig['tools'], tool: string): ToolClass {
  if ((manifest.deny ?? []).some((p) => matches(p, tool))) return 'deny';
  if ((manifest.write ?? []).some((p) => matches(p, tool))) return 'write';
  if ((manifest.read ?? []).some((p) => matches(p, tool))) return 'read';
  return 'undeclared';
}

/** Name-based hint for `gatehouse mcp inspect`; a human confirms before it goes in the manifest. */
export function suggestClass(tool: string): 'read' | 'write' {
  return /(create|update|add|delete|remove|transition|post|publish|set|assign|move|edit|upload|archive|link|close|merge)/i.test(tool) ? 'write' : 'read';
}

export class ToolDenied extends Error {}

export interface McpProxyOptions {
  servers: Record<string, McpServerConfig>;
  events: EventStore;
  signer: RunTokenSigner;
  resolveSecret: (name: string) => Promise<string>;
  dlp: DlpOptions;
}

/**
 * BYO-MCP proxy (design 05 §3). The user's MCP servers (e.g. Jira/Confluence Server/DC) run
 * here, outside any agent workspace, with their credentials. Callers see only manifest-approved
 * tools; every result is DLP-redacted and every call is an event. Write tools are reachable
 * only with allowWrite, which agent-facing paths never set.
 */
export class McpProxy {
  private readonly clients = new Map<string, Promise<Client>>();
  private http: HttpServer | null = null;

  constructor(private readonly options: McpProxyOptions) {}

  async listTools(server: string, includeWrite = false): Promise<Array<Tool & { cls: ToolClass }>> {
    const cfg = this.serverConfig(server);
    const { tools } = await (await this.client(server)).listTools();
    return tools
      .map((t) => ({ ...t, cls: classify(cfg.tools, t.name) }))
      .filter((t) => t.cls === 'read' || (includeWrite && t.cls === 'write'));
  }

  /** All tools with their classification, including denied/undeclared ones; for `mcp inspect` only. */
  async inspect(server: string): Promise<Array<{ name: string; description: string; cls: ToolClass; suggested: 'read' | 'write' }>> {
    const cfg = this.serverConfig(server);
    const { tools } = await (await this.client(server)).listTools();
    return tools.map((t) => ({ name: t.name, description: t.description ?? '', cls: classify(cfg.tools, t.name), suggested: suggestClass(t.name) }));
  }

  async callTool(req: { runId: string; stepId: string; server: string; tool: string; args: Record<string, unknown>; allowWrite?: boolean }): Promise<string> {
    const cls = classify(this.serverConfig(req.server).tools, req.tool);
    const base = { stepId: req.stepId, server: req.server, tool: req.tool, cls, argsHash: sha256Value(req.args).slice(0, 12) };
    if (cls === 'deny' || cls === 'undeclared' || (cls === 'write' && !req.allowWrite)) {
      this.options.events.append(req.runId, 'TOOL_DENIED', base);
      throw new ToolDenied(`${req.server}/${req.tool} is ${cls === 'write' ? 'a write tool' : cls}; not allowed here`);
    }
    const result = await (await this.client(req.server)).callTool({ name: req.tool, arguments: req.args });
    const parts: string[] = [];
    let redactions = 0;
    for (const c of (result.content as Array<{ type: string; text?: string }>) ?? []) {
      if (c.type === 'text' && typeof c.text === 'string') {
        const r = redact(c.text, this.options.dlp);
        redactions += r.hits.length;
        parts.push(r.text);
      } else {
        // Images and binary blobs cannot be DLP-scanned here; fail closed.
        parts.push(`[${c.type} content withheld by Gatehouse: cannot be scanned for account data]`);
      }
    }
    this.options.events.append(req.runId, 'TOOL_CALL', { ...base, ok: !result.isError, redactions });
    return parts.join('\n');
  }

  /**
   * Agent-facing endpoint: POST /mcp/<server> with `Authorization: Bearer <run token>`.
   * Stateless streamable HTTP; exposes read tools only and wraps results as untrusted data.
   */
  async startHttp(port = 0): Promise<string> {
    this.http = createServer((req, res) => {
      this.handleHttp(req, res).catch((err: Error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    await new Promise<void>((resolve) => this.http!.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}/mcp`;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/mcp\/([\w.-]+)\/?$/.exec(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (!m || !this.options.servers[m[1]!]) {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? '';
    const claims = auth.startsWith('Bearer ') ? this.options.signer.verify(auth.slice(7)) : null;
    if (!claims) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid or expired run token' }));
      return;
    }
    const serverName = m[1]!;
    const server = new Server({ name: `gatehouse-${serverName}`, version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await this.listTools(serverName, false)).map(({ cls: _cls, ...t }) => t),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const text = await this.callTool({
          runId: claims.runId,
          stepId: claims.stepId,
          server: serverName,
          tool: request.params.name,
          args: (request.params.arguments ?? {}) as Record<string, unknown>,
        });
        const safe = text.replace(/<\/untrusted>/gi, '</untrusted_>');
        return { content: [{ type: 'text', text: `<untrusted source="mcp:${serverName}/${request.params.name}">\n${safe}\n</untrusted>` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async close(): Promise<void> {
    if (this.http) await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.http = null;
    for (const c of this.clients.values()) await (await c).close().catch(() => undefined);
    this.clients.clear();
  }

  private serverConfig(server: string): McpServerConfig {
    const cfg = this.options.servers[server];
    if (!cfg) throw new Error(`unknown MCP server ${server}`);
    return cfg;
  }

  private client(server: string): Promise<Client> {
    let c = this.clients.get(server);
    if (!c) {
      c = this.connect(server);
      this.clients.set(server, c);
    }
    return c;
  }

  private async connect(server: string): Promise<Client> {
    const cfg = this.serverConfig(server);
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) extra[k] = typeof v === 'string' ? v : await this.options.resolveSecret(v.secret);
    const { env } = scrubEnv(process.env, extra);
    const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: env as Record<string, string>, stderr: 'ignore' });
    const client = new Client({ name: 'gatehouse', version: '0.1.0' });
    await client.connect(transport);
    return client;
  }
}
