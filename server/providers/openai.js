import OpenAI from 'openai';
import { config } from '../config.js';
import { toOpenAITools, runTool } from '../tools.js';

let client = null;
function getClient() {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env or switch BRAIN_PROVIDER to anthropic.');
  }
  client ||= new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL });
  return client;
}

const MAX_TOOL_ROUNDS = 12;

/** Same contract as the Anthropic provider — see providers/anthropic.js. */
export async function streamChat({ system, history, userText, memoryContext, emit }) {
  const openai = getClient();

  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userText },
  ];
  if (memoryContext) {
    messages.push({ role: 'system', content: memoryContext });
  }

  const tools = toOpenAITools();
  let finalText = '';
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = await openai.chat.completions.create({
      model: config.openai.model,
      max_completion_tokens: config.openai.maxTokens,
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    });

    let content = '';
    let finishReason = null;
    let sawTextThisRound = false;
    /** @type {Map<number, {id: string, name: string, args: string}>} */
    const pendingCalls = new Map();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.input_tokens += chunk.usage.prompt_tokens || 0;
        usage.output_tokens += chunk.usage.completion_tokens || 0;
        usage.cache_read_input_tokens += chunk.usage.prompt_tokens_details?.cached_tokens || 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta?.content) {
        if (!sawTextThisRound) {
          sawTextThisRound = true;
          emit('text_start', {});
        }
        content += delta.content;
        finalText += delta.content;
        emit('text', { delta: delta.content });
      }

      // Tool calls arrive as fragments keyed by index; name lands once, the
      // JSON arguments arrive a few characters at a time.
      for (const tc of delta?.tool_calls || []) {
        const slot = pendingCalls.get(tc.index) || { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) {
          slot.name = tc.function.name;
          emit('tool_start', { name: slot.name });
        }
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pendingCalls.set(tc.index, slot);
      }
    }

    if (finishReason !== 'tool_calls' || pendingCalls.size === 0) {
      return { text: finalText, usage, stopped: finishReason || 'stop' };
    }

    const calls = [...pendingCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    });

    for (const call of calls) {
      let input = {};
      let parseError = null;
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch (err) {
        parseError = `Could not parse arguments as JSON: ${err.message}`;
      }

      emit('tool_call', { name: call.name, input });

      let outcome;
      if (parseError) {
        outcome = { result: { error: parseError }, events: [], isError: true };
      } else {
        try {
          outcome = await runTool(call.name, input);
        } catch (err) {
          outcome = { result: { error: err.message }, events: [], isError: true };
        }
      }
      for (const ev of outcome.events) emit(ev.type, ev);
      emit('tool_result', { name: call.name, ok: !outcome.isError, result: outcome.result });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(outcome.result),
      });
    }
  }

  emit('error', { message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without finishing.` });
  return { text: finalText, usage, stopped: 'max_rounds' };
}

export function toHistory(episodes) {
  return episodes
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({ role: e.role, content: e.text }))
    .filter((m) => m.content.trim().length > 0);
}

/** Text-to-speech for the premium voice path. Returns an audio Buffer. */
export async function speak(text, { voice, format = 'mp3' } = {}) {
  const openai = getClient();
  const res = await openai.audio.speech.create({
    model: config.openai.ttsModel,
    voice: voice || config.openai.ttsVoice,
    input: text.slice(0, 4000),
    response_format: format,
  });
  return Buffer.from(await res.arrayBuffer());
}
