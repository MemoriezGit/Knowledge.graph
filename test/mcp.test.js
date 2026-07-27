import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests the MCP server that lets a Claude or ChatGPT *subscription* drive the
 * graph. It is spawned as a real subprocess and driven over stdio with real
 * JSON-RPC, against a stub of the app's HTTP API — so this covers the protocol
 * layer and the proxying without needing the full app or any API key.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(__dirname, '..', 'mcp', 'server.js');

/** Stub of the app's HTTP surface, recording what the MCP server asks for. */
async function stubApp() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      calls.push({ url: req.url, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/graph') {
        res.end(JSON.stringify({ nodes: [{ id: 'n_1', label: 'Seeded' }], edges: [] }));
      } else {
        res.end(JSON.stringify({ result: { ok: true, echo: parsed }, isError: false }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Drive the MCP server over stdio and collect responses by request id. */
function speakMcp(appUrl, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_ENTRY, '--app', appUrl], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    });
    let out = '';
    const responses = new Map();
    child.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) responses.set(msg.id, msg);
        } catch {
          /* not a JSON-RPC line */
        }
      }
      const wantIds = requests.filter((r) => r.id != null).map((r) => r.id);
      if (wantIds.every((id) => responses.has(id))) {
        child.kill();
        resolve(responses);
      }
    });
    child.on('error', reject);
    setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server did not answer in time. stdout so far: ${out.slice(0, 400)}`));
    }, 15000).unref();

    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

const HANDSHAKE = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];

test('mcp: initializes and advertises the memory tools plus ChatGPT aliases', async () => {
  const app = await stubApp();
  try {
    const res = await speakMcp(app.url, [...HANDSHAKE, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);

    const init = res.get(1).result;
    assert.equal(init.serverInfo.name, 'second-brain');
    assert.match(init.instructions, /Recall before you answer/, 'host-visible instructions present');

    const names = res.get(2).result.tools.map((t) => t.name);
    for (const expected of ['recall_memory', 'remember', 'link_nodes', 'forget', 'focus_view', 'graph_stats']) {
      assert.ok(names.includes(expected), `exposes ${expected}`);
    }
    // ChatGPT connectors look for these two by convention.
    assert.ok(names.includes('search'), 'exposes search for ChatGPT');
    assert.ok(names.includes('fetch'), 'exposes fetch for ChatGPT');

    const remember = res.get(2).result.tools.find((t) => t.name === 'remember');
    assert.equal(remember.inputSchema.type, 'object', 'schema passed through as JSON Schema');
    assert.ok(remember.inputSchema.properties.nodes, 'schema retains its shape');
  } finally {
    await app.close();
  }
});

test('mcp: a tool call proxies to the app rather than touching the store', async () => {
  const app = await stubApp();
  try {
    await speakMcp(app.url, [
      ...HANDSHAKE,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'remember', arguments: { nodes: [{ label: 'X', type: 'fact', summary: 'y' }] } },
      },
    ]);

    const call = app.calls.find((c) => c.url === '/api/mcp/tool');
    assert.ok(call, 'went through the app HTTP API — one writer, and writes broadcast to viewers');
    assert.equal(call.body.name, 'remember');
    assert.equal(call.body.input.nodes[0].label, 'X');
  } finally {
    await app.close();
  }
});

test('mcp: ChatGPT search and fetch alias onto the real tools', async () => {
  const app = await stubApp();
  try {
    await speakMcp(app.url, [
      ...HANDSHAKE,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'kyoto' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetch', arguments: { id: 'Kyoto trip' } } },
    ]);

    const toolCalls = app.calls.filter((c) => c.url === '/api/mcp/tool').map((c) => c.body);
    const search = toolCalls.find((c) => c.input?.query === 'kyoto');
    assert.equal(search.name, 'recall_memory', 'search maps to recall_memory');

    const fetched = toolCalls.find((c) => c.input?.id === 'Kyoto trip');
    assert.equal(fetched.name, 'get_neighbors', 'fetch maps to get_neighbors');
  } finally {
    await app.close();
  }
});

test('mcp: exposes the graph as a readable resource', async () => {
  const app = await stubApp();
  try {
    const res = await speakMcp(app.url, [
      ...HANDSHAKE,
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'brain://graph' } },
    ]);

    assert.equal(res.get(2).result.resources[0].uri, 'brain://graph');
    const graph = JSON.parse(res.get(3).result.contents[0].text);
    assert.equal(graph.nodes[0].label, 'Seeded');
  } finally {
    await app.close();
  }
});

test('mcp: speak is exposed and routes through the app so the graph talks', async () => {
  const app = await stubApp();
  try {
    const res = await speakMcp(app.url, [
      ...HANDSHAKE,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'speak', arguments: { text: 'Your dentist is Dr. Okafor.' } },
      },
    ]);

    const speak = res.get(2).result.tools.find((t) => t.name === 'speak');
    assert.ok(speak, 'speak is advertised');
    assert.match(speak.description, /out loud/i);

    const call = app.calls.filter((c) => c.url === '/api/mcp/tool').map((c) => c.body).at(-1);
    assert.equal(call.name, 'speak');
    assert.equal(call.input.text, 'Your dentist is Dr. Okafor.');
  } finally {
    await app.close();
  }
});

test('mcp: the HTTP transport refuses requests without the right bearer token', async () => {
  const app = await stubApp();
  const TOKEN = 'a-known-test-token';
  const port = 8899;
  const child = spawn(
    process.execPath,
    [MCP_ENTRY, '--http', '--port', String(port), '--token', TOKEN, '--app', app.url],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' } },
  );
  // Wait for the listener to come up.
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => String(d).includes('MCP over HTTP') && resolve());
    setTimeout(() => reject(new Error('http transport did not start')), 10000).unref();
  });

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const url = `http://127.0.0.1:${port}/mcp`;

  try {
    const anonymous = await fetch(url, { method: 'POST', headers, body });
    assert.equal(anonymous.status, 401, 'no token is rejected');

    const wrong = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer not-the-token' },
      body,
    });
    assert.equal(wrong.status, 401, 'a wrong token is rejected');

    const good = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${TOKEN}` },
      body,
    });
    assert.equal(good.status, 200, 'the right token is accepted');
  } finally {
    child.kill();
    await app.close();
  }
});

test('mcp: an unreachable app produces a useful message, not a crash', async () => {
  // Nothing listening on this port.
  const res = await speakMcp('http://127.0.0.1:1', [
    ...HANDSHAKE,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'graph_stats', arguments: {} } },
  ]);

  const result = res.get(2).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not reach the second brain/);
  assert.match(result.content[0].text, /npm run serve/, 'tells the user how to fix it');
});
