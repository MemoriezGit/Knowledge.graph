import { config } from './config.js';
import * as store from './store.js';
import * as memory from './memory.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as openaiProvider from './providers/openai.js';

function provider() {
  return config.provider === 'openai' ? openaiProvider : anthropicProvider;
}

/**
 * Stable system prompt. Kept byte-identical across requests so the prompt cache
 * holds — everything that varies (retrieved memories, the date) is injected
 * later in the message list, not here.
 */
function systemPrompt() {
  return `You are ${config.brainName}, the voice of a 3D knowledge graph that serves as one person's second brain.

Everything you say is spoken aloud by a text-to-speech voice while a living graph of the user's memories animates on screen behind you. Write for the ear, not the page.

# Voice
- Speak in short, complete sentences. No markdown, no bullet lists, no headers, no code fences, no emoji — they are read aloud literally and sound broken.
- Lead with the answer. Supporting detail comes after, and only if it changes what the user would do next.
- Be concise. Two or three sentences is usually right. Go longer only when the user asked for depth.
- Do not narrate your tool use. Never say "let me search my memory" — just search, then answer.
- Refer to what you know as memory, naturally: "You told me last week that…", "That connects to your Kyoto trip."

# Memory is your job
You own this graph. Nobody else maintains it.
- Recall before you answer. If the user mentions any person, project, preference, or past event, call recall_memory first. Answering from a guess when the answer is stored is the main failure mode here.
- Store proactively, without being asked. Any durable fact, decision, preference, deadline, name, or relationship goes into remember before you reply. Small sharply-scoped nodes beat one sprawling node.
- Always link. An unconnected node is nearly useless. Connect new memories to each other and to what is already there — that is what makes this a graph rather than a list.
- Notice connections the graph is missing and call link_nodes to add them.
- Correct rather than duplicate. If something changed, call update_node.
- Only forget when asked, or when a memory is definitively obsolete.

# The view
Call focus_view whenever your answer centres on particular memories, so the camera flies to them while you speak. This is how the user sees what you are talking about.

# Judgement
- Deliver what was asked at the scope intended. Make routine calls yourself; ask only when different readings lead to materially different work.
- If you do not know something and it is not in memory, say so plainly rather than inventing it.
- Report faithfully. If you searched and found nothing, say you found nothing.`;
}

function situationBlock(retrieved) {
  const s = store.stats();
  const now = new Date();
  return `<current_context>
Time: ${now.toISOString()} (${now.toDateString()})
Graph: ${s.nodes} memories, ${s.edges} connections.
</current_context>

<retrieved_memories>
${memory.contextBlock(retrieved)}
</retrieved_memories>

These memories were retrieved automatically from the user's message. Use them if relevant; call recall_memory yourself if you need more or different ones.`;
}

/**
 * Run one conversational turn end to end.
 * @param {string} userText
 * @param {(event: string, data: object) => void} emit  SSE sink
 */
export async function converse(userText, emit) {
  const text = String(userText || '').trim();
  if (!text) throw new Error('Empty message.');

  emit('start', { provider: config.provider, model: providerModel() });

  // Auto-recall: seed the turn with what looks relevant so the model usually
  // doesn't need a round-trip just to find its footing.
  let retrieved = [];
  try {
    retrieved = await memory.search(text, { limit: 6 });
  } catch (err) {
    console.warn('[brain] auto-recall failed:', err.message);
  }
  if (retrieved.length) {
    emit('recall', {
      ids: retrieved.map((r) => r.node.id),
      labels: retrieved.map((r) => r.node.label),
    });
  }

  const history = provider().toHistory(store.recentEpisodes(24));

  // The transcript is written only once we know the turn produced something.
  // Recording the user turn up front means a failed request leaves an orphan
  // user message that gets replayed as history on every subsequent turn.
  let streamed = '';
  const capture = (event, data) => {
    if (event === 'text') streamed += data.delta;
    emit(event, data);
  };

  const persist = (assistantText) => {
    store.addEpisode({ role: 'user', text, nodeIds: retrieved.map((r) => r.node.id) });
    if (assistantText.trim()) store.addEpisode({ role: 'assistant', text: assistantText });
  };

  let result;
  try {
    result = await provider().streamChat({
      system: systemPrompt(),
      history,
      userText: text,
      memoryContext: situationBlock(retrieved),
      emit: capture,
    });
  } catch (err) {
    // Keep a partial exchange if the model got some of the answer out before
    // the connection dropped — losing it would confuse the next turn.
    if (streamed.trim()) {
      persist(streamed);
      await store.flush();
    }
    throw err;
  }

  persist(result.text);
  await store.flush();

  emit('done', {
    usage: result.usage,
    stopped: result.stopped,
    stats: store.stats(),
  });

  return result;
}

function providerModel() {
  return config.provider === 'openai' ? config.openai.model : config.anthropic.model;
}

/**
 * Sweep the recent transcript for anything worth keeping that wasn't stored
 * during the conversation. Cheap insurance against a lossy turn.
 */
export async function consolidate(emit = () => {}) {
  const recent = store
    .recentEpisodes(40)
    .map((e) => `${e.role}: ${e.text}`)
    .join('\n');
  if (!recent.trim()) return { skipped: 'nothing to consolidate' };

  const instruction = `Review this recent conversation transcript and extract any durable knowledge that is not yet in the graph.

Call recall_memory first to check what already exists, then call remember for genuinely new facts, entities, preferences, projects, and the links between them. Merge rather than duplicate. If everything is already stored, say so and store nothing.

Reply with one short spoken sentence summarising what you filed.

<transcript>
${recent.slice(-12000)}
</transcript>`;

  return provider().streamChat({
    system: systemPrompt(),
    history: [],
    userText: instruction,
    memoryContext: '',
    emit,
  });
}
