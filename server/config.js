import 'dotenv/config';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const env = process.env;

/** Is Claude Code installed locally? If so a Max/Pro plan can drive this. */
function hasClaudeCode() {
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return probe.status === 0 && !!probe.stdout.trim();
  } catch {
    return false;
  }
}

function pickProvider() {
  const explicit = (env.BRAIN_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'claude') return 'anthropic';
  if (explicit === 'openai' || explicit === 'chatgpt') return 'openai';
  // Runs on a Claude Pro/Max subscription via the locally authenticated
  // Claude Code, rather than on separately-billed API credits.
  if (explicit === 'claude-code' || explicit === 'subscription' || explicit === 'max') return 'claude-code';

  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  // No keys configured. If Claude Code is installed, the user almost certainly
  // has a subscription — use it rather than demanding an API key they may not
  // want to buy. This is what makes a fresh clone work with no .env at all.
  if (hasClaudeCode()) return 'claude-code';
  return 'anthropic'; // nothing available; the UI explains how to fix it
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

  claudeCode: {
    // Empty means "whatever Claude Code is configured to use".
    model: env.CLAUDE_CODE_MODEL || '',
    effort: env.CLAUDE_CODE_EFFORT || '',
    maxTurns: Number(env.CLAUDE_CODE_MAX_TURNS || 16),
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
  // The subscription path authenticates through the local Claude Code login,
  // so there is no key for this server to hold.
  const hasKey =
    p === 'claude-code' ? true : p === 'anthropic' ? !!config.anthropic.apiKey : !!config.openai.apiKey;
  const model =
    p === 'claude-code'
      ? config.claudeCode.model || 'claude code (subscription)'
      : p === 'anthropic'
        ? config.anthropic.model
        : config.openai.model;
  return {
    provider: p,
    model,
    hasKey,
    billing: p === 'claude-code' ? 'claude subscription' : 'api credits',
    // Embeddings and premium voice ride on the OpenAI key regardless of brain.
    embeddings: config.openai.apiKey ? 'openai' : 'local',
    voice: config.openai.apiKey ? 'openai+browser' : 'browser',
    brainName: config.brainName,
  };
}
