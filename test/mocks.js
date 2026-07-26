import http from 'node:http';

/**
 * Scriptable mock providers that speak the real streaming wire formats.
 *
 * These exist so the tool loop can be tested for real — fragmented tool
 * arguments, multi-round loops, message shape — without an API key or network.
 * Each server records the request bodies it received so tests can assert on
 * exactly what we sent.
 */

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const dataFrames = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function collect(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Anthropic Messages API mock.
 * @param {Array<Array<object>>} script one entry per round; each entry is a list
 *   of blocks: {type:'text'|'thinking', chunks:[]} or {type:'tool_use', id, name, jsonChunks:[]}
 */
export async function mockAnthropic(script) {
  const requests = [];
  const control = { mode: 'ok' }; // set to 'fail' to simulate a dropped connection
  let round = 0;

  const server = http.createServer(async (req, res) => {
    const body = await collect(req);
    if (control.mode === 'fail') {
      res.destroy();
      return;
    }
    if (!Array.isArray(body.messages)) {
      res.writeHead(404).end('{}');
      return;
    }
    requests.push(body);

    const blocks = script[Math.min(round, script.length - 1)];
    round++;
    const usesTool = blocks.some((b) => b.type === 'tool_use');

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let out = sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20 },
      },
    });

    blocks.forEach((block, index) => {
      if (block.type === 'thinking') {
        out += sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        for (const c of block.chunks) {
          out += sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: c },
          });
        }
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: 'sig==' },
        });
      } else if (block.type === 'text') {
        out += sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        for (const c of block.chunks) {
          out += sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: c },
          });
        }
      } else if (block.type === 'tool_use') {
        out += sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        });
        for (const c of block.jsonChunks) {
          out += sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: c },
          });
        }
      }
      out += sse('content_block_stop', { type: 'content_block_stop', index });
    });

    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 40 },
    });
    out += sse('message_stop', { type: 'message_stop' });
    res.end(out);
  });

  return { ...(await listen(server)), requests, control };
}

/**
 * OpenAI chat-completions mock.
 * @param {Array<object>} script one entry per round:
 *   { text?: string[], toolCalls?: [{id, name, argChunks: []}] }
 */
export async function mockOpenAI(script) {
  const requests = [];
  let round = 0;

  const server = http.createServer(async (req, res) => {
    const body = await collect(req);

    if (req.url.includes('/embeddings')) {
      // A constant vector for every input: cosine is then identical across all
      // nodes, so it contributes uniformly and leaves recall ranking to the
      // lexical/recency/importance terms. Keeps ranking assertions meaningful
      // while still exercising the real embedding request/parse path.
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          model: body.model,
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: new Array(8).fill(0.25) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
      return;
    }

    if (!Array.isArray(body.messages)) {
      res.writeHead(404).end('{}');
      return;
    }
    requests.push(body);

    const step = script[Math.min(round, script.length - 1)];
    round++;
    const chunks = [];

    for (const t of step.text || []) {
      chunks.push({ choices: [{ index: 0, delta: { role: 'assistant', content: t } }] });
    }
    (step.toolCalls || []).forEach((call, index) => {
      chunks.push({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] },
          },
        ],
      });
      for (const c of call.argChunks) {
        chunks.push({
          choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: c } }] } }],
        });
      }
    });
    chunks.push({
      choices: [{ index: 0, delta: {}, finish_reason: step.toolCalls?.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 90, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 10 } },
    });

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(dataFrames(chunks));
  });

  return { ...(await listen(server)), requests };
}
