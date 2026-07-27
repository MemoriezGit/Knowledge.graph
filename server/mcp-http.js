import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { buildMcpServer } from '../mcp/shared.js';
import { runTool } from './tools.js';
import * as store from './store.js';

/**
 * Serves MCP over HTTP from inside the app, at /mcp.
 *
 * ChatGPT connects to a URL, not a command, so it needs an HTTP endpoint. Doing
 * it in-process rather than as a second server means one command to start, one
 * port to tunnel, and no proxy hop for tool calls.
 */

// Secure by default. This endpoint reads and writes everything the user has
// ever told it, so there is no unauthenticated mode: without MCP_TOKEN a random
// one is generated at boot and printed.
export const MCP_TOKEN = process.env.MCP_TOKEN || randomBytes(24).toString('base64url');
export const MCP_TOKEN_IS_GENERATED = !process.env.MCP_TOKEN;

function tokenMatches(header) {
  const provided = String(header || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(MCP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mountMcp(app) {
  const sessions = new Map();

  const handler = async (req, res) => {
    if (!tokenMatches(req.headers.authorization)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({
        error: 'unauthorized — send Authorization: Bearer <token>. Run `npm run setup` to see yours.',
      });
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
      const server = buildMcpServer({
        // In-process: no HTTP hop, and the same single writer as everything else.
        callTool: (name, input) => runTool(name, input, { source: 'mcp' }),
        readGraph: async () => store.snapshot(),
      });
      await server.connect(transport);
    }

    // express.json() has already consumed and parsed the body.
    await transport.handleRequest(req, res, req.body);
  };

  app.all('/mcp', handler);
}
