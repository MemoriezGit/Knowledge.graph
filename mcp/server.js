#!/usr/bin/env node
/**
 * MCP over stdio — for hosts that launch a command, i.e. Claude Desktop and
 * Claude Code.
 *
 * ChatGPT connects by URL instead, and that endpoint lives inside the app at
 * /mcp (see server/mcp-http.js), so there is no second server to run.
 *
 * This one talks to the running app over HTTP rather than opening the store
 * directly: two processes writing one JSON file would clobber each other, and
 * going through the app means every write also reaches the live 3D view.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './shared.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const APP_URL = (flag('app', process.env.BRAIN_APP_URL || 'http://127.0.0.1:8787') || '').replace(/\/$/, '');

/**
 * Who is driving. `mcp` means another app — Claude Desktop, ChatGPT — and the
 * 3D view treats those writes as arriving from elsewhere. The app's own
 * subscription provider launches this same server for its in-app turns and
 * passes `--source brain`, so a message you typed into the app isn't announced
 * back to you as an external change.
 */
const SOURCE = flag('source', 'mcp') === 'brain' ? 'brain' : 'mcp';

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
  if (!res.ok) throw new Error(parsed.error || `${res.status} ${res.statusText}`);
  return parsed;
}

const server = buildMcpServer({
  callTool: (name, input) => callApp('/api/mcp/tool', { method: 'POST', body: { name, input, source: SOURCE } }),
  readGraph: () => callApp('/api/graph'),
  describeError: (err) =>
    `Could not reach the second brain at ${APP_URL}: ${err.message}\n\n` +
    'Is it running? Start it with `npm start` in the project folder.',
});

await server.connect(new StdioServerTransport());
// stdout is the protocol channel; anything human-readable must go to stderr.
console.error(`second-brain MCP (stdio) ready. app: ${APP_URL}`);
