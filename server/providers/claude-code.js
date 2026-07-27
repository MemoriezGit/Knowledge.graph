import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/**
 * Runs the brain on a **Claude Pro/Max subscription** instead of API credits.
 *
 * A Max plan does not grant Anthropic API access — that is billed separately
 * through the Console. What it does grant is Claude Code, and the Claude Agent
 * SDK is Claude Code as a library, inheriting whatever credentials the local
 * CLI is logged in with. So `claude /login` once with your subscription and
 * this provider runs the whole app on it, keeping the 3D view and the voice.
 *
 * Memory tools reach it through our own MCP server, so there is exactly one
 * implementation of them shared with Claude Desktop and ChatGPT.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(__dirname, '..', '..', 'mcp', 'server.js');

const TOOL_NAMES = [
  'recall_memory',
  'remember',
  'link_nodes',
  'update_node',
  'forget',
  'get_neighbors',
  'focus_view',
  'graph_stats',
];

const ALLOWED = new Set(TOOL_NAMES.map((n) => `mcp__memory__${n}`));

let sdk = null;
async function loadSdk() {
  if (sdk) return sdk;
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new Error(
      'The Claude Agent SDK is not installed. Run `npm install` — or switch BRAIN_PROVIDER to anthropic/openai.',
    );
  }
  return sdk;
}

export async function streamChat({ system, history, userText, memoryContext, emit }) {
  const { query } = await loadSdk();

  // The SDK has no separate history parameter, so prior turns are folded into
  // the prompt. The graph is the real long-term memory; this is just the
  // immediate conversational thread.
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
    .join('\n');

  const prompt = [
    transcript ? `<recent_conversation>\n${transcript}\n</recent_conversation>` : '',
    memoryContext ? `<memory>\n${memoryContext}\n</memory>` : '',
    `User: ${userText}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let finalText = '';
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let sawText = false;
  const toolNames = new Map(); // tool_use id -> friendly name

  const response = query({
    prompt,
    options: {
      model: config.claudeCode.model || undefined,
      // Replace Claude Code's coding-agent persona entirely — this is a
      // second brain that speaks, not a software engineer.
      systemPrompt: system,
      // Don't inherit the user's CLAUDE.md, settings, or project config; this
      // process is not their codebase.
      settingSources: [],
      mcpServers: {
        memory: {
          type: 'stdio',
          command: process.execPath,
          args: [MCP_ENTRY, '--app', `http://127.0.0.1:${config.port}`],
        },
      },
      // Drop Claude Code's built-in toolset entirely. This agent has no
      // business reading files or running commands — and leaving it on means
      // MCP tools get deferred behind ToolSearch, costing a round trip and
      // surfacing an irrelevant "ToolSearch" step in the UI.
      tools: [],
      allowedTools: TOOL_NAMES.map((n) => `mcp__memory__${n}`),
      // An explicit allowlist rather than `bypassPermissions`. That mode maps
      // to --dangerously-skip-permissions, which Claude Code refuses to run as
      // root — so it breaks outright in a container. This is also the safer
      // posture: memory tools are auto-approved because they are ours and
      // reversible, and anything else is denied rather than skipped.
      permissionMode: 'default',
      canUseTool: async (toolName) =>
        ALLOWED.has(toolName)
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              message: `${toolName} is not available here. This agent only manages the knowledge graph.`,
            },
      includePartialMessages: true,
      maxTurns: config.claudeCode.maxTurns,
      effort: config.claudeCode.effort || undefined,
    },
  });

  try {
    for await (const message of response) {
      if (message.type === 'stream_event') {
        // Same raw event shape as the Messages API, so the deltas are handled
        // exactly as in providers/anthropic.js.
        const event = message.event;
        if (event.type === 'content_block_delta') {
          const d = event.delta;
          if (d.type === 'text_delta') {
            if (!sawText) {
              sawText = true;
              emit('text_start', {});
            }
            finalText += d.text;
            emit('text', { delta: d.text });
          } else if (d.type === 'thinking_delta' && d.thinking) {
            // Claude Code omits thinking text by default; only surface it when
            // there is something to read, or the UI shows an empty block.
            emit('thinking', { delta: d.thinking });
          }
        }
        continue;
      }

      if (message.type === 'assistant') {
        for (const block of message.message?.content || []) {
          if (block.type !== 'tool_use') continue;
          // Anything that isn't one of our memory tools is Claude Code
          // internals; showing it would just confuse the user.
          if (!ALLOWED.has(block.name)) continue;
          const name = friendly(block.name);
          toolNames.set(block.id, name);
          emit('tool_start', { name });
          emit('tool_call', { name, input: block.input });
        }
        accumulate(usage, message.message?.usage);
        continue;
      }

      if (message.type === 'user') {
        // Tool results come back as a synthetic user turn, and carry only the
        // id — map it back so the UI can close the right pill.
        for (const block of message.message?.content || []) {
          if (block.type !== 'tool_result') continue;
          const name = toolNames.get(block.tool_use_id);
          if (!name) continue; // a result for a tool we chose not to surface
          emit('tool_result', { name, ok: !block.is_error, result: summarise(block.content) });
          // The MCP server already broadcast the graph change; nudge this
          // viewer to reload so the new nodes appear immediately.
          emit('graph_delta', { type: 'graph_delta' });
        }
        continue;
      }

      if (message.type === 'result') {
        accumulate(usage, message.usage);
        if (message.subtype && message.subtype !== 'success') {
          emit('error', { message: describeFailure(message) });
        }
        if (!finalText && typeof message.result === 'string') {
          finalText = message.result;
          emit('text', { delta: message.result });
        }
      }
    }
  } catch (err) {
    throw new Error(translateError(err));
  }

  return { text: finalText, usage, stopped: 'end_turn' };
}

/** `mcp__memory__remember` reads badly in a UI; the bare tool name doesn't. */
function friendly(name) {
  return String(name || '').replace(/^mcp__memory__/, '');
}

function summarise(content) {
  if (typeof content === 'string') return safeParse(content);
  if (Array.isArray(content)) {
    const text = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
    return safeParse(text);
  }
  return content ?? {};
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text: String(text).slice(0, 400) };
  }
}

function accumulate(acc, u) {
  if (!u) return;
  acc.input_tokens += u.input_tokens || 0;
  acc.output_tokens += u.output_tokens || 0;
  acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
}

function describeFailure(message) {
  if (message.subtype === 'error_max_turns') return 'Stopped after the maximum number of tool rounds.';
  if (String(message.subtype).includes('usage')) {
    return 'Your Claude plan usage limit was reached. It resets on a rolling window — or switch BRAIN_PROVIDER to anthropic to use API credits.';
  }
  return `Claude Code ended with: ${message.subtype}`;
}

function translateError(err) {
  const msg = err?.message || String(err);
  if (/not logged in|authentication|unauthorized|401/i.test(msg)) {
    return 'Claude Code is not logged in. Run `claude` in a terminal, sign in with your Pro/Max subscription, then retry.';
  }
  if (/ENOENT|not found/i.test(msg) && /claude/i.test(msg)) {
    return 'The Claude Code executable was not found. Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude` once to sign in.';
  }
  return msg;
}

/** History for this provider is plain text, same as the others. */
export function toHistory(episodes) {
  return episodes
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({ role: e.role, content: e.text }))
    .filter((m) => m.content.trim().length > 0);
}
