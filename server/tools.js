import * as store from './store.js';
import * as memory from './memory.js';
import { broadcast } from './events.js';

/**
 * Provider-neutral tool definitions. Both adapters render from this one list so
 * Claude and ChatGPT get an identical capability surface.
 *
 * Descriptions are prescriptive about *when* to call, not just what the tool
 * does — that measurably raises should-call rate on recent models.
 */

export const TOOLS = [
  {
    name: 'recall_memory',
    description:
      'Search long-term memory for anything you might already know. Call this whenever the user references a person, project, preference, or past conversation — before answering from your own guess. Returns scored matches plus their linked neighbours.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural language.' },
        limit: { type: 'integer', description: 'Max direct hits to return (default 8).' },
        types: {
          type: 'array',
          items: { type: 'string', enum: store.NODE_TYPES },
          description: 'Optional filter by node type.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      'Store new knowledge as graph nodes and the links between them. Call this proactively whenever the user tells you something durable — a fact, a preference, a decision, a person, a project, a deadline. Prefer several small, sharply-scoped nodes over one large one, and always link them to each other and to anything already in memory.',
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: 'Nodes to create. An existing node with the same label is merged, not duplicated.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short canonical name, e.g. "Sourdough starter".' },
              type: { type: 'string', enum: store.NODE_TYPES },
              summary: { type: 'string', description: 'One sentence. This is what you will see on recall.' },
              content: { type: 'string', description: 'Fuller detail worth keeping verbatim.' },
              tags: { type: 'array', items: { type: 'string' } },
              importance: {
                type: 'number',
                description: '0-1. How much this should dominate future recall. Default 0.5.',
              },
            },
            required: ['label', 'type', 'summary'],
          },
        },
        links: {
          type: 'array',
          description: 'Edges between nodes. Refer to nodes by label (including ones created in this same call) or by id.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              rel: { type: 'string', description: 'Relationship verb, e.g. "works_on", "prefers", "caused_by".' },
              to: { type: 'string' },
              weight: { type: 'number', description: '0-1 strength. Default 0.6.' },
            },
            required: ['from', 'rel', 'to'],
          },
        },
      },
    },
  },
  {
    name: 'link_nodes',
    description:
      'Draw a relationship between two things already in memory. Use when you notice a connection the graph is missing — that is the whole point of a knowledge graph.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Node id or label.' },
        rel: { type: 'string' },
        to: { type: 'string', description: 'Node id or label.' },
        weight: { type: 'number' },
      },
      required: ['from', 'rel', 'to'],
    },
  },
  {
    name: 'update_node',
    description:
      'Revise a memory that has changed or was wrong. Correcting is better than storing a contradicting duplicate.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Node id or label.' },
        label: { type: 'string' },
        summary: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string', enum: store.NODE_TYPES },
        tags: { type: 'array', items: { type: 'string' } },
        importance: { type: 'number' },
        pinned: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'forget',
    description:
      'Archive a memory so it stops surfacing in recall. Only when the user asks you to forget something or it is definitively obsolete. Archiving is reversible; deletion is not.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Node id or label.' },
        hard: { type: 'boolean', description: 'Permanently delete instead of archiving. Ask first.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_neighbors',
    description:
      'Walk outward from one node to see what it connects to. Use when the user asks how things relate, or when you need context around a hit from recall_memory.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Node id or label.' },
        depth: { type: 'integer', description: 'Hops to traverse, 1-3. Default 1.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'focus_view',
    description:
      'Move the 3D view: fly the camera to these nodes and light them up while you talk about them. Call this whenever your answer centres on specific memories, so the user sees what you are referring to.',
    parameters: {
      type: 'object',
      properties: {
        node_ids: { type: 'array', items: { type: 'string' }, description: 'Node ids or labels to highlight.' },
        note: { type: 'string', description: 'Short caption shown on screen.' },
      },
      required: ['node_ids'],
    },
  },
  {
    name: 'graph_stats',
    description:
      'Get counts and type breakdown for the whole graph. Use when asked what you know overall, or how big memory has gotten.',
    parameters: { type: 'object', properties: {} },
  },
];

// ── Provider adapters ────────────────────────────────────────────────────────

export function toAnthropicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function toOpenAITools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Runs a tool and returns { result, events }.
 *
 * `events` drive the caller's own 3D view. They are also broadcast to every
 * other open viewer, so a memory written from Claude Desktop or ChatGPT
 * animates on screen even though no local turn produced it.
 *
 * @param {string} name
 * @param {object} input
 * @param {{source?: string}} [opts] where the call came from, for the viewer caption
 */
export async function runTool(name, input = {}, opts = {}) {
  const outcome = await dispatch(name, input);
  for (const event of outcome.events) {
    broadcast(event.type, { ...event, source: opts.source || 'local' });
  }
  return outcome;
}

async function dispatch(name, input = {}) {
  const events = [];

  switch (name) {
    case 'recall_memory': {
      const results = await memory.search(String(input.query || ''), {
        limit: Math.min(Number(input.limit) || 8, 25),
        types: Array.isArray(input.types) ? input.types : null,
      });
      if (results.length) {
        events.push({
          type: 'focus',
          ids: results.slice(0, 6).map((r) => r.node.id),
          note: `recall: ${String(input.query).slice(0, 60)}`,
        });
      }
      return {
        result: {
          found: results.length,
          memories: results.map((r) => ({
            id: r.node.id,
            label: r.node.label,
            type: r.node.type,
            summary: r.node.summary,
            content: r.node.content?.slice(0, 1200) || '',
            importance: r.node.importance,
            score: Number(r.score.toFixed(3)),
            why: r.reason,
          })),
        },
        events,
      };
    }

    case 'remember': {
      const { created, merged, edges } = await memory.remember({
        nodes: Array.isArray(input.nodes) ? input.nodes : [],
        links: Array.isArray(input.links) ? input.links : [],
      });
      if (created.length || merged.length || edges.length) {
        events.push({ type: 'graph_delta' });
        events.push({
          type: 'focus',
          ids: [...created, ...merged].map((n) => n.id).slice(0, 8),
          note: created.length ? `remembered ${created.length} new` : 'updated memory',
        });
      }
      return {
        result: {
          created: created.map((n) => ({ id: n.id, label: n.label })),
          merged: merged.map((n) => ({ id: n.id, label: n.label })),
          links: edges.length,
        },
        events,
      };
    }

    case 'link_nodes': {
      const from = store.resolveNode(input.from);
      const to = store.resolveNode(input.to);
      if (!from || !to) {
        return { result: { error: `Could not resolve ${!from ? 'from' : 'to'} node.` }, events, isError: true };
      }
      const edge = store.createEdge({ from: from.id, to: to.id, rel: input.rel, weight: input.weight });
      if (!edge) return { result: { error: 'Edge rejected (self-link?).' }, events, isError: true };
      events.push({ type: 'graph_delta' });
      events.push({ type: 'focus', ids: [from.id, to.id], note: `${from.label} → ${edge.rel} → ${to.label}` });
      return { result: { linked: `${from.label} -[${edge.rel}]-> ${to.label}` }, events };
    }

    case 'update_node': {
      const node = store.resolveNode(input.id);
      if (!node) return { result: { error: `No node matching "${input.id}".` }, events, isError: true };
      const { id: _ignored, ...patch } = input;
      const updated = store.updateNode(node.id, patch);
      await memory.ensureEmbeddings({ limit: 8 });
      events.push({ type: 'graph_delta' });
      events.push({ type: 'focus', ids: [updated.id], note: `updated ${updated.label}` });
      return { result: { updated: { id: updated.id, label: updated.label } }, events };
    }

    case 'forget': {
      const node = store.resolveNode(input.id);
      if (!node) return { result: { error: `No node matching "${input.id}".` }, events, isError: true };
      const label = node.label;
      store.forgetNode(node.id, { hard: !!input.hard });
      events.push({ type: 'graph_delta' });
      return { result: { forgotten: label, permanent: !!input.hard }, events };
    }

    case 'get_neighbors': {
      const node = store.resolveNode(input.id);
      if (!node) return { result: { error: `No node matching "${input.id}".` }, events, isError: true };
      const found = store.neighbors(node.id, Number(input.depth) || 1);
      events.push({
        type: 'focus',
        ids: [node.id, ...found.slice(0, 8).map((f) => f.node.id)],
        note: `around ${node.label}`,
      });
      return {
        result: {
          center: { id: node.id, label: node.label, summary: node.summary },
          neighbors: found.map((f) => ({
            id: f.node.id,
            label: f.node.label,
            type: f.node.type,
            summary: f.node.summary,
            relation: f.via.rel,
            direction: f.via.from === node.id ? 'outgoing' : 'incoming',
            distance: f.distance,
          })),
        },
        events,
      };
    }

    case 'focus_view': {
      const ids = (Array.isArray(input.node_ids) ? input.node_ids : [])
        .map((ref) => store.resolveNode(ref)?.id)
        .filter(Boolean);
      if (ids.length) events.push({ type: 'focus', ids, note: input.note || '' });
      return { result: { focused: ids.length }, events };
    }

    case 'graph_stats':
      return { result: memory.health(), events };

    // Not advertised in TOOLS: only the MCP server offers this. The in-app
    // providers already stream their answer to the voice, so exposing it there
    // would make the brain say everything twice.
    case 'speak': {
      const text = String(input.text || '').trim();
      if (!text) return { result: { error: 'Nothing to say.' }, events, isError: true };
      events.push({ type: 'speak', text: text.slice(0, 1200) });
      return { result: { spoken: true, characters: text.length }, events };
    }

    default:
      return { result: { error: `Unknown tool "${name}".` }, events, isError: true };
  }
}
