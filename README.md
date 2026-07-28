# Second Brain — a 3D knowledge graph that talks back

An animated 3D knowledge graph with persistent memory, driven by your **Claude** or **ChatGPT** account. You talk to it; it decides what's worth remembering, files it as nodes and edges, and speaks its answers out loud while the camera flies to whatever it's referring to.

It isn't a chatbot with a graph stuck next to it. The model owns the graph — every memory you see was created by a tool call it chose to make.

![The graph](docs/screenshot.png)

---

## Start here

```bash
git clone https://github.com/MemoriezGit/Knowledge.graph.git
cd Knowledge.graph
npm install
npm run setup     # connects your Claude/ChatGPT account, tells you if anything's missing
npm start         # → http://localhost:8787
```

That's the whole thing. Once at the start, then **`npm start` every day after**.

Or let a script do all of it, including opening the browser:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/MemoriezGit/Knowledge.graph/HEAD/scripts/install.sh | bash

# Windows (PowerShell)
iwr -useb https://raw.githubusercontent.com/MemoriezGit/Knowledge.graph/HEAD/scripts/install.ps1 | iex
```

`npm run setup` is also the "is this still working?" command — re-run it any time. It checks that your brain can actually answer, registers this app with Claude Code for you, and prints the URL + token for a ChatGPT connector.

**No API key needed** if you already pay for Claude. If Claude Code is installed and signed in, `npm run setup` finds it and uses your subscription — see [docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md).

Want a graph that isn't empty to poke at first? `npm run seed`.

## Using it

Talk to it the way you'd talk to a person. It works out what's worth keeping.

> "Remember my sister Priya's birthday is 3 June."
> "I decided to switch the project to Postgres because of the JSON queries."
> "What do you know about my running training?"
> "How is Ana connected to Lisbon?"

Every dot is a memory, every line a connection; bigger and brighter means more important. Click a dot to inspect it. The camera flies to whatever it's talking about.

`/` search · `Space` push-to-talk · `V` mute · `R` recenter · `Esc` stop talking · `?` help

**Consolidate** (top bar) sweeps the recent conversation for anything worth filing that the model didn't catch in the moment. Worth hitting at the end of a long session.

**Export** downloads the whole graph as JSON. Your memory lives in `data/brain.json` — one plain file, easy to back up, easy to move.

## Talking to it from Claude or ChatGPT

`npm run setup` wires this up. Once it has, ask Claude or ChatGPT something and *your graph answers out loud* — the model calls a `speak` tool, and the 3D view says it in its own voice while the camera moves.

- **Claude Desktop / Claude Code** — connected automatically by `npm run setup`.
- **ChatGPT** — Settings → Connectors → Advanced → Developer mode, then add the URL and token that `npm run setup` prints. ChatGPT has to reach the URL, so from a laptop you'll need a tunnel: `cloudflared tunnel --url http://localhost:8787`.

Details and the rest of the trade-offs: **[docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md)**.

## Using API keys instead

| Key | What you get |
|---|---|
| `ANTHROPIC_API_KEY` | Claude as the brain. The better one for this — it reasons harder about what's worth linking. |
| `OPENAI_API_KEY` | ChatGPT as the brain. Also unlocks real embeddings and a much better voice. |

Put either in `.env`. Set both and Claude thinks while OpenAI supplies embeddings and the voice. Switch any time with `BRAIN_PROVIDER=anthropic|openai|claude-code`.

With **no key and no subscription** the graph, search, and 3D view still work — nothing will talk back.

---

## What it does

**Remembers without being asked.** Tell it something durable and it files it. "Ana is my Portuguese tutor, Tuesdays at 7" becomes a `person` node, a `project` node, an edge labelled `teaches`, and a time detail — not one blob of text.

**Recalls before it answers.** Every message triggers an automatic hybrid search; the model can also search again mid-answer. It's told, firmly, not to guess when the answer is stored.

**Links things.** New memories are connected to what's already there. Unconnected nodes are close to useless, so the system prompt pushes hard on this.

**Shows you what it means.** When the answer centres on particular memories, the model calls `focus_view` and the camera flies to them while it speaks.

**Speaks.** Answers stream out sentence by sentence as they're generated, so it starts talking before it's finished thinking. The core at the centre of the graph pulses to the actual audio amplitude. It speaks whether you type here or drive it from Claude or ChatGPT.

**Listens.** Push-to-talk via the browser's speech recogniser (Chrome/Edge).

---

## How memory works

Everything lives in one JSON file (`data/brain.json`) — greppable, diffable, and easy to back up. No database to run, no native modules to compile.

```
node  { id, label, type, summary, content, tags[], importance,
        createdAt, lastAccessedAt, accessCount, pinned, archived, embedding }
edge  { id, from, to, rel, weight }
```

**Recall is hybrid**, because no single signal is trustworthy on its own — vectors miss exact names, keywords miss paraphrase, and recency alone is just a timeline:

```
score = 0.45·cosine + 0.35·BM25 + 0.10·recency + 0.10·importance
```

…then one hop of graph expansion, so a strong hit drags its neighbours along with it.

Memories that get recalled drift *up* in importance; everything decays gently by recency (~30-day half-life). Forgetting archives by default rather than deleting, so it stays recoverable and still shows up in your export.

### The model's tools

| Tool | What it does |
|---|---|
| `recall_memory` | Hybrid search over everything |
| `remember` | Create nodes + edges in one call; same-label nodes merge instead of duplicating |
| `link_nodes` | Connect two existing memories |
| `update_node` | Revise a memory that changed or was wrong |
| `forget` | Archive (or, if you confirm, delete) |
| `get_neighbors` | Walk outward 1–3 hops |
| `focus_view` | Fly the camera and light nodes up |
| `graph_stats` | Counts and type breakdown |
| `speak` | Say something aloud through the 3D view (MCP hosts only — in-app providers already stream to the voice) |

---

## The 3D view

- **Force-directed layout**, hand-rolled so the physics shares a clock with the visuals — the graph reheats when memory changes and nodes spawn next to the neighbours they link to instead of flying in from nowhere.
- **Colour by type**, size by importance and degree.
- **Signal pulses** run the edges; they speed up and multiply while the brain is thinking.
- **Labels declutter themselves** in screen space and hold a constant on-screen size at any zoom.

Node size, camera framing, and label scale are all derived from the graph's actual extent, so it looks right with 20 memories or 2,000.

---

## Configuration

All optional. See `.env.example` — and note that `npm run setup` writes the only line that really matters (`MCP_TOKEN`) for you.

| Variable | Default | Notes |
|---|---|---|
| `BRAIN_PROVIDER` | auto | `anthropic`, `openai`, or `claude-code` (subscription). Auto-picks a key if one exists, otherwise your Claude Code login |
| `CLAUDE_CODE_MODEL` / `_EFFORT` / `_MAX_TURNS` | — | Subscription route only; empty inherits Claude Code's own settings |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Any current model id |
| `ANTHROPIC_EFFORT` | `high` | `low`…`max`. How hard it thinks per turn |
| `OPENAI_MODEL` | `gpt-4o` | Any chat model your account can reach |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | |
| `OPENAI_TTS_VOICE` | `alloy` | |
| `BRAIN_NAME` | `Atlas` | It answers to this |
| `DATA_DIR` | `./data` | Where memory lives |
| `PORT` | `8787` | Serves the UI, the API, and `/mcp` — one port for everything |
| `MCP_TOKEN` | random each boot | Bearer token for `/mcp`. Set it (setup does) so the ChatGPT connector survives restarts |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | — | Point at a proxy, gateway, or local model server |
| `BRAIN_APP_URL` | `http://127.0.0.1:8787` | Where the stdio MCP server finds this app |

### Commands

| | |
|---|---|
| `npm start` | Build the UI and serve everything on one port |
| `npm run setup` | Connect / verify your accounts. Safe to re-run |
| `npm run dev` | Hot-reloading server + Vite dev UI, for hacking on it |
| `npm run seed` | A small demo graph |
| `npm test` | 31 tests, no key, no network, ~6s |

### API

`GET /api/health` · `GET /api/graph` · `GET /api/search?q=` · `GET /api/node/:id`
`GET /api/events` (SSE — live graph changes from any source) · `POST /api/mcp/tool`
`POST /api/chat` (SSE) · `POST /api/consolidate` (SSE) · `POST /api/tts`
`POST /api/node` · `PATCH /api/node/:id` · `DELETE /api/node/:id` · `POST /api/link`
`GET /api/export` · `POST /api/import` · `ALL /mcp` (Streamable HTTP, bearer token)

`/api/chat` streams Server-Sent Events over POST: `start`, `recall`, `thinking`, `text`, `tool_call`, `tool_result`, `focus`, `graph_delta`, `done`, `error`.

---

## Things worth knowing before you rely on it

**Without an OpenAI key, semantic recall is weak.** The offline fallback is a hashed character-trigram vector — deterministic and free, but not semantic. It handles "portuguese tutor" → *Ana* fine, and misses "what do I drink in the morning" → *Espresso* entirely, because there's no shared vocabulary to latch onto. Lexical BM25 carries most of the weight in that mode. Add an OpenAI key and this problem goes away; existing memories are re-embedded automatically on next start.

**Speech recognition is Chrome/Edge only.** The Web Speech API isn't implemented in Firefox and is unreliable in Safari. Text input works everywhere; speech *output* works in any modern browser.

**Browser voices vary a lot.** Without an OpenAI key you get whatever the OS provides, which on some Linux setups is fairly robotic. With a key, `/api/tts` is used instead and the audio amplitude genuinely drives the animation, rather than being approximated from word-boundary events.

**The app server itself has no authentication.** It's built to run on your own machine, and `data/brain.json` is plain text. Don't expose port 8787 to a network you don't trust, and don't tell it secrets you wouldn't write in a text file. `/mcp` on that same port is the exception — it always requires a bearer token, since that one is meant to be tunnelled.

**The transcript is bounded, the graph is not.** Only the last 24 turns are replayed as conversation history — long-term memory is the graph, which is the whole point. If something matters, it needs to be a node; hit **Consolidate** to sweep the recent transcript for anything the model forgot to file.

**Cost.** On the subscription route there is no per-token bill at all — you spend plan usage, which resets on a rolling window, and the app tells you if you hit the limit. On the API-key routes every turn sends the system prompt, ~24 turns of history, and 8 tool schemas; the Claude path marks the system prompt for caching, which takes most of the sting out of a long session. Drop `ANTHROPIC_EFFORT` to `medium` or `low` if you're chatting casually rather than thinking hard.

---

## Tests

`npm test` runs 31 tests against mock Anthropic and OpenAI servers that speak
the real streaming wire formats — no API key, no network, ~6 seconds.

The interesting coverage is the tool loop: tool-call JSON arrives split
mid-token and has to be reassembled, results fed back, and the loop run to a
second round. The suite asserts on the exact request shape we send Anthropic
(adaptive thinking, `effort`, cached system prompt, no sampling params, tool
results batched into one user message, thinking blocks echoed back unmodified),
since getting any of those wrong is a 400 in production but invisible locally.

The MCP tests drive both transports for real: the stdio server is spawned as a
subprocess and spoken to in JSON-RPC, and `/mcp` is exercised against an
actually-booted app on a scratch data dir — so "ChatGPT writes a memory and the
browser sees it" is a test, not a hope.

Several of the tests are regression guards for bugs found while building this,
and each was mutation-tested — the bug reintroduced, the suite confirmed to
fail on exactly that test, then reverted:

| Guard | The bug it catches |
|---|---|
| `concurrent saves share one promise` | `save()` minted a promise per call and cleared the prior timer, orphaning the earlier promise so an awaited save hung forever |
| `a failed turn leaves no orphan user message` | the user turn was persisted before the provider call, so a failed request left a dangling message replayed as history forever |
| `request shape matches the API contract` | sending `temperature`, which 400s on Opus 5 |
| `/mcp refuses requests without the right bearer token` | an unauthenticated connector endpoint exposing everything you've ever told it |
| `writes are labelled by who asked` | the app announcing your own typed message back to you as an external change |
| `embeddings ask for plain floats` | the OpenAI SDK's base64 default silently decoding to zero vectors against a compatible server, quietly poisoning recall |

## Layout

```
server/
  index.js            Express + SSE endpoints, boot
  brain.js            System prompt, auto-recall, turn orchestration
  memory.js           Hybrid search, remember/merge, context building
  store.js            JSON-backed graph store, atomic writes
  embeddings.js       OpenAI embeddings + offline fallback
  tools.js            Tool schemas, provider adapters, dispatch
  events.js           Broadcast bus for live viewers
  mcp-http.js         /mcp — MCP over HTTP, in-process, for ChatGPT
  providers/
    anthropic.js      Streaming tool loop (adaptive thinking, prompt caching)
    openai.js         Streaming tool loop + TTS
    claude-code.js    Runs on a Claude Pro/Max subscription via the Agent SDK
web/src/
  graph3d.js          Force layout, shaders, bloom, camera, labels
  voice.js            Speech out (streamed, sentence-chunked) and in
  main.js             UI wiring, SSE consumption
  api.js              Fetch helpers + SSE-over-POST parser
mcp/
  shared.js           One MCP definition — tools, instructions, aliases
  server.js           The stdio transport, for Claude Desktop / Claude Code
scripts/
  setup.js            One command to connect everything and verify it
  seed.js             Demo graph
test/
  mocks.js            Scriptable Anthropic/OpenAI streaming mocks
  brain.test.js       Store, memory, tools, and both provider loops
  mcp.test.js         Both MCP transports, over real JSON-RPC
```

---

## License

MIT.
