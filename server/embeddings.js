import OpenAI from 'openai';
import { config } from './config.js';

/**
 * Embeddings are optional. With an OpenAI key we use real vectors; without one
 * we fall back to a deterministic hashed character-trigram vector. The fallback
 * is not semantic, but it is stable, free, and offline — and recall blends it
 * with BM25 lexical scoring, which carries most of the weight anyway.
 */

const LOCAL_DIMS = 384;
let client = null;

function openai() {
  if (!config.openai.apiKey) return null;
  // Pass baseURL explicitly rather than relying on the SDK reading the env var,
  // so pointing at a gateway works the same way it does for the chat provider.
  client ||= new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL });
  return client;
}

export function embeddingMode() {
  return config.openai.apiKey ? 'openai' : 'local';
}

export function textForNode(node) {
  return [node.label, node.type, node.summary, (node.tags || []).join(' '), node.content]
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}

export async function embed(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];
  const api = openai();
  if (!api) return list.map(localEmbed);
  try {
    const res = await api.embeddings.create({
      model: config.openai.embedModel,
      input: list.map((t) => (t && t.trim()) || ' '),
      // Ask for plain floats. The SDK defaults to base64 and decodes it itself,
      // which is fine against OpenAI but silently yields zero vectors from an
      // OpenAI-compatible server that answers with a float array regardless —
      // and a silently zeroed vector poisons recall with no error anywhere.
      encoding_format: 'float',
    });
    // The API preserves input order, but sort by index defensively.
    const vectors = res.data
      .sort((a, b) => a.index - b.index)
      .map((d) => Float32Array.from(d.embedding || []));

    // Belt and braces for the same failure mode: a vector that is empty or all
    // zeros carries no signal, so prefer the offline one that at least works.
    if (vectors.length !== list.length || vectors.some(isDegenerate)) {
      console.warn('[embeddings] the endpoint returned unusable vectors; using local vectors');
      return list.map(localEmbed);
    }
    return vectors;
  } catch (err) {
    console.warn(`[embeddings] OpenAI call failed (${err.message}); using local vectors`);
    return list.map(localEmbed);
  }
}

function isDegenerate(vec) {
  if (!vec.length) return true;
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] !== 0 && Number.isFinite(vec[i])) return false;
  }
  return true;
}

export async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}

/** FNV-1a over character trigrams, folded into a fixed-width normalized vector. */
export function localEmbed(text) {
  const vec = new Float32Array(LOCAL_DIMS);
  const clean = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return vec;

  const words = clean.split(' ');
  for (const word of words) {
    bump(vec, `w:${word}`, 1.0);
    const padded = ` ${word} `;
    for (let i = 0; i < padded.length - 2; i++) {
      bump(vec, padded.slice(i, i + 3), 0.5);
    }
  }
  let mag = 0;
  for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= mag;
  return vec;
}

function bump(vec, token, weight) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % LOCAL_DIMS;
  // Sign from a second hash bit so unrelated tokens can cancel instead of only adding.
  vec[idx] += weight * ((h & 0x10000) ? 1 : -1);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}
