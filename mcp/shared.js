import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from '../server/tools.js';

/**
 * One MCP server definition, two hosts.
 *
 * The app serves it in-process at /mcp (for ChatGPT, which connects by URL),
 * and mcp/server.js serves the same thing over stdio (for Claude Desktop, which
 * connects by command). Both get an identical tool surface because they are
 * built from this file — only the way a tool call is executed differs.
 */

/**
 * Tools that exist only over MCP.
 *
 * `search`/`fetch` are the names ChatGPT connectors look for by convention.
 * `speak` is what keeps this a second brain that *talks* even when the
 * conversation is happening in Claude or ChatGPT: the model's words come out of
 * the 3D view, and the core pulses to them.
 */
export const MCP_ONLY_TOOLS = [
  {
    name: 'speak',
    description:
      "Say something out loud through the user's 3D knowledge graph, in its own voice. Call this whenever you have an answer, an observation, or a summary worth hearing — it is how the graph talks back. Plain prose only: it is read aloud, so no markdown, lists, or emoji.",
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say. One or two natural sentences.' } },
      required: ['text'],
    },
  },
  {
    name: 'search',
    description:
      'Search the knowledge graph for stored memories. Returns matching memories with their ids, which can be passed to fetch.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for.' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description: 'Retrieve one memory in full, including everything it links to, by id or by exact label.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id or exact label.' } },
      required: ['id'],
    },
  },
];

export const ALL_MCP_TOOLS = [...TOOLS, ...MCP_ONLY_TOOLS];

export const INSTRUCTIONS =
  "This is the user's persistent second brain: a knowledge graph of everything they have told you, " +
  'shown to them as an animated 3D visualisation.\n\n' +
  'Recall before you answer. Whenever the user mentions a person, project, preference, or past event, ' +
  'call recall_memory first rather than answering from your own guess.\n\n' +
  'Store proactively. Any durable fact, decision, preference, deadline, name, or relationship goes into ' +
  'remember before you reply — you do not need to be asked. Prefer several small sharply-scoped nodes ' +
  'over one large one, and always link them to each other and to what is already there. An unconnected ' +
  'node is nearly useless.\n\n' +
  'Call focus_view when your answer centres on particular memories; it flies the camera to them on the ' +
  "user's screen while you talk.\n\n" +
  'Speak your answers. The graph has a voice and the user is often watching it rather than reading here, ' +
  'so call speak with what you would say — plain prose, no markdown — alongside your normal reply. ' +
  'Pair it with focus_view and they will hear the answer while the camera moves to what it is about.';

/** `search` and `fetch` are thin aliases; everything else passes straight through. */
export function resolveToolCall(name, input = {}) {
  if (name === 'search') return { name: 'recall_memory', input: { query: input.query } };
  if (name === 'fetch') return { name: 'get_neighbors', input: { id: input.id, depth: 1 } };
  return { name, input };
}

/**
 * @param {object} opts
 * @param {(name: string, input: object) => Promise<{result: any, isError?: boolean}>} opts.callTool
 * @param {() => Promise<object>} opts.readGraph
 * @param {(err: Error) => string} [opts.describeError]
 */
export function buildMcpServer({ callTool, readGraph, describeError }) {
  const server = new Server(
    { name: 'second-brain', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const resolved = resolveToolCall(request.params.name, request.params.arguments || {});
    try {
      const outcome = await callTool(resolved.name, resolved.input);
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.result ?? outcome, null, 2) }],
        isError: !!outcome.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: describeError ? describeError(err) : err.message }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'brain://graph',
        name: 'Knowledge graph',
        description: 'The full graph of memories and the connections between them, as JSON.',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== 'brain://graph') throw new Error(`Unknown resource: ${request.params.uri}`);
    const graph = await readGraph();
    return { contents: [{ uri: 'brain://graph', mimeType: 'application/json', text: JSON.stringify(graph, null, 2) }] };
  });

  return server;
}
