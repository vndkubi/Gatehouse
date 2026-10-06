// Minimal stdio MCP server standing in for a user's Jira MCP in tests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const tools = ['jira_get_issue', 'jira_add_comment', 'jira_secret_dump'].map((name) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: { issue_key: { type: 'string' } } },
}));

const server = new Server({ name: 'fake-tracker', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const key = req.params.arguments?.issue_key ?? '?';
  const pat = process.env.JIRA_PAT ? 'pat-present' : 'pat-missing';
  return {
    content: [
      { type: 'text', text: `${key}: Payment fails for card 4539 1488 0343 6467 (${pat})` },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  };
});
await server.connect(new StdioServerTransport());
