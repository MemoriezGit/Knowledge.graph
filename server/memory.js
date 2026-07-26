import * as store from './store.js';
import { embed, embedOne, cosine, textForNode, embeddingMode } from './embeddings.js';

/**
 * Hybrid recall: vector similarity + BM25 lexical + recency + importance,
 * then one hop of graph expansion so neighbours of a strong hit come along.
 *
 * No single signal is trustworthy on its own here — vectors miss exact names,
 * lexical misses paraphrase, and recency alone is just a timeline.
 */

const WEIGHTS = {
  vector: 0.45,
  lexical: 0.35,
  recency: 0.1,
  importance: 0.1,
  neighborBonus: 0.35, // multiplier applied to a neighbour's parent score
};

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have how i if in into is it its of on or that the their then there these they this to was were what when where which who why will with you your me my we our`.split(
    /\s+/,
  ),
);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-']+|[-']+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** BM25 over the live node set. Rebuilt per query — fine at personal-brain scale. */
function bm25Scores(queryTokens, nodes) {
  const k1 = 1.5;
  const b = 0.75;
  const docs = nodes.map((n) => {
    const fieldText = `${n.label} ${n.label} ${(n.tags || []).join(' ')} ${n.summary} ${n.content}`;
    return tokenize(fieldText);
  });
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1) || 1;

  const df = new Map();
  const termFreqs = docs.map((doc) => {
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });

  const N = docs.length || 1;
  const scores = new Float64Array(nodes.length);
  for (const qt of new Set(queryTokens)) {
    const n = df.get(qt) || 0;
    if (!n) continue;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    for (let i = 0; i < nodes.length; i++) {
      const f = termFreqs[i].get(qt) || 0;
      if (!f) continue;
      const norm = f * (k1 + 1) / (f + k1 * (1 - b + b * (docs[i].length / avgLen)));
      scores[i] += idf * norm;
    }
  }
  const max = Math.max(...scores, 0.000001);
  return [...scores].map((s) => s / max);
}

function recencyScore(node) {
  const last = Date.parse(node.lastAccessedAt || node.updatedAt || node.createdAt);
  if (!Number.isFinite(last)) return 0;
  const days = (Date.now() - last) / 86400000;
  // Half-life of ~30 days. Old memories aren't worthless, just quieter.
  return Math.exp(-days / 43.28);
}

/** Ensure every live node has a current vector. Batched; safe to call often. */
export async function ensureEmbeddings({ limit = 128 } = {}) {
  const missing = store.liveNodes().filter((n) => !n.embedding).slice(0, limit);
  if (!missing.length) return 0;
  const vectors = await embed(missing.map(textForNode));
  missing.forEach((node, i) => {
    if (vectors[i]) store.setEmbedding(node.id, vectors[i]);
  });
  return missing.length;
}

export async function search(query, { limit = 8, types = null, expand = true } = {}) {
  const nodes = store.liveNodes().filter((n) => (types?.length ? types.includes(n.type) : true));
  if (!nodes.length) return [];

  const qTokens = tokenize(query);
  const lexical = bm25Scores(qTokens, nodes);

  await ensureEmbeddings({ limit: 64 });
  const qVec = await embedOne(query);

  const scored = nodes.map((node, i) => {
    const vec = store.getEmbedding(node);
    const vectorScore = vec ? Math.max(0, cosine(qVec, vec)) : 0;
    const score =
      WEIGHTS.vector * vectorScore +
      WEIGHTS.lexical * lexical[i] +
      WEIGHTS.recency * recencyScore(node) +
      WEIGHTS.importance * (node.importance ?? 0.5);
    return { node, score, vectorScore, lexicalScore: lexical[i], reason: 'direct' };
  });

  scored.sort((a, b) => b.score - a.score);
  let results = scored.slice(0, limit);

  if (expand && results.length) {
    const seen = new Set(results.map((r) => r.node.id));
    const added = [];
    for (const hit of results.slice(0, 3)) {
      for (const { node, via } of store.neighbors(hit.node.id, 1)) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        added.push({
          node,
          score: hit.score * WEIGHTS.neighborBonus * (via.weight ?? 0.6),
          reason: `linked to "${hit.node.label}" via ${via.rel}`,
        });
      }
    }
    added.sort((a, b) => b.score - a.score);
    results = results.concat(added.slice(0, Math.max(2, Math.ceil(limit / 2))));
  }

  for (const r of results) store.touchNode(r.node.id);
  return results;
}

/** Create nodes + edges in one shot. Labels are deduped against existing memory. */
export async function remember({ nodes = [], links = [] }) {
  const created = [];
  const merged = [];
  const labelToId = new Map();

  for (const raw of nodes) {
    if (!raw?.label) continue;
    const existing = store.findByLabel(raw.label);
    if (existing && sameish(existing.label, raw.label)) {
      const patch = {};
      if (raw.summary && raw.summary !== existing.summary) patch.summary = raw.summary;
      if (raw.content && !existing.content.includes(raw.content)) {
        patch.content = `${existing.content}\n\n${raw.content}`.trim().slice(0, 20000);
      }
      if (raw.importance != null) patch.importance = Math.max(existing.importance, raw.importance);
      if (raw.tags?.length) patch.tags = [...new Set([...(existing.tags || []), ...raw.tags])];
      const updated = Object.keys(patch).length ? store.updateNode(existing.id, patch) : existing;
      labelToId.set(norm(raw.label), updated.id);
      merged.push(updated);
    } else {
      const node = store.createNode(raw);
      labelToId.set(norm(raw.label), node.id);
      created.push(node);
    }
  }

  const edges = [];
  for (const link of links) {
    const from = resolveRef(link.from, labelToId);
    const to = resolveRef(link.to, labelToId);
    if (!from || !to) continue;
    const edge = store.createEdge({ from, to, rel: link.rel, weight: link.weight });
    if (edge) edges.push(edge);
  }

  const touched = [...created, ...merged];
  if (touched.length) {
    const vectors = await embed(touched.map(textForNode));
    touched.forEach((n, i) => vectors[i] && store.setEmbedding(n.id, vectors[i]));
  }

  return { created, merged, edges };
}

function resolveRef(ref, labelToId) {
  if (!ref) return null;
  const byLabelInBatch = labelToId.get(norm(ref));
  if (byLabelInBatch) return byLabelInBatch;
  const node = store.resolveNode(ref);
  return node?.id || null;
}

const norm = (s) => String(s).trim().toLowerCase();
const sameish = (a, b) => norm(a) === norm(b);

export function contextBlock(results) {
  if (!results.length) return 'No stored memories matched.';
  return results
    .map((r) => {
      const n = r.node;
      const links = store
        .edgesOf(n.id)
        .slice(0, 6)
        .map((e) => {
          const other = store.getNode(e.from === n.id ? e.to : e.from);
          if (!other || other.archived) return null;
          return `${e.from === n.id ? '→' : '←'} ${e.rel} ${other.label}`;
        })
        .filter(Boolean)
        .join('; ');
      const body = [n.summary, n.content].filter(Boolean).join(' — ').slice(0, 600);
      return [
        `[${n.id}] ${n.label} (${n.type}, importance ${n.importance.toFixed(2)}, score ${r.score.toFixed(2)}${
          r.reason !== 'direct' ? `, ${r.reason}` : ''
        })`,
        body ? `  ${body}` : null,
        links ? `  links: ${links}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

export function health() {
  return { ...store.stats(), embeddings: embeddingMode() };
}
