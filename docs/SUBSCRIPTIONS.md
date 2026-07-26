# Running on your subscriptions instead of API credits

**The thing to know first:** neither a Claude Max plan nor a ChatGPT Plus/Pro plan
includes API access. The Anthropic API and the OpenAI API are billed separately,
per token, from their developer consoles. An API key is a different product from
a subscription, and no setting anywhere converts one into the other.

That does **not** mean your subscriptions are useless here. It means the model
has to call the graph rather than the graph calling the model. There are two
supported ways to do that, and you can run both at once.

---

## Route 1 — MCP: both subscriptions, no API keys

Claude and ChatGPT both speak **MCP**, so instead of this app calling a model,
your subscription's app calls this one. Your Max plan and your ChatGPT plan each
do the thinking; the graph does the remembering, and the 3D view animates live as
memories are written.

Start the app first — the MCP server is a thin client of it:

```bash
npm run serve          # http://localhost:8787, keep this running
```

### Claude (Max) — Claude Desktop or Claude Code

Claude Desktop → Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "node",
      "args": ["/absolute/path/to/Knowledge.graph/mcp/server.js"]
    }
  }
}
```

Or for Claude Code, from the project directory:

```bash
claude mcp add second-brain -- node "$PWD/mcp/server.js"
```

Restart Claude, and it gains `recall_memory`, `remember`, `link_nodes`,
`update_node`, `forget`, `get_neighbors`, `focus_view`, and `graph_stats`.
Ask it to remember something, then watch the 3D view.

### ChatGPT (Plus/Pro) — custom connector

ChatGPT connectors take a **URL**, so this side needs the HTTP transport:

```bash
npm run mcp:http       # http://localhost:8788/mcp
```

Then in ChatGPT: **Settings → Connectors → Advanced → Developer mode**, on. Add a
custom connector pointing at your `/mcp` URL.

ChatGPT has to be able to *reach* that URL, so unless you're self-hosting on a
public box you'll need a tunnel:

```bash
cloudflared tunnel --url http://localhost:8788    # or: ngrok http 8788
```

Use the tunnel's HTTPS URL + `/mcp` as the connector URL.

> ⚠️ **The HTTP endpoint is unauthenticated.** Anyone who can reach that URL can
> read and write your memories. Keep the tunnel private, shut it down when you're
> not using it, and don't leave the port open on a network you don't control.
> Both hosts also warn that connecting a model to a tool server exposes you to
> prompt injection — this one only touches your own graph, but the caution stands.

---

## Route 2 — Claude Code: keep this app's own voice, on your Max plan

Route 1 moves the conversation into Claude or ChatGPT. If you want the app's own
interface — the 3D view *and* the speaking voice — running on your Max plan
instead of API credits, use the Claude Code provider.

A Max plan does grant Claude Code, and the Claude Agent SDK is Claude Code as a
library: it inherits whatever the local CLI is logged in as. So:

```bash
npm install -g @anthropic-ai/claude-code   # if you don't have it
claude                                     # sign in with your Max subscription, once
```

Then in `.env`:

```
BRAIN_PROVIDER=claude-code
```

and `npm run dev`. Everything works as before — streaming answers, voice,
camera fly-to — but it's drawing on your subscription's usage window rather than
metered API tokens. Memory tools reach it through the same MCP server, so there's
one implementation shared across all three routes.

Optional:

```
CLAUDE_CODE_MODEL=claude-opus-5     # default: whatever Claude Code uses
CLAUDE_CODE_EFFORT=high             # low | medium | high | xhigh | max
CLAUDE_CODE_MAX_TURNS=16
```

**What's different from the API path:** you're spending plan usage, which resets
on a rolling window rather than billing per token — if you hit the limit, the app
says so and you wait or switch providers. Prompt caching also behaves differently
on a subscription. And it needs Claude Code installed and logged in on the
machine running the server, so it's a local-first setup, not something to deploy.

---

## What about ChatGPT driving the app's own UI?

There is no supported equivalent. OpenAI has no subscription-authenticated
general chat API — Codex CLI can sign in with a ChatGPT plan, but it's a coding
agent, not a general backend, and using it as one would be off-label and fragile.
So the honest answer is: **the ChatGPT subscription participates through Route 1**,
where ChatGPT itself is the interface and this app is its memory.

---

## Picking a route

| You want | Use | Costs |
|---|---|---|
| Talk in Claude Desktop / Claude app, graph animates alongside | Route 1 (stdio) | Max plan |
| Talk in ChatGPT, graph animates alongside | Route 1 (HTTP + tunnel) | ChatGPT plan |
| This app's own 3D + voice interface | Route 2 | Max plan |
| This app's own interface, or deploying it somewhere | API keys | Metered per token |

They compose. A common setup is Route 2 for the desk, plus Route 1 on the phone
through the Claude or ChatGPT app — one graph behind all of them, because every
route writes through the same running server.

Sources for the subscription/API distinction: [Claude Code costs](https://code.claude.com/docs/en/costs),
[ChatGPT Plus](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus),
[ChatGPT developer mode and MCP](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
