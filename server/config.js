import 'dotenv/config';
import path from 'node:path';

const env = process.env;

function pickProvider() {
  const explicit = (env.BRAIN_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'claude') return 'anthropic';
  if (explicit === 'openai' || explicit === 'chatgpt') return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'anthropic'; // default target; server reports "no key" until one is set
}

/**
 * Models that accept a mid-conversation `{role: "system"}` message in `messages`.
 * On these we inject retrieved memories after the cached history instead of
 * rebuilding the top-level system prompt, so the prompt cache survives.
 */
const MID_CONVERSATION_SYSTEM_MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-mythos-5',
];

export const config = {
  provider: pickProvider(),

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    // Set to point at a proxy or gateway; the SDK also honours ANTHROPIC_BASE_URL.
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    model: env.ANTHROPIC_MODEL || 'claude-opus-5',
    effort: env.ANTHROPIC_EFFORT || 'high',
    maxTokens: Number(env.ANTHROPIC_MAX_TOKENS || 32000),
  },

  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    // Any OpenAI-compatible endpoint works here — Azure, a local model server, etc.
    baseURL: env.OPENAI_BASE_URL || undefined,
    model: env.OPENAI_MODEL || 'gpt-4o',
    embedModel: env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    ttsModel: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: env.OPENAI_TTS_VOICE || 'alloy',
    maxTokens: Number(env.OPENAI_MAX_TOKENS || 8000),
  },

  port: Number(env.PORT || 8787),
  dataDir: path.resolve(process.cwd(), env.DATA_DIR || './data'),
  brainName: env.BRAIN_NAME || 'Atlas',
  isProduction: env.NODE_ENV === 'production',
};

export function supportsMidConversationSystem(model) {
  return MID_CONVERSATION_SYSTEM_MODELS.includes(model);
}

export function providerStatus() {
  const p = config.provider;
  const hasKey = p === 'anthropic' ? !!config.anthropic.apiKey : !!config.openai.apiKey;
  return {
    provider: p,
    model: p === 'anthropic' ? config.anthropic.model : config.openai.model,
    hasKey,
    // Embeddings and premium voice ride on the OpenAI key regardless of brain.
    embeddings: config.openai.apiKey ? 'openai' : 'local',
    voice: config.openai.apiKey ? 'openai+browser' : 'browser',
    brainName: config.brainName,
  };
}
