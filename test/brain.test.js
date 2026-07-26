import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockAnthropic, mockOpenAI } from './mocks.js';

/**
 * End-to-end tests for the memory layer and both provider tool loops.
 *
 * Config is read from the environment at import time, so the mock servers are
 * started and the env is set *before* any application module is imported.
 * Everything below therefore uses dynamic import.
 */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-test-'));

const anthropicMock = await mockAnthropic([
  [
    { type: 'thinking', chunks: ['They mention a tutor. ', 'Worth storing and linking.'] },
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'remember',
      // Deliberately split mid-token: the loop must reassemble this into valid JSON.
      jsonChunks: [
        '{"nodes":[{"label":"Ana","type":"per',
        'son","summary":"Portuguese tutor"},{"label":"Portuguese","type":"project","summary":"Learning it"}],',
        '"links":[{"from":"Ana","rel":"teaches","to":"Portuguese"}]}',
      ],
    },
  ],
  [{ type: 'text', chunks: ['Filed. ', 'Ana teaches you Portuguese.'] }],
]);

const openaiMock = await mockOpenAI([
  {
    text: ['Got it. '],
    toolCalls: [
      {
        id: 'call_1',
        name: 'remember',
        argChunks: ['{"nodes":[{"label":"Espresso', '","type":"preference","summary":"Double ristretto"}]}'],
      },
    ],
  },
  { text: ['Noted. ', 'You take a double ristretto.'] },
]);

// config.js reads the environment once, at import time — so everything must be
// set before the first application import. Mutating process.env afterwards has
// no effect, and a `?fresh=` query only busts the cache for that one file, not
// for the config module it depends on.
process.env.DATA_DIR = dataDir;
process.env.BRAIN_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ANTHROPIC_BASE_URL = anthropicMock.url;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_BASE_URL = openaiMock.url;
process.env.BRAIN_NAME = 'TestBrain';

const store = await import('../server/store.js');
const memory = await import('../server/memory.js');
const { runTool } = await import('../server/tools.js');
const anthropicProvider = await import('../server/providers/anthropic.js');
const openaiProvider = await import('../server/providers/openai.js');
const brain = await import('../server/brain.js');

await store.load();

test.after(async () => {
  await anthropicMock.close();
  await openaiMock.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

// ── store ────────────────────────────────────────────────────────────────────

test('store: create, link, and traverse', () => {
  const a = store.createNode({ label: 'Kyoto trip', type: 'event', summary: 'Two weeks in April', importance: 0.6 });
  const b = store.createNode({ label: 'Ryokan booking', type: 'task', summary: 'Still to book' });
  const edge = store.createEdge({ from: a.id, to: b.id, rel: 'requires', weight: 0.9 });

  assert.ok(edge, 'edge created');
  assert.equal(store.neighbors(a.id, 1).length, 1);
  assert.equal(store.neighbors(a.id, 1)[0].node.id, b.id);
  assert.equal(store.resolveNode('Kyoto trip').id, a.id, 'resolves by label');
  assert.equal(store.resolveNode(a.id).id, a.id, 'resolves by id');
});

test('store: rejects self-links and dedupes identical edges', () => {
  const n = store.resolveNode('Kyoto trip');
  assert.equal(store.createEdge({ from: n.id, to: n.id, rel: 'loops' }), null);

  const before = store.allEdges().length;
  store.createEdge({ from: n.id, to: store.resolveNode('Ryokan booking').id, rel: 'requires', weight: 0.5 });
  assert.equal(store.allEdges().length, before, 'duplicate edge merged, not appended');
});

test('store: archiving hides from live set but keeps the record', () => {
  const n = store.createNode({ label: 'Temporary', type: 'fact', summary: 'goes away' });
  store.forgetNode(n.id);
  assert.equal(store.liveNodes().some((x) => x.id === n.id), false, 'gone from live');
  assert.ok(store.getNode(n.id), 'still recoverable');
  assert.equal(store.getNode(n.id).archived, true);
});

test('store: concurrent saves share one promise and all resolve', async () => {
  // Regression: minting a promise per save() orphaned the previous one, so an
  // awaited save could hang forever.
  store.createNode({ label: 'Save A', type: 'fact', summary: 'a' });
  const p1 = store.save();
  store.createNode({ label: 'Save B', type: 'fact', summary: 'b' });
  const p2 = store.save();

  const settled = await Promise.race([
    Promise.all([p1, p2]).then(() => 'ok'),
    new Promise((r) => setTimeout(() => r('timeout'), 3000)),
  ]);
  assert.equal(settled, 'ok', 'both debounced saves resolved');
});

test('store: persists across a reload', async () => {
  await store.flush();
  const before = store.stats();
  const reloaded = await store.load();
  assert.equal(reloaded.stats.nodes, before.nodes);
  assert.equal(reloaded.stats.edges, before.edges);
  assert.ok(store.resolveNode('Kyoto trip'), 'node survived reload');
});

// ── memory ───────────────────────────────────────────────────────────────────

test('memory: remember merges same-label nodes instead of duplicating', async () => {
  const first = await memory.remember({
    nodes: [{ label: 'Sourdough', type: 'project', summary: 'A starter', importance: 0.4 }],
  });
  assert.equal(first.created.length, 1);

  const second = await memory.remember({
    nodes: [{ label: 'sourdough', type: 'project', summary: 'Named Bubbles', importance: 0.7, tags: ['baking'] }],
  });
  assert.equal(second.created.length, 0, 'no duplicate created');
  assert.equal(second.merged.length, 1, 'merged into the existing node');

  const node = store.resolveNode('Sourdough');
  assert.equal(node.importance, 0.7, 'importance takes the higher value');
  assert.deepEqual(node.tags, ['baking']);
});

test('memory: links resolve against nodes created in the same call', async () => {
  const { created, edges } = await memory.remember({
    nodes: [
      { label: 'Marta', type: 'person', summary: 'Friend in Lisbon' },
      { label: 'Lisbon', type: 'entity', summary: 'City in Portugal' },
    ],
    links: [{ from: 'Marta', rel: 'lives_in', to: 'Lisbon', weight: 0.9 }],
  });
  assert.equal(created.length, 2);
  assert.equal(edges.length, 1, 'edge resolved from labels created in this batch');
  assert.equal(edges[0].rel, 'lives_in');
});

test('memory: recall ranks the relevant node first and expands the graph', async () => {
  const results = await memory.search('ryokan booking for the kyoto trip', { limit: 3 });
  assert.ok(results.length > 0, 'found something');
  const labels = results.map((r) => r.node.label);
  assert.ok(
    labels[0] === 'Ryokan booking' || labels[0] === 'Kyoto trip',
    `expected a Kyoto-related hit first, got ${labels.join(', ')}`,
  );
  assert.ok(labels.includes('Kyoto trip') && labels.includes('Ryokan booking'), 'linked neighbour pulled in');
});

test('memory: recall strengthens what it returns', async () => {
  const before = store.resolveNode('Kyoto trip').importance;
  await memory.search('kyoto', { limit: 2 });
  assert.ok(store.resolveNode('Kyoto trip').importance > before, 'importance rose after recall');
});

// ── tools ────────────────────────────────────────────────────────────────────

test('tools: every tool dispatches and emits its UI events', async () => {
  // Create this test's own fixtures rather than relying on what earlier tests
  // happened to leave behind.
  await runTool('remember', {
    nodes: [
      { label: 'Tram 28', type: 'entity', summary: 'The scenic tram line through Lisbon' },
      { label: 'Pastel de nata', type: 'entity', summary: 'Portuguese custard tart' },
    ],
  });

  const recall = await runTool('recall_memory', { query: 'kyoto' });
  assert.ok(recall.result.found > 0);
  assert.ok(recall.events.some((e) => e.type === 'focus'), 'recall focuses the view');

  const linked = await runTool('link_nodes', { from: 'Tram 28', rel: 'runs_through', to: 'Lisbon' });
  assert.match(linked.result.linked || '', /Tram 28 .* Lisbon/);
  assert.ok(linked.events.some((e) => e.type === 'graph_delta'), 'linking redraws the graph');

  const neighbors = await runTool('get_neighbors', { id: 'Kyoto trip', depth: 1 });
  assert.equal(neighbors.result.center.label, 'Kyoto trip');
  assert.ok(neighbors.result.neighbors.length > 0);

  const updated = await runTool('update_node', { id: 'Marta', importance: 0.9 });
  assert.equal(updated.result.updated.label, 'Marta');
  assert.equal(store.resolveNode('Marta').importance, 0.9);

  const stats = await runTool('graph_stats', {});
  assert.ok(stats.result.nodes > 0);

  const focused = await runTool('focus_view', { node_ids: ['Marta', 'Lisbon'] });
  assert.equal(focused.result.focused, 2, 'resolves labels to ids');
});

test('tools: unresolvable references and unknown tools error without throwing', async () => {
  const missing = await runTool('get_neighbors', { id: 'no-such-node' });
  assert.equal(missing.isError, true);
  assert.match(missing.result.error, /No node matching/);

  const unknown = await runTool('definitely_not_a_tool', {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.result.error, /Unknown tool/);
});

// ── provider tool loops ──────────────────────────────────────────────────────

/** Collect every SSE event a turn emits, in order. */
function recorder() {
  const events = [];
  return { events, emit: (event, data) => events.push([event, data]) };
}

test('anthropic: streams thinking, reassembles a split tool call, and loops to an answer', async () => {
  const { events, emit } = recorder();
  const result = await anthropicProvider.streamChat({
    system: 'test system',
    history: [],
    userText: 'Ana is my Portuguese tutor.',
    memoryContext: '<current_context>test</current_context>',
    emit,
  });

  const names = events.map(([e]) => e);
  assert.ok(names.includes('thinking'), 'thinking deltas surfaced');
  assert.ok(names.includes('tool_call'), 'tool call surfaced');
  assert.ok(names.includes('tool_result'), 'tool result surfaced');

  const toolCall = events.find(([e]) => e === 'tool_call')[1];
  assert.equal(toolCall.name, 'remember');
  assert.equal(toolCall.input.nodes[0].label, 'Ana', 'fragmented JSON reassembled correctly');
  assert.equal(toolCall.input.links[0].rel, 'teaches');

  assert.equal(result.text, 'Filed. Ana teaches you Portuguese.');
  assert.equal(result.stopped, 'end_turn');
  assert.ok(result.usage.input_tokens > 0, 'usage accumulated across rounds');

  assert.ok(store.resolveNode('Ana'), 'the tool actually wrote to memory');
});

test('anthropic: request shape matches the API contract', () => {
  const [first, second] = anthropicMock.requests;

  assert.deepEqual(first.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(first.output_config.effort, 'high');
  assert.equal(first.system[0].cache_control.type, 'ephemeral', 'system prompt marked for caching');
  assert.equal('temperature' in first, false, 'no sampling params — they 400 on Opus 5');
  assert.equal('top_p' in first, false);
  assert.equal(first.tools.length, 8);

  // Mid-conversation system message must follow a user turn.
  assert.equal(first.messages.at(-2).role, 'user');
  assert.equal(first.messages.at(-1).role, 'system');

  // Round two echoes the assistant turn verbatim, then one user message
  // carrying every tool_result.
  const assistant = second.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'assistant turn echoed back');
  assert.ok(assistant.content.some((b) => b.type === 'thinking'), 'thinking block preserved unmodified');
  assert.ok(assistant.content.some((b) => b.type === 'tool_use'));

  const toolTurn = second.messages.at(-1);
  assert.equal(toolTurn.role, 'user');
  assert.ok(toolTurn.content.every((b) => b.type === 'tool_result'));
  assert.equal(toolTurn.content[0].tool_use_id, 'toolu_1');
});

test('anthropic: falls back to inline context on models without mid-conversation system', async () => {
  // claude-sonnet-5 rejects a system message inside `messages`; the context has
  // to ride along in the user turn instead.
  const { supportsMidConversationSystem } = await import('../server/config.js');
  assert.equal(supportsMidConversationSystem('claude-opus-5'), true);
  assert.equal(supportsMidConversationSystem('claude-sonnet-5'), false);
});

test('openai: reassembles fragmented tool args and completes the loop', async () => {
  const { events, emit } = recorder();
  const result = await openaiProvider.streamChat({
    system: 'test system',
    history: [{ role: 'user', content: 'earlier turn' }, { role: 'assistant', content: 'earlier reply' }],
    userText: 'I always order a double ristretto.',
    memoryContext: 'context',
    emit,
  });

  const toolCall = events.find(([e]) => e === 'tool_call')[1];
  assert.equal(toolCall.name, 'remember');
  assert.equal(toolCall.input.nodes[0].label, 'Espresso', 'fragmented JSON reassembled correctly');

  assert.equal(result.text, 'Got it. Noted. You take a double ristretto.');
  assert.ok(store.resolveNode('Espresso'), 'the tool wrote to memory');

  const [first, second] = openaiMock.requests;
  assert.equal(first.tools.length, 8);
  assert.equal(first.messages[0].role, 'system');
  assert.ok(first.messages.some((m) => m.content === 'earlier reply'), 'history carried');

  const assistant = second.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.tool_calls[0].function.name, 'remember');
  const toolMsg = second.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
});

// ── transcript integrity ─────────────────────────────────────────────────────

test('brain: a successful turn records both sides of the exchange', async () => {
  const before = store.recentEpisodes(500).length;
  const { events, emit } = recorder();
  await brain.converse('Ana teaches me on Tuesdays.', emit);

  const episodes = store.recentEpisodes(500);
  assert.equal(episodes.length, before + 2, 'user turn and assistant turn both recorded');
  assert.equal(episodes.at(-2).role, 'user');
  assert.equal(episodes.at(-1).role, 'assistant');
  assert.ok(events.some(([e]) => e === 'done'), 'turn completed');
});

test('brain: a failed turn leaves no orphan user message in the transcript', async () => {
  // Regression: the user turn used to be persisted before the provider call, so
  // a failed request left a dangling message replayed as history forever.
  anthropicMock.control.mode = 'fail';
  try {
    const before = store.recentEpisodes(500).length;
    await assert.rejects(() => brain.converse('this request will fail', () => {}));
    assert.equal(store.recentEpisodes(500).length, before, 'transcript unchanged after a failed turn');
  } finally {
    anthropicMock.control.mode = 'ok';
  }
});
