import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, providerStatus } from './config.js';
import * as store from './store.js';
import * as memory from './memory.js';
import * as brain from './brain.js';
import { speak } from './providers/openai.js';
import { subscribe, broadcast, viewerCount } from './events.js';
import { runTool } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// ── status ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ...providerStatus(), ...memory.health() });
});

// ── graph ────────────────────────────────────────────────────────────────────

app.get('/api/graph', (req, res) => {
  res.json(store.snapshot({ includeArchived: req.query.archived === '1' }));
});

app.get('/api/node/:id', (req, res) => {
  const node = store.resolveNode(req.params.id);
  if (!node) return res.status(404).json({ error: 'not found' });
  res.json({
    node: store.publicNode(node),
    neighbors: store.neighbors(node.id, 1).map((n) => ({
      node: store.publicNode(n.node),
      relation: n.via.rel,
      direction: n.via.from === node.id ? 'out' : 'in',
      weight: n.via.weight,
    })),
  });
});

app.post('/api/node', async (req, res) => {
  try {
    const { created, merged, edges } = await memory.remember({
      nodes: [req.body],
      links: req.body.links || [],
    });
    broadcast('graph_delta', { source: 'api' });
    res.json({ node: store.publicNode(created[0] || merged[0]), edges: edges.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/node/:id', (req, res) => {
  const node = store.resolveNode(req.params.id);
  if (!node) return res.status(404).json({ error: 'not found' });
  const updated = store.updateNode(node.id, req.body);
  broadcast('graph_delta', { source: 'api' });
  res.json({ node: store.publicNode(updated) });
});

app.delete('/api/node/:id', (req, res) => {
  const node = store.resolveNode(req.params.id);
  if (!node) return res.status(404).json({ error: 'not found' });
  store.forgetNode(node.id, { hard: req.query.hard === '1' });
  broadcast('graph_delta', { source: 'api' });
  res.json({ ok: true });
});

app.post('/api/link', (req, res) => {
  const from = store.resolveNode(req.body.from);
  const to = store.resolveNode(req.body.to);
  if (!from || !to) return res.status(400).json({ error: 'unresolved endpoint' });
  const edge = store.createEdge({ from: from.id, to: to.id, rel: req.body.rel, weight: req.body.weight });
  if (!edge) return res.status(400).json({ error: 'edge rejected' });
  broadcast('graph_delta', { source: 'api' });
  res.json({ edge });
});

app.delete('/api/link/:id', (req, res) => {
  const ok = store.removeEdge(req.params.id);
  if (ok) broadcast('graph_delta', { source: 'api' });
  res.json({ ok });
});

app.get('/api/search', async (req, res) => {
  try {
    const results = await memory.search(String(req.query.q || ''), {
      limit: Math.min(Number(req.query.limit) || 12, 50),
    });
    res.json({
      results: results.map((r) => ({
        node: store.publicNode(r.node),
        score: r.score,
        why: r.reason,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Tool endpoint for the MCP server (mcp/server.js).
 *
 * The MCP process proxies here rather than opening the store itself — one
 * writer avoids clobbering the JSON file, and routing through the app means
 * external writes still broadcast to every live 3D viewer.
 */
app.post('/api/mcp/tool', async (req, res) => {
  const { name, input } = req.body || {};
  if (!name) return res.status(400).json({ error: 'expected { name, input }' });
  try {
    const outcome = await runTool(name, input || {}, { source: 'mcp' });
    await store.flush();
    res.json({ result: outcome.result, isError: !!outcome.isError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── chat (SSE over POST) ─────────────────────────────────────────────────────

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let closed = false;
  const emit = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
  // Comment frames keep intermediaries from timing out a quiet stream.
  const ping = setInterval(() => !closed && res.write(': ping\n\n'), 15000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    res.end();
  };
  res.on('close', () => {
    closed = true;
    clearInterval(ping);
  });
  return { emit, close };
}

/**
 * Live viewer stream. Any change to the graph — from this UI, from Claude
 * Desktop, or from ChatGPT over MCP — is pushed here so the 3D view reacts.
 */
app.get('/api/events', (req, res) => {
  const { emit, close } = openSSE(res);
  const unsubscribe = subscribe(emit);
  emit('hello', { viewers: viewerCount(), stats: store.stats() });
  req.on('close', () => {
    unsubscribe();
    close();
  });
});

app.post('/api/chat', async (req, res) => {
  const { emit, close } = openSSE(res);
  try {
    await brain.converse(req.body?.message, emit);
  } catch (err) {
    console.error('[chat]', err);
    emit('error', { message: err.message });
  } finally {
    close();
  }
});

app.post('/api/consolidate', async (req, res) => {
  const { emit, close } = openSSE(res);
  try {
    emit('start', { provider: config.provider, model: providerStatus().model });
    await brain.consolidate(emit);
    await store.flush();
    emit('done', { stats: store.stats() });
  } catch (err) {
    emit('error', { message: err.message });
  } finally {
    close();
  }
});

// ── voice ────────────────────────────────────────────────────────────────────

app.post('/api/tts', async (req, res) => {
  if (!config.openai.apiKey) {
    return res.status(503).json({ error: 'No OPENAI_API_KEY — the browser voice is being used instead.' });
  }
  try {
    const audio = await speak(String(req.body?.text || ''), { voice: req.body?.voice });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── backup ───────────────────────────────────────────────────────────────────

app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="brain-${Date.now()}.json"`);
  res.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    nodes: store.allNodes(),
    edges: store.allEdges(),
    episodes: store.episodes(),
  });
});

app.post('/api/import', async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.nodes)) {
    return res.status(400).json({ error: 'expected { nodes: [], edges: [] }' });
  }
  const snap = store.replaceAll(body);
  await store.flush();
  broadcast('graph_delta', { source: 'api' });
  await memory.ensureEmbeddings({ limit: 512 });
  res.json(snap);
});

// ── static (production) ──────────────────────────────────────────────────────

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────

const status = providerStatus();
await store.load();
await memory.ensureEmbeddings({ limit: 256 });

app.listen(config.port, () => {
  const s = store.stats();
  console.log('');
  console.log(`  ${config.brainName} — 3D knowledge graph`);
  console.log(`  brain      : ${status.provider} / ${status.model} ${status.hasKey ? '' : '  ⚠ NO API KEY'}`);
  console.log(`  embeddings : ${status.embeddings}`);
  console.log(`  memory     : ${s.nodes} nodes, ${s.edges} edges  (${store.dataFile()})`);
  console.log(`  api        : http://localhost:${config.port}`);
  if (fs.existsSync(distDir)) console.log(`  app        : http://localhost:${config.port}`);
  else console.log(`  app        : http://localhost:5173  (vite dev server)`);
  if (!status.hasKey) {
    console.log('');
    console.log(`  ⚠ Set ${status.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} in .env to bring the brain online.`);
  }
  console.log('');
});
