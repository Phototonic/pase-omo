import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function server(kind) {
  const s = new Server({ name: 'pase-omo-fixture', version: '1.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'bridge_echo', description: 'Echo a synthetic validation value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
    { name: 'bridge_error', description: 'Return a synthetic tool error.', inputSchema: { type: 'object', properties: {} } },
  ] }));
  s.setRequestHandler(CallToolRequestSchema, async r => r.params.name === 'bridge_error'
    ? { content: [{ type: 'text', text: 'EXPECTED_FIXTURE_ERROR' }], isError: true }
    : { content: [{ type: 'text', text: JSON.stringify({ kind, value: r.params.arguments?.value, envMatched: kind !== 'stdio' || process.env.MCP_FIXTURE_ENV === 'fixture-only', argumentMatched: kind !== 'stdio' || process.argv[3] === 'two words', cwd: process.cwd() }) }] });
  s.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'fixture://note', name: 'note', mimeType: 'text/plain' }] }));
  s.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: 'fixture://note', text: 'RESOURCE_OK', mimeType: 'text/plain' }] }));
  s.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'fixture_prompt', description: 'Synthetic prompt.' }] }));
  s.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'PROMPT_OK' } }] }));
  return s;
}
if (process.argv[2] === 'stdio') {
  const s = server('stdio'); await s.connect(new StdioServerTransport());
  process.stdin.once('end', () => { void s.close(); });
} else {
  const sessions = new Map();
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only') { res.writeHead(401); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/sse' && req.method === 'GET') {
        const t = new SSEServerTransport('/messages', res); sessions.set(t.sessionId, t);
        t.onclose = () => sessions.delete(t.sessionId);
        await server('sse').connect(t); return;
      }
      if (url.pathname === '/messages') {
        const t = sessions.get(url.searchParams.get('sessionId'));
        if (!t) { res.writeHead(404); res.end(); return; }
        await t.handlePostMessage(req, res); return;
      }
      if (url.pathname === '/mcp') {
        let t = sessions.get(req.headers['mcp-session-id']);
        if (!t && req.method === 'POST' && !req.headers['mcp-session-id']) {
          t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => sessions.set(id, t) });
          t.onclose = () => sessions.delete(t.sessionId);
          await server('http').connect(t);
        }
        if (t) { await t.handleRequest(req, res); return; }
      }
      res.writeHead(404); res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  process.stdout.write(JSON.stringify({ port: http.address().port })+'\n');
  process.once('SIGTERM', async () => {
    await Promise.allSettled([...sessions.values()].map(t => t.close()));
    http.closeAllConnections(); http.close();
  });
}
