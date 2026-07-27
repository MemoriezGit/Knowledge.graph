# Running on your subscriptions instead of API credits

**The thing to know first:** neither a Claude Max plan nor a ChatGPT Plus/Pro plan
includes API access. The Anthropic API and the OpenAI API are billed separately,
per token, from their developer consoles. An API key is a different product from
a subscription, and no setting anywhere converts one into the other.

That does **not** mean your subscriptions are useless here. It means the model
has to call the graph rather than the graph calling the model. There are two
supported ways to do that, and you can run both at once.

**Both start the same way:**

```bash
npm start          # keep this running — http://localhost:8787
npm run setup      # connects what it can, prints what's left
```

`npm run setup` is the fastest way to know it's right. It verifies your brain can
actually answer, registers this app with Claude Code for you, checks the connector
endpoint responds, and prints the literal URL and token for ChatGPT — so nothing
here has to be typed from memory. Re-run it any time; it's also the "is this still
working?" command.

---

## Route 1 — MCP: both subscriptions, no API keys

Claude and ChatGPT both speak **MCP**, so instead of this app calling a model,
your subscription's app calls this one. Your Max plan and your ChatGPT plan each
do the thinking; the graph does the remembering, and the 3D view animates live as
memories are written.

### Claude (Pro/Max) — Claude Code or Claude Desktop

`npm run setup` registers it with Claude Code automatically. For Claude Desktop,
go to Settings → Developer → Edit Config and add:

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

Or by hand, from the project directory:

```bash
claude mcp add second-brain -- node "$PWD/mcp/server.js"
```

Restart Claude, and it gains `recall_memory`, `remember`, `link_nodes`,
`update_node`, `forget`, `get_neighbors`, `focus_view`, `graph_stats`, and
`speak`. Ask it to remember something, then watch the 3D view.

**It talks back through the graph.** `speak` sends the model's words to the 3D
view, which reads them aloud and pulses the core to the audio. So even when the
conversation is happening in Claude or ChatGPT, the second brain on your screen
is the thing speaking.

### ChatGPT (Plus/Pro) — custom connector

ChatGPT connectors take a **URL**, and that endpoint lives inside the app itself:

```
  URL     http://localhost:8787/mcp
  Token   (printed by npm run setup; stored in .env)
```

There is no second process and no second port — the same server that draws the
3D view answers MCP at `/mcp`, so a connector's writes land in the same store the
browser is already watching, with no proxy hop in between.

**The endpoint always requires that token.** There is no unauthenticated mode. If
`MCP_TOKEN` isn't set, a random one is generated at each boot — fine for a quick
test, useless for a saved connector, which is why `npm run setup` writes a stable
one into `.env`.

ChatGPT has to be able to *reach* the URL, so unless you're self-hosting on a
public box you'll need a tunnel:

```bash
cloudflared tunnel --url http://localhost:8787    # or: ngrok http 8787
```

Then in ChatGPT: **Settings → Connectors → Advanced → Developer mode**, on. Add a
custom connector with the tunnel's HTTPS URL + `/mcp`, and the token as its
bearer/authentication value.

> ⚠️ The tunnel exposes the whole app, not just `/mcp` — and the rest of the app
> has no authentication. Keep the tunnel private, shut it down when you're not
> using it, and don't leave one running unattended. Both hosts also warn that
> connecting a model to any tool server carries prompt-injection risk; this server
> only touches your own graph, but the caution stands.

---

## Route 2 — Claude Code: keep this app's own voice, on your Max plan

Route 1 moves the conversation into Claude or ChatGPT. If you want the app's own
interface — the 3D view *and* the speaking voice — running on your Pro/Max plan
instead of API credits, use the Claude Code provider.

A Pro/Max plan does grant Claude Code, and the Claude Agent SDK is Claude Code as
a library: it inherits whatever the local CLI is logged in as. So:

```bash
npm install -g @anthropic-ai/claude-code   # if you don't have it
claude                                     # sign in with your subscription, once
```

That's all. **You do not need to set anything** — with no API key present, the app
detects the Claude Code install and uses it. To force it either way:

```
BRAIN_PROVIDER=claude-code     # subscription, even if an API key exists
BRAIN_PROVIDER=anthropic       # API key, even if Claude Code is installed
```

Everything works as it does on the API path — streaming answers, voice, camera
fly-to — but it draws on your subscription's usage window rather than metered API
tokens. Memory tools reach it through the same tool definitions as every other
route, so there's one implementation behind all of them.

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

## What about ChatGPT driving the app's own chat panel?

There is no supported equivalent — OpenAI has no subscription-authenticated
general chat API. Codex CLI can sign in with a ChatGPT plan, but it's a coding
agent, not a general backend, and using it as one would be off-label and fragile.

In practice this matters less than it sounds, because of the `speak` tool: with
Route 1, ChatGPT is the input surface and the 3D brain is still the thing that
answers out loud. You talk to ChatGPT; your graph replies in its own voice and
flies the camera to what it's talking about. The only thing you lose is typing
into *this* app's text box.

---

## Picking a route

| You want | Use | Costs |
|---|---|---|
| Talk in Claude Desktop / Claude app, graph animates alongside | Route 1 (stdio) | Pro/Max plan |
| Talk in ChatGPT, graph animates alongside | Route 1 (HTTP + tunnel) | ChatGPT plan |
| This app's own 3D + voice interface, typed here | Route 2 | Pro/Max plan |
| Deploying it somewhere, or no Claude install | API keys | Metered per token |

They compose. A common setup is Route 2 for the desk, plus Route 1 on the phone
through the Claude or ChatGPT app — one graph behind all of them, because every
route writes through the same running server.

Sources for the subscription/API distinction: [Claude Code costs](https://code.claude.com/docs/en/costs),
[ChatGPT Plus](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus),
[ChatGPT developer mode and MCP](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
