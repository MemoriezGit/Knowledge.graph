import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Durable graph store backed by a single JSON file.
 *
 * Deliberately dependency-free: no native modules to compile, no daemon to run,
 * and the whole brain is one greppable file you can back up or hand-edit.
 * Embeddings are packed as base64 Float32 so the file stays reasonable.
 *
 * Node: { id, label, type, summary, content, tags[], importance, color,
 *         createdAt, updatedAt, lastAccessedAt, accessCount, pinned, archived,
 *         embedding: base64|null }
 * Edge: { id, from, to, rel, weight, createdAt }
 * Episode: { id, role, text, ts, nodeIds[] }
 */

const FILE = () => path.join(config.dataDir, 'brain.json');

const EMPTY = { version: 1, nodes: [], edges: [], episodes: [], meta: {} };

let state = structuredClone(EMPTY);
let nodeIndex = new Map();
let edgeIndex = new Map();
let adjacency = new Map(); // nodeId -> Set(edgeId)

let saveTimer = null;
let savePromise = null;
let savePending = null; // { resolve, reject } for the in-flight savePromise
let dirty = false;

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function reindex() {
  nodeIndex = new Map(state.nodes.map((n) => [n.id, n]));
  edgeIndex = new Map(state.edges.map((e) => [e.id, e]));
  adjacency = new Map();
  for (const e of state.edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
    if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
    adjacency.get(e.from).add(e.id);
    adjacency.get(e.to).add(e.id);
  }
}

export async function load() {
  await fsp.mkdir(config.dataDir, { recursive: true });
  try {
    const raw = await fsp.readFile(FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...structuredClone(EMPTY), ...parsed };
    state.nodes ||= [];
    state.edges ||= [];
    state.episodes ||= [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Don't silently start from scratch on a corrupt file — that destroys memory.
      const backup = `${FILE()}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(FILE(), backup);
        console.error(`[store] could not parse brain.json (${err.message}); moved to ${backup}`);
      } catch {
        throw err;
      }
    }
    state = structuredClone(EMPTY);
  }
  reindex();
  return snapshot();
}

async function writeNow() {
  const file = FILE();
  const tmp = `${file}.tmp`;
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fsp.rename(tmp, file); // atomic on POSIX
  dirty = false;
}

/** Debounced atomic save. Returns a promise that settles when the write lands. */
/**
 * Debounced atomic save. Returns a promise that settles when the write lands.
 *
 * All callers within one debounce window share a single promise. Minting a new
 * promise per call would orphan the previous one — its timer gets cleared, so
 * its `resolve` is never reached and anything awaiting it hangs forever.
 */
export function save() {
  dirty = true;
  if (!savePromise) {
    savePromise = new Promise((resolve, reject) => {
      savePending = { resolve, reject };
    });
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    settleSave(writeNow());
  }, 250);
  return savePromise;
}

/** Resolve the shared promise and clear it so the next save() starts a new one. */
function settleSave(work) {
  const pending = savePending;
  savePromise = null;
  savePending = null;
  if (!pending) return work;
  return work.then(pending.resolve, pending.reject);
}

export async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) {
    // Nothing to write, but a debounced caller may still be waiting on us.
    settleSave(Promise.resolve());
    return;
  }
  await settleSave(writeNow());
}

// Best-effort flush so an in-flight memory isn't lost on Ctrl-C.
let flushingOnExit = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (flushingOnExit) return;
    flushingOnExit = true;
    flush()
      .catch((e) => console.error('[store] flush on exit failed:', e.message))
      .finally(() => process.exit(0));
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const getNode = (nodeId) => nodeIndex.get(nodeId) || null;
export const getEdge = (edgeId) => edgeIndex.get(edgeId) || null;
export const allNodes = () => state.nodes;
export const allEdges = () => state.edges;
export const episodes = () => state.episodes;

export function liveNodes() {
  return state.nodes.filter((n) => !n.archived);
}

export function findByLabel(label) {
  if (!label) return null;
  const want = String(label).trim().toLowerCase();
  return (
    state.nodes.find((n) => !n.archived && n.label.toLowerCase() === want) ||
    state.nodes.find((n) => !n.archived && n.label.toLowerCase().includes(want)) ||
    null
  );
}

/** Accepts an id or a label; returns the node or null. */
export function resolveNode(ref) {
  if (!ref) return null;
  return getNode(ref) || findByLabel(ref);
}

export function edgesOf(nodeId) {
  const ids = adjacency.get(nodeId);
  if (!ids) return [];
  return [...ids].map((eid) => edgeIndex.get(eid)).filter(Boolean);
}

export function neighbors(nodeId, depth = 1) {
  const seen = new Set([nodeId]);
  const collected = [];
  let frontier = [nodeId];
  for (let d = 0; d < Math.max(1, Math.min(depth, 4)); d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of edgesOf(cur)) {
        const other = e.from === cur ? e.to : e.from;
        if (seen.has(other)) continue;
        seen.add(other);
        const node = getNode(other);
        if (node && !node.archived) {
          collected.push({ node, via: e, distance: d + 1 });
          next.push(other);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return collected;
}

export function snapshot({ includeArchived = false } = {}) {
  const nodes = includeArchived ? state.nodes : liveNodes();
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes: nodes.map(publicNode),
    edges: state.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    stats: stats(),
  };
}

/** Strip the embedding blob — the browser has no use for it and it's large. */
export function publicNode(n) {
  const { embedding, ...rest } = n;
  return { ...rest, hasEmbedding: !!embedding };
}

export function stats() {
  const live = liveNodes();
  const byType = {};
  for (const n of live) byType[n.type] = (byType[n.type] || 0) + 1;
  return {
    nodes: live.length,
    archived: state.nodes.length - live.length,
    edges: state.edges.length,
    episodes: state.episodes.length,
    byType,
    createdAt: state.meta.createdAt || null,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export const NODE_TYPES = [
  'concept',
  'entity',
  'person',
  'project',
  'fact',
  'event',
  'preference',
  'question',
  'task',
  'source',
];

export function createNode(input) {
  const now = new Date().toISOString();
  const node = {
    id: id('n'),
    label: String(input.label || 'untitled').slice(0, 200),
    type: NODE_TYPES.includes(input.type) ? input.type : 'concept',
    summary: String(input.summary || '').slice(0, 1000),
    content: String(input.content || '').slice(0, 20000),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 24).map(String) : [],
    importance: clamp01(input.importance ?? 0.5),
    color: input.color || null,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    pinned: !!input.pinned,
    archived: false,
    embedding: null,
  };
  state.nodes.push(node);
  nodeIndex.set(node.id, node);
  if (!state.meta.createdAt) state.meta.createdAt = now;
  save();
  return node;
}

export function updateNode(nodeId, patch) {
  const node = getNode(nodeId);
  if (!node) return null;
  const allowed = [
    'label',
    'type',
    'summary',
    'content',
    'tags',
    'importance',
    'color',
    'pinned',
    'archived',
  ];
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'importance') node.importance = clamp01(patch.importance);
    else if (key === 'tags') node.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : node.tags;
    else if (key === 'type') node.type = NODE_TYPES.includes(patch.type) ? patch.type : node.type;
    else node[key] = patch[key];
  }
  // Any edit to the text invalidates the stored vector.
  if (patch.label !== undefined || patch.summary !== undefined || patch.content !== undefined) {
    node.embedding = null;
  }
  node.updatedAt = new Date().toISOString();
  save();
  return node;
}

export function touchNode(nodeId) {
  const node = getNode(nodeId);
  if (!node) return null;
  node.lastAccessedAt = new Date().toISOString();
  node.accessCount = (node.accessCount || 0) + 1;
  // Recall strengthens a memory, with a ceiling so nothing pins itself at 1.0.
  node.importance = clamp01(node.importance + 0.02 * (1 - node.importance));
  save();
  return node;
}

export function createEdge({ from, to, rel, weight }) {
  if (!getNode(from) || !getNode(to) || from === to) return null;
  const relation = String(rel || 'relates_to').slice(0, 60);
  const existing = state.edges.find((e) => e.from === from && e.to === to && e.rel === relation);
  if (existing) {
    existing.weight = clamp01(Math.max(existing.weight, weight ?? existing.weight));
    save();
    return existing;
  }
  const edge = {
    id: id('e'),
    from,
    to,
    rel: relation,
    weight: clamp01(weight ?? 0.6),
    createdAt: new Date().toISOString(),
  };
  state.edges.push(edge);
  edgeIndex.set(edge.id, edge);
  if (!adjacency.has(from)) adjacency.set(from, new Set());
  if (!adjacency.has(to)) adjacency.set(to, new Set());
  adjacency.get(from).add(edge.id);
  adjacency.get(to).add(edge.id);
  save();
  return edge;
}

export function removeEdge(edgeId) {
  const edge = getEdge(edgeId);
  if (!edge) return false;
  state.edges = state.edges.filter((e) => e.id !== edgeId);
  edgeIndex.delete(edgeId);
  adjacency.get(edge.from)?.delete(edgeId);
  adjacency.get(edge.to)?.delete(edgeId);
  save();
  return true;
}

/** Soft delete by default — archived nodes stay recoverable and stop matching search. */
export function forgetNode(nodeId, { hard = false } = {}) {
  const node = getNode(nodeId);
  if (!node) return false;
  if (hard) {
    state.nodes = state.nodes.filter((n) => n.id !== nodeId);
    nodeIndex.delete(nodeId);
    for (const e of edgesOf(nodeId)) removeEdge(e.id);
    adjacency.delete(nodeId);
  } else {
    node.archived = true;
    node.updatedAt = new Date().toISOString();
  }
  save();
  return true;
}

export function setEmbedding(nodeId, vector) {
  const node = getNode(nodeId);
  if (!node || !vector) return null;
  node.embedding = packVector(vector);
  save();
  return node;
}

export function getEmbedding(node) {
  return node?.embedding ? unpackVector(node.embedding) : null;
}

export function addEpisode({ role, text, nodeIds = [] }) {
  const ep = {
    id: id('ep'),
    role,
    text: String(text || '').slice(0, 8000),
    ts: new Date().toISOString(),
    nodeIds,
  };
  state.episodes.push(ep);
  // Keep the transcript bounded; the graph is the long-term memory, not this log.
  if (state.episodes.length > 2000) state.episodes = state.episodes.slice(-2000);
  save();
  return ep;
}

export function recentEpisodes(limit = 20) {
  return state.episodes.slice(-limit);
}

export function replaceAll(next) {
  state = {
    ...structuredClone(EMPTY),
    ...next,
    nodes: next.nodes || [],
    edges: next.edges || [],
    episodes: next.episodes || [],
  };
  reindex();
  save();
  return snapshot();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export function packVector(vec) {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

export function unpackVector(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Buffer may be a view into a larger pool — copy so the Float32Array is aligned.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function dataFile() {
  return FILE();
}

export function fileExistsSync() {
  return fs.existsSync(FILE());
}
