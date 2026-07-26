import Anthropic from '@anthropic-ai/sdk';
import { config, supportsMidConversationSystem } from '../config.js';
import { toAnthropicTools, runTool } from '../tools.js';

let client = null;
function getClient() {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env or switch BRAIN_PROVIDER to openai.');
  }
  client ||= new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseURL });
  return client;
}

const MAX_TOOL_ROUNDS = 12;

/**
 * Streams a full agentic turn: text + thinking deltas out, tool calls executed
 * server-side, looping until the model stops asking for tools.
 *
 * @param {object} opts
 * @param {string} opts.system         Stable system prompt (prompt-cached).
 * @param {Array}  opts.history        Prior turns as [{role, content}].
 * @param {string} opts.userText       This turn's user message.
 * @param {string} opts.memoryContext  Retrieved memories for this turn.
 * @param {(event: string, data: object) => void} opts.emit  SSE sink.
 */
export async function streamChat({ system, history, userText, memoryContext, emit }) {
  const anthropic = getClient();
  const model = config.anthropic.model;

  const messages = [...history, { role: 'user', content: userText }];

  if (memoryContext) {
    if (supportsMidConversationSystem(model)) {
      // Operator-authority channel that sits *after* the cached history, so
      // injecting fresh memories doesn't invalidate the cached prefix.
      messages.push({ role: 'system', content: memoryContext });
    } else {
      messages[messages.length - 1] = {
        role: 'user',
        content: `${userText}\n\n<memory_context>\n${memoryContext}\n</memory_context>`,
      };
    }
  }

  const tools = toAnthropicTools();
  let finalText = '';
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = anthropic.messages.stream({
      model,
      max_tokens: config.anthropic.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      // Adaptive thinking is on by default for Opus 5; asking for a summary is
      // what makes it visible. `display: "omitted"` would stream empty blocks.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: config.anthropic.effort },
      tools,
      messages,
    });

    let sawTextThisRound = false;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'thinking') emit('thinking_start', {});
        if (event.content_block.type === 'tool_use') {
          emit('tool_start', { name: event.content_block.name });
        }
      } else if (event.type === 'content_block_delta') {
        const d = event.delta;
        if (d.type === 'text_delta') {
          if (!sawTextThisRound) {
            sawTextThisRound = true;
            emit('text_start', {});
          }
          finalText += d.text;
          emit('text', { delta: d.text });
        } else if (d.type === 'thinking_delta') {
          emit('thinking', { delta: d.thinking });
        }
      } else if (event.type === 'content_block_stop') {
        // no-op; block types are handled on start/delta
      }
    }

    const message = await stream.finalMessage();
    accumulateUsage(usage, message.usage);

    if (message.stop_reason === 'refusal') {
      emit('error', {
        message:
          'Claude declined that request. Rephrase it, or set BRAIN_PROVIDER=openai to route this one elsewhere.',
        category: message.stop_details?.category || null,
      });
      return { text: finalText, usage, stopped: 'refusal' };
    }

    if (message.stop_reason !== 'tool_use') {
      return { text: finalText, usage, stopped: message.stop_reason };
    }

    // Echo the assistant turn back verbatim — thinking blocks and tool_use
    // blocks must survive unmodified or the next request is rejected.
    messages.push({ role: 'assistant', content: message.content });

    const toolResults = [];
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      emit('tool_call', { name: block.name, input: block.input });
      let outcome;
      try {
        outcome = await runTool(block.name, block.input);
      } catch (err) {
        outcome = { result: { error: err.message }, events: [], isError: true };
      }
      for (const ev of outcome.events) emit(ev.type, ev);
      emit('tool_result', { name: block.name, ok: !outcome.isError, result: outcome.result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(outcome.result),
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }

    // All results for a parallel batch go back in ONE user message.
    messages.push({ role: 'user', content: toolResults });
  }

  emit('error', { message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without finishing.` });
  return { text: finalText, usage, stopped: 'max_rounds' };
}

function accumulateUsage(acc, u) {
  if (!u) return;
  acc.input_tokens += u.input_tokens || 0;
  acc.output_tokens += u.output_tokens || 0;
  acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
}

/** Convert stored episodes into Anthropic message history. */
export function toHistory(episodes) {
  return episodes
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({ role: e.role, content: e.text }))
    .filter((m) => m.content.trim().length > 0);
}
