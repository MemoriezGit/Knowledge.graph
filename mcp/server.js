#!/usr/bin/env node
/**
 * MCP server exposing the knowledge graph as tools.
 *
 * This is how the graph runs on a *subscription* rather than API credits.
 * Neither a Claude Max plan nor a ChatGPT Plus/Pro plan grants API access — but
 * both hosts speak MCP, so instead of this app calling a model, the model calls
 * this app. Your subscription does the thinking; the graph does the remembering.
 *
 *   stdio  (Claude Desktop, Claude Code)   node mcp/server.js
 *   http   (ChatGPT custom connector)      node mcp/server.js --http [--port 8788]
 *
 * It deliberately talks to the running app over HTTP rather than opening the
 * store directly: two processes writing one JSON file would clobber each other,
 * and going through the app means every write also broadcasts to the live 3D
 * view, so memories appear on screen as they are created.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { TOOLS } from '../server/tools.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const APP_URL = (flag('app', process.env.BRAIN_APP_URL || 'http://127.0.0.1:8787') || '').replace(/\/$/, '');
const USE_HTTP = args.includes('--http');
const HTTP_PORT = Number(flag('port', process.env.MCP_PORT || 8788));

/** ChatGPT connectors conventionally look for `search` and `fetch`. */
const CHATGPT_TOOLS = [
  {
    name: 'search',
    description:
      'Search the knowledge graph for stored memories. Returns matching memories with their ids, which can be passed to fetch.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for.' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description: 'Retrieve one memory in full, including everything it links to, by id or by exact label.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id or exact label.' } },
      required: ['id'],
    },
  },
];

const ALL_TOOLS = [...TOOLS, ...CHATGPT_TOOLS];

async function callApp(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${APP_URL}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(parsed.error || `${res.status} ${res.statusText}`);
  }
  return parsed;
}

async function runRemoteTool(name, input) {
  // `search` and `fetch` are thin aliases over the real tools.
  if (name === 'search') {
    return callApp('/api/mcp/tool', { method: 'POST', body: { name: 'recall_memory', input: { query: input.query } } });
  }
  if (name === 'fetch') {
    return callApp('/api/mcp/tool', {
      method: 'POST',
      body: { name: 'get_neighbors', input: { id: input.id, depth: 1 } },
    });
  }
  return callApp('/api/mcp/tool', { method: 'POST', body: { name, input } });
}

function buildServer() {
  const server = new Server(
    { name: 'second-brain', version: '1.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "This is the user's persistent second brain: a knowledge graph of everything they have told you, " +
        'shown to them as an animated 3D visualisation.\n\n' +
        'Recall before you answer. Whenever the user mentions a person, project, preference, or past event, ' +
        'call recall_memory first rather than answering from your own guess.\n\n' +
        'Store proactively. Any durable fact, decision, preference, deadline, name, or relationship goes into ' +
        'remember before you reply — you do not need to be asked. Prefer several small sharply-scoped nodes ' +
        'over one large one, and always link them to each other and to what is already there. An unconnected ' +
        'node is nearly useless.\n\n' +
        'Call focus_view when your answer centres on particular memories; it flies the camera to them on the ' +
        "user's screen while you talk.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: input } = request.params;
    try {
      const outcome = await runRemoteTool(name, input || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.result ?? outcome, null, 2) }],
        isError: !!outcome.isError,
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Could not reach the second brain at ${APP_URL}: ${err.message}\n\n` +
              'Is it running? Start it with `npm run serve`.',
          },
        ],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'brain://graph',
        name: 'Knowledge graph',
        description: 'The full graph of memories and the connections between them, as JSON.',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== 'brain://graph') {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    const graph = await callApp('/api/graph');
    return {
      contents: [{ uri: 'brain://graph', mimeType: 'application/json', text: JSON.stringify(graph, null, 2) }],
    };
  });

  return server;
}

// ── transports ───────────────────────────────────────────────────────────────

if (USE_HTTP) {
  // ChatGPT custom connectors take a URL, so that side needs Streamable HTTP
  // rather than stdio.
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    // A browser-based host will preflight this.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, mcp-protocol-version');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP endpoint is at /mcp' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await buildServer().connect(transport);
    }

    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
    }

    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(HTTP_PORT, () => {
    console.error(`second-brain MCP (http) → http://localhost:${HTTP_PORT}/mcp   app: ${APP_URL}`);
    console.error('Add that URL as a custom connector in ChatGPT (Settings → Connectors → Developer mode).');
    console.error('It is unauthenticated — expose it beyond localhost only behind a tunnel you control.');
  });
} else {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  // stdout is the protocol channel; anything human-readable must go to stderr.
  console.error(`second-brain MCP (stdio) ready. app: ${APP_URL}`);
}
