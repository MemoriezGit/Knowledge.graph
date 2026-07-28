import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * Guards the embedding wire format.
 *
 * The OpenAI SDK asks for base64 vectors by default and decodes them itself.
 * That is invisible against OpenAI, but an OpenAI-compatible server — a gateway
 * or a local model, both of which this project tells people to point at — may
 * answer with a plain float array regardless. The SDK then "decodes" that into
 * zeros, and a zero vector poisons recall silently: no error, no warning, just
 * quietly worse answers forever.
 *
 * Runs in its own file so it gets its own process, because config reads the
 * environment once at import time.
 */

const requests = [];
let mode = 'floats'; // 'floats' | 'zeros' | 'empty'

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    requests.push(parsed);
    const count = Array.isArray(parsed.input) ? parsed.input.length : 1;
    // Deliberately ignores encoding_format, exactly like a strict compatible server.
    const vector =
      mode === 'zeros' ? new Array(8).fill(0) : mode === 'empty' ? [] : [0.1, -0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: Array.from({ length: count }, (_, index) => ({ object: 'embedding', index, embedding: vector })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.OPENAI_API_KEY = 'sk-test';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.BRAIN_PROVIDER = 'openai';

const { embed, localEmbed } = await import('../server/embeddings.js');

test.after(() => server.close());

test('embeddings: asks for plain floats rather than the SDK default of base64', async () => {
  requests.length = 0;
  mode = 'floats';
  await embed(['hello world']);
  assert.equal(requests.at(-1).encoding_format, 'float');
});

test('embeddings: a server that answers with float arrays yields usable vectors', async () => {
  mode = 'floats';
  const [vec] = await embed(['hello world']);
  assert.equal(vec.length, 8, 'the real vector came through, not a decoded-as-base64 husk');
  assert.ok(
    vec.some((v) => v !== 0),
    'not silently zeroed',
  );
  assert.ok(Math.abs(vec[0] - 0.1) < 1e-6, 'values survive the round trip');
});

test('embeddings: unusable vectors fall back to the offline ones instead of poisoning recall', async () => {
  const local = localEmbed('hello world');

  mode = 'zeros';
  const [zeroed] = await embed(['hello world']);
  assert.equal(zeroed.length, local.length, 'fell back to a local vector');
  assert.ok(
    zeroed.some((v) => v !== 0),
    'and the local vector actually carries signal',
  );

  mode = 'empty';
  const [empty] = await embed(['hello world']);
  assert.equal(empty.length, local.length, 'an empty embedding also falls back');
});

test('embeddings: a short batch falls back rather than misaligning vectors with nodes', async () => {
  mode = 'floats';
  // One input, but ask for three: the server answers with one row per input, so
  // request two more than it will return by calling with a mismatched batch.
  const original = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          usage: {},
        }),
      );
    });
  });

  const vectors = await embed(['one', 'two', 'three']);
  assert.equal(vectors.length, 3, 'one vector per input, always');
  assert.equal(vectors[0].length, localEmbed('one').length, 'all three are local, not one real and two missing');

  server.removeAllListeners('request');
  server.on('request', original);
});
