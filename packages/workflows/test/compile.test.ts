import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileAgents, compileIde, listAgents, loadAgent, validateWorkflow } from '../src/index.ts';

test('every agent has a valid neutral spec whose prompt inputs are declared', () => {
  const names = listAgents();
  assert.ok(names.length >= 17);
  for (const n of names) {
    const s = loadAgent(n);
    assert.equal(s.meta.name, n);
    assert.match(s.version, /^[0-9a-f]{12}$/);
  }
});

test('a workflow step cannot grant an agent more tools than its spec declares', () => {
  const problems = validateWorkflow({ id: 'x', version: 1, steps: [{ id: 'pbi', kind: 'agent', executor: 'author', agent: 'pbi-writer', scope: 'write-repo' }] });
  assert.match(problems.join('\n'), /grants write-repo but agent pbi-writer declares at most none/);
  const nested = validateWorkflow({ id: 'x', version: 1, steps: [{ id: 'r', kind: 'agent', executor: 'reviewer', scope: 'write-repo', params: { agents: { T: 'pr-reviewer' } } }] });
  assert.match(nested.join('\n'), /agent pr-reviewer declares at most read-repo/);
  assert.match(validateWorkflow({ id: 'x', version: 1, steps: [{ id: 'a', kind: 'agent', executor: 'author', agent: 'nope' }] }).join('\n'), /a: /);
});

test('agent compiler emits each executor format with scope-bound tools and no shell', () => {
  const files = compileAgents(['copilot', 'codex', 'claude'], ['pbi-writer', 'implementer', 'critic']);
  const copilotImpl = files['.github/agents/gatehouse-implementer.agent.md']!;
  assert.match(copilotImpl, /tools: \['read', 'search', 'edit'\]/);
  assert.match(files['.github/agents/gatehouse-pbi-writer.agent.md']!, /tools: \[\]/);
  assert.match(files['.claude/agents/gatehouse-critic.md']!, /tools: Read, Grep, Glob\n/);
  assert.ok(files['.codex/prompts/gatehouse-critic.md']);
  assert.match(files['.codex/prompts/README.md']!, /gatehouse-implementer/);
  for (const text of Object.values(files)) assert.doesNotMatch(text, /'execute'|Bash|\{\{\w+\}\}/);
  assert.match(copilotImpl, /"\$schema"|"type": "object"/);
});

test('IDE install compiles slash commands for each IDE and only exposes the gatehouse MCP tools', () => {
  const { files, json, notes } = compileIde({ mcpCommand: ['node', '/gh/bin/gatehouse.mjs', 'mcp', 'serve'], targets: ['copilot', 'codex', 'claude'] });
  assert.match(files['.github/prompts/gatehouse-review.prompt.md']!, /tools: \['gatehouse\/\*'\][\s\S]*\$\{input:args\}/);
  assert.match(files['.claude/commands/gatehouse-ticket.md']!, /\$ARGUMENTS/);
  assert.match(files['.github/agents/gatehouse.agent.md']!, /cannot approve gates/);
  assert.match(files['.gatehouse/codex-mcp.toml']!, /\[mcp_servers\.gatehouse\]\ncommand = "node"/);
  const vscode = json['.vscode/mcp.json']!({ servers: { other: { type: 'stdio', command: 'x' } } });
  assert.deepEqual(Object.keys(vscode.servers).sort(), ['gatehouse', 'other'], 'existing servers are kept');
  assert.deepEqual(json['.mcp.json']!({}).mcpServers.gatehouse, { command: 'node', args: ['/gh/bin/gatehouse.mjs', 'mcp', 'serve'] });
  assert.ok(notes.some((n) => n.includes('~/.codex/config.toml')));
});
