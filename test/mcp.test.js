import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests the two ways a Claude or ChatGPT *subscription* drives the graph:
 *
 *   stdio  — mcp/server.js, spawned as a real subprocess and driven with real
 *            JSON-RPC against a stub of the app's HTTP API (Claude Desktop).
 *   http   — /mcp inside the app itself, exercised against a really-booted
 *            server on a scratch data dir (ChatGPT connectors).
 *
 * Neither needs an API key: no test here asks the brain to think.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MCP_ENTRY = path.join(ROOT, 'mcp', 'server.js');
const APP_ENTRY = path.join(ROOT, 'server', 'index.js');

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
function speakMcp(appUrl, requests, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_ENTRY, '--app', appUrl, ...extraArgs], {
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

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

const HANDSHAKE = [INITIALIZE, { jsonrpc: '2.0', method: 'notifications/initialized' }];

/** An unused port. Racy in principle, fine for a test that binds immediately. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/**
 * Boot the actual app on a scratch data dir, so /mcp is tested as the thing
 * users run — not a re-creation of it. No API key is set: the brain is never
 * asked to think here, only to store and recall.
 */
async function startApp() {
  const port = await freePort();
  const token = 'a-known-test-token';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
  const child = spawn(process.execPath, [APP_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MCP_TOKEN: token,
      DATA_DIR: dataDir,
      // Pin the provider so the boot path doesn't probe for a local Claude Code
      // install, which would make the test depend on the machine it runs on.
      BRAIN_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      NO_PROXY: '127.0.0.1,localhost',
    },
  });

  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`app did not start within 20s. stderr: ${stderr.slice(0, 500)}`)),
      20000,
    );
    deadline.unref();
    child.stdout.on('data', (d) => {
      if (String(d).includes('is running')) {
        clearTimeout(deadline);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`app exited (${code}). stderr: ${stderr.slice(0, 500)}`)));
  });

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    stop: async () => {
      child.kill();
      await new Promise((r) => child.once('exit', r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The tool endpoint the stdio MCP server proxies through. */
async function callToolOverHttp(appUrl, body) {
  const res = await fetch(`${appUrl}/api/mcp/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Watch /api/events the way the browser does, while `run` happens. */
async function watchEvents(appUrl, run) {
  const res = await fetch(`${appUrl}/api/events`, { headers: { Accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const seen = [];
  const pump = (async () => {
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop();
        for (const frame of frames) {
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name) seen.push({ name, data: data ? JSON.parse(data) : {} });
        }
      }
    } catch {
      /* cancelled */
    }
  })();

  await run();
  await new Promise((r) => setTimeout(r, 300)); // let the last frame land
  await reader.cancel();
  await pump;
  return seen;
}

/**
 * One Streamable HTTP request. The transport answers JSON-RPC as a single SSE
 * frame, so unwrap that to the message the client would actually see.
 */
async function postRpc(url, body, { token, session } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  let message;
  try {
    message = data ? JSON.parse(data) : text ? JSON.parse(text) : undefined;
  } catch {
    message = undefined;
  }
  return { status: res.status, headers: res.headers, message, text };
}

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

test('mcp: writes are labelled by who asked, not by which transport they arrived on', async () => {
  const app = await stubApp();
  try {
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'graph_stats', arguments: {} },
    };

    // Another app driving the graph.
    await speakMcp(app.url, [...HANDSHAKE, call]);
    assert.equal(app.calls.at(-1).body.source, 'mcp');

    // This app's own subscription provider, which reaches its tools the same
    // way. Without the distinction the 3D view tells you your own typed
    // message was an external change.
    await speakMcp(app.url, [...HANDSHAKE, call], ['--source', 'brain']);
    assert.equal(app.calls.at(-1).body.source, 'brain');
  } finally {
    await app.close();
  }
});

test('mcp over http: the /mcp endpoint refuses requests without the right bearer token', async () => {
  const brain = await startApp();
  const url = `${brain.url}/mcp`;
  try {
    const anonymous = await postRpc(url, INITIALIZE);
    assert.equal(anonymous.status, 401, 'no token is rejected');

    const wrong = await postRpc(url, INITIALIZE, { token: 'not-the-token' });
    assert.equal(wrong.status, 401, 'a wrong token is rejected');

    const short = await postRpc(url, INITIALIZE, { token: brain.token.slice(0, 4) });
    assert.equal(short.status, 401, 'a prefix of the token is rejected');

    const good = await postRpc(url, INITIALIZE, { token: brain.token });
    assert.equal(good.status, 200, 'the right token is accepted');
  } finally {
    await brain.stop();
  }
});

test('mcp over http: a connector can read and write the real graph in-process', async () => {
  const brain = await startApp();
  const url = `${brain.url}/mcp`;
  const token = brain.token;
  try {
    const init = await postRpc(url, INITIALIZE, { token });
    const session = init.headers.get('mcp-session-id');
    assert.ok(session, 'the transport hands back a session id');
    assert.equal(init.message.result.serverInfo.name, 'second-brain');

    await postRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token, session });

    const listed = await postRpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token, session });
    const names = listed.message.result.tools.map((t) => t.name);
    assert.ok(names.includes('remember') && names.includes('search') && names.includes('speak'));

    const wrote = await postRpc(
      url,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'remember',
          arguments: { nodes: [{ label: 'Kyoto trip', type: 'event', summary: 'Cherry blossom season.' }] },
        },
      },
      { token, session },
    );
    assert.equal(wrote.message.result.isError, false, 'the write succeeded');

    // The point of merging the bridge into the app: a connector's write lands in
    // the same store the 3D view is reading, with no second process involved.
    const graph = await (await fetch(`${brain.url}/api/graph`)).json();
    assert.ok(
      graph.nodes.some((n) => n.label === 'Kyoto trip'),
      'what ChatGPT wrote is in the graph the browser sees',
    );

    const found = await postRpc(
      url,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: 'kyoto' } } },
      { token, session },
    );
    assert.match(found.message.result.content[0].text, /Kyoto trip/, 'search finds it again');
  } finally {
    await brain.stop();
  }
});

test('viewers are told which writes came from another app', async () => {
  const brain = await startApp();
  try {
    const write = (label, source) => ({
      name: 'remember',
      input: { nodes: [{ label, type: 'fact', summary: label }] },
      ...(source ? { source } : {}),
    });

    const seen = await watchEvents(brain.url, async () => {
      // The app's own subscription provider, reaching its tools over MCP.
      await callToolOverHttp(brain.url, write('From the app', 'brain'));
      // Claude Desktop or ChatGPT.
      await callToolOverHttp(brain.url, write('From ChatGPT'));
      // Anything else is treated as external rather than taken at its word.
      await callToolOverHttp(brain.url, write('Claiming to be local', 'local'));
    });

    assert.deepEqual(
      seen.filter((e) => e.name === 'graph_delta').map((e) => e.data.source),
      ['brain', 'mcp', 'mcp'],
      'only the app itself may claim a write is its own',
    );
  } finally {
    await brain.stop();
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
  assert.match(result.content[0].text, /npm start/, 'tells the user how to fix it');
});
