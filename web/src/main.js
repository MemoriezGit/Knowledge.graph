import { BrainGraph, TYPE_COLORS } from './graph3d.js';
import { api, streamSSE } from './api.js';
import { Voice, Ears } from './voice.js';

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('graph'),
  brainName: $('brainName'),
  statusLine: $('statusLine'),
  brandOrb: $('brandOrb'),
  statChip: $('statChip'),
  messages: $('messages'),
  input: $('input'),
  send: $('send'),
  composerStatus: $('composerStatus'),
  searchInput: $('searchInput'),
  searchResults: $('searchResults'),
  legend: $('legend'),
  focusCaption: $('focusCaption'),
  nodeCard: $('nodeCard'),
  nodeCardType: $('nodeCardType'),
  nodeCardTitle: $('nodeCardTitle'),
  nodeCardSummary: $('nodeCardSummary'),
  nodeCardContent: $('nodeCardContent'),
  nodeCardImportance: $('nodeCardImportance'),
  nodeCardLinks: $('nodeCardLinks'),
  nodeCardClose: $('nodeCardClose'),
  nodeAsk: $('nodeAsk'),
  nodeForget: $('nodeForget'),
  btnVoice: $('btnVoice'),
  btnMic: $('btnMic'),
  btnConsolidate: $('btnConsolidate'),
  btnReset: $('btnReset'),
  chatCollapse: $('chatCollapse'),
  chatPanel: $('chatPanel'),
  leftPanel: $('leftPanel'),
  panelToggle: $('panelToggle'),
  btnHelp: $('btnHelp'),
  helpPanel: $('helpPanel'),
  helpClose: $('helpClose'),
};

const graph = new BrainGraph(el.canvas);
// Handy for tweaking the scene from the devtools console.
window.__graph = graph;

const voice = new Voice({
  onAmplitude: (a) => graph.setAmplitude(a),
  onStateChange: (state) => {
    if (state === 'speaking') setMood('speaking');
    else if (!busy) setMood('idle');
  },
});

const ears = new Ears({
  onInterim: (text) => {
    el.input.value = text;
    autosize();
  },
  onResult: (text) => {
    el.input.value = text;
    autosize();
    send();
  },
  onStateChange: (listening) => {
    el.btnMic.classList.toggle('recording', listening);
    el.composerStatus.textContent = listening ? 'listening…' : '';
  },
});

let busy = false;
let voiceOn = true;
// Browsers refuse to speak until the page has seen a user gesture. External
// speech can arrive at any time, so arm the audio on the first interaction of
// any kind rather than only when the user sends a message.
let audioArmed = false;
let selectedNode = null;
let graphData = { nodes: [], edges: [] };

// ── boot ─────────────────────────────────────────────────────────────────────

init();

async function init() {
  renderLegend();
  wireEvents();

  try {
    const health = await api.health();
    el.brainName.textContent = health.brainName || 'Second Brain';
    document.title = `${health.brainName || 'Second Brain'} — 3D Knowledge Graph`;
    voice.setMode(health.voice?.startsWith('openai') ? 'server' : 'browser');

    if (!health.hasKey) {
      setStatus('not connected to a brain yet', true);
      systemMessage(
        'Nothing can talk back yet. In a terminal, run <code>npm run setup</code> — it will connect ' +
          'your Claude subscription, or tell you exactly what it needs.',
      );
    } else {
      setStatus(describeBrain(health), `${health.model} · ${health.embeddings} embeddings · ${health.voice} voice`);
    }
  } catch (err) {
    setStatus('server unreachable', true);
    systemMessage(`Could not reach the server: ${escapeHtml(err.message)}`);
  }

  await refreshGraph();
  connectLiveEvents();

  if (!graphData.nodes.length) {
    systemMessage(
      'Memory is empty. Tell it something true about your week and watch the graph build itself — ' +
        'or press <b>Help</b> for ideas.',
    );
  }
}

async function refreshGraph() {
  try {
    graphData = await api.graph();
    graph.setData(graphData);
    updateStats(graphData.stats);
  } catch (err) {
    console.warn('graph load failed', err);
  }
}

/**
 * Live stream of graph changes from anywhere — this UI, Claude Desktop, or
 * ChatGPT over MCP. Lets you talk to your brain in one place and watch it grow
 * in another.
 */
function connectLiveEvents() {
  let refreshTimer;
  const source = new EventSource('/api/events');

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshGraph, 350); // coalesce bursts of writes
  };

  // 'local' — tools ran in this process for a turn you typed here.
  // 'brain'  — same thing, but the subscription provider reached them over MCP.
  // 'mcp'    — genuinely another app: Claude Desktop, ChatGPT.
  const isElsewhere = (data) => data.source === 'mcp';

  source.addEventListener('graph_delta', (e) => {
    const data = parse(e);
    scheduleRefresh();
    if (isElsewhere(data)) showCaption('memory updated externally');
  });

  source.addEventListener('focus', (e) => {
    const data = parse(e);
    // A turn that ran in-process already flew the camera from the chat stream;
    // anything reaching tools over MCP — including our own subscription
    // provider — only ever surfaces here, so it has to be followed.
    if (data.source && data.source !== 'local' && data.ids?.length) {
      graph.focus(data.ids, data.note);
      if (isElsewhere(data) && data.note) showCaption(data.note);
    }
  });

  // The brain talking through an external host (Claude Desktop / ChatGPT).
  source.addEventListener('speak', (e) => {
    const data = parse(e);
    if (!data.text) return;
    addMessage('brain', data.text).classList.add('external');
    if (!voiceOn) return;
    if (audioArmed) {
      voice.speak(data.text);
      showCaption('speaking');
    } else {
      // Say so rather than failing silently — a mute brain looks broken.
      el.composerStatus.textContent = 'click anywhere to let it speak';
      showCaption('click to enable voice');
    }
  });

  source.onerror = () => {
    // EventSource reconnects on its own; surface it only if it stays down.
    setTimeout(() => {
      if (source.readyState === EventSource.CLOSED) setStatus('live updates disconnected', true);
    }, 4000);
  };

  const parse = (e) => {
    try {
      return JSON.parse(e.data);
    } catch {
      return {};
    }
  };
}

function updateStats(stats) {
  if (!stats) return;
  el.statChip.textContent = `${stats.nodes} · ${stats.edges}`;
  el.statChip.title = `${stats.nodes} memories, ${stats.edges} connections`;
}

// ── conversation ─────────────────────────────────────────────────────────────

async function send(overrideText) {
  const text = (overrideText ?? el.input.value).trim();
  if (!text || busy) return;

  el.input.value = '';
  autosize();
  audioArmed = true;
  voice.unlockAudio(); // this call sits inside a user gesture — the only place it works
  voice.cancel();

  addMessage('user', text);
  const brainMsg = addMessage('brain', '');
  const bubble = brainMsg.querySelector('.body');
  const thinkingEl = brainMsg.querySelector('.thinking-block');
  const toolTrace = brainMsg.querySelector('.tool-trace');

  setBusy(true);
  setMood('thinking');

  let answer = '';
  let graphDirty = false;

  try {
    await streamSSE('/api/chat', { message: text }, {
      recall: (d) => {
        if (d.ids?.length) graph.focus(d.ids, 'recalling');
        if (d.labels?.length) showCaption(`recalling: ${d.labels.slice(0, 3).join(', ')}`);
      },
      thinking: (d) => {
        if (!d.delta) return;
        thinkingEl.style.display = 'block';
        thinkingEl.textContent = (thinkingEl.textContent + d.delta).slice(-600);
        thinkingEl.scrollTop = thinkingEl.scrollHeight;
      },
      text_start: () => {
        thinkingEl.style.display = 'none';
        setMood('speaking');
      },
      text: (d) => {
        answer += d.delta;
        bubble.textContent = answer;
        if (voiceOn) voice.feed(d.delta);
        scrollMessages();
      },
      tool_start: (d) => addToolPill(toolTrace, d.name, 'running'),
      tool_result: (d) => markToolPill(toolTrace, d.name, d.ok),
      focus: (d) => {
        if (d.ids?.length) graph.focus(d.ids, d.note);
        if (d.note) showCaption(d.note);
      },
      graph_delta: () => {
        graphDirty = true;
      },
      error: (d) => {
        addMessage('error', d.message || 'Something went wrong.');
      },
      done: (d) => {
        updateStats(d.stats);
        if (d.usage) {
          const u = d.usage;
          brainMsg.title = `in ${u.input_tokens} · out ${u.output_tokens}${
            u.cache_read_input_tokens ? ` · cached ${u.cache_read_input_tokens}` : ''
          }`;
        }
      },
    });
  } catch (err) {
    addMessage('error', err.message);
  } finally {
    if (voiceOn) voice.flush();
    setBusy(false);
    if (!voice.speaking) setMood('idle');
    if (graphDirty) await refreshGraph();
    if (!answer.trim() && !bubble.textContent) bubble.textContent = '(no response)';
  }
}

async function consolidate() {
  if (busy) return;
  setBusy(true);
  setMood('thinking');
  const msg = addMessage('brain', '');
  const bubble = msg.querySelector('.body');
  const toolTrace = msg.querySelector('.tool-trace');
  let dirty = false;

  try {
    await streamSSE('/api/consolidate', {}, {
      text: (d) => {
        bubble.textContent += d.delta;
        scrollMessages();
      },
      tool_start: (d) => addToolPill(toolTrace, d.name, 'running'),
      tool_result: (d) => markToolPill(toolTrace, d.name, d.ok),
      focus: (d) => d.ids?.length && graph.focus(d.ids, d.note),
      graph_delta: () => {
        dirty = true;
      },
      error: (d) => addMessage('error', d.message),
      done: (d) => updateStats(d.stats),
    });
  } catch (err) {
    addMessage('error', err.message);
  } finally {
    setBusy(false);
    setMood('idle');
    if (dirty) await refreshGraph();
    if (voiceOn && bubble.textContent.trim()) voice.speak(bubble.textContent);
  }
}

// ── messages ─────────────────────────────────────────────────────────────────

function addMessage(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  if (kind === 'brain') {
    div.innerHTML = `
      <div class="tool-trace"></div>
      <div class="thinking-block" style="display:none"></div>
      <div class="body"></div>`;
    div.querySelector('.body').textContent = text;
  } else {
    div.textContent = text;
  }
  el.messages.appendChild(div);
  scrollMessages();
  return div;
}

function systemMessage(html) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.innerHTML = html;
  el.messages.appendChild(div);
  scrollMessages();
}

function addToolPill(container, name, _state) {
  const pill = document.createElement('span');
  pill.className = 'tool-pill';
  pill.dataset.tool = name;
  pill.textContent = prettyTool(name);
  container.appendChild(pill);
}

function markToolPill(container, name, ok) {
  const pills = [...container.querySelectorAll(`[data-tool="${CSS.escape(name)}"]`)];
  const pill = pills.find((p) => !p.dataset.done) || pills[pills.length - 1];
  if (!pill) return;
  pill.dataset.done = '1';
  if (!ok) pill.classList.add('err');
}

function prettyTool(name) {
  return (
    {
      recall_memory: 'searching memory',
      remember: 'storing',
      link_nodes: 'linking',
      update_node: 'revising',
      forget: 'forgetting',
      get_neighbors: 'tracing links',
      focus_view: 'looking',
      graph_stats: 'counting',
    }[name] || name
  );
}

function scrollMessages() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

// ── ui state ─────────────────────────────────────────────────────────────────

function setBusy(on) {
  busy = on;
  el.send.disabled = on;
  el.composerStatus.textContent = on ? 'thinking…' : '';
}

function setMood(mood) {
  graph.setMood(mood);
  el.brandOrb.classList.toggle('thinking', mood === 'thinking');
  el.brandOrb.classList.toggle('speaking', mood === 'speaking');
}

/** Plain English, not config values — the detail goes in the tooltip. */
function describeBrain(health) {
  if (health.provider === 'claude-code') return 'running on your Claude subscription';
  if (health.provider === 'anthropic') return 'running on Claude';
  return 'running on ChatGPT';
}

function setStatus(text, detailOrWarn = false) {
  el.statusLine.textContent = text;
  const warn = detailOrWarn === true;
  el.statusLine.style.color = warn ? 'var(--warn)' : '';
  el.statusLine.title = typeof detailOrWarn === 'string' ? detailOrWarn : '';
}

let captionTimer;
function showCaption(text) {
  if (!text) return;
  el.focusCaption.textContent = text;
  el.focusCaption.classList.add('show');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => el.focusCaption.classList.remove('show'), 4200);
}

function renderLegend() {
  el.legend.innerHTML = Object.entries(TYPE_COLORS)
    .map(([type, color]) => `<span><i style="background:${color}"></i>${type}</span>`)
    .join('');
}

// ── node inspector ───────────────────────────────────────────────────────────

async function showNode(node) {
  if (!node) return hideNode();
  selectedNode = node;
  el.nodeCard.classList.remove('hidden');
  el.nodeCardType.textContent = node.type;
  el.nodeCardTitle.textContent = node.label;
  el.nodeCardSummary.textContent = node.summary || '';
  el.nodeCardContent.textContent = node.content || '';
  el.nodeCardContent.style.display = node.content ? '' : 'none';
  el.nodeCardImportance.style.width = `${Math.round((node.importance ?? 0.5) * 100)}%`;
  el.nodeCardLinks.innerHTML = '<div class="link-row">loading…</div>';

  try {
    const { neighbors } = await api.node(node.id);
    el.nodeCardLinks.innerHTML = '';
    if (!neighbors.length) {
      el.nodeCardLinks.innerHTML = '<div class="link-row">no connections yet</div>';
      return;
    }
    for (const n of neighbors) {
      const row = document.createElement('div');
      row.className = 'link-row';
      row.innerHTML = `<span class="rel">${n.direction === 'out' ? '→' : '←'} ${escapeHtml(n.relation)}</span>
        <span>${escapeHtml(n.node.label)}</span>`;
      row.onclick = () => {
        const target = graphData.nodes.find((x) => x.id === n.node.id);
        graph.select(n.node.id);
        showNode(target || n.node);
      };
      el.nodeCardLinks.appendChild(row);
    }
  } catch {
    el.nodeCardLinks.innerHTML = '<div class="link-row">could not load links</div>';
  }
}

function hideNode() {
  selectedNode = null;
  el.nodeCard.classList.add('hidden');
}

// ── search ───────────────────────────────────────────────────────────────────

let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  const q = el.searchInput.value.trim();
  if (!q) {
    el.searchResults.innerHTML = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const { results } = await api.search(q);
      el.searchResults.innerHTML = '';
      if (!results.length) {
        el.searchResults.innerHTML = '<div class="result"><span class="label">nothing found</span></div>';
        return;
      }
      graph.focus(results.slice(0, 6).map((r) => r.node.id), `search: ${q}`);
      for (const r of results) {
        const row = document.createElement('div');
        row.className = 'result';
        row.innerHTML = `<span class="dot" style="background:${TYPE_COLORS[r.node.type] || '#8ab4ff'}"></span>
          <span class="label">${escapeHtml(r.node.label)}</span>
          <span class="score">${r.score.toFixed(2)}</span>`;
        row.onclick = () => {
          graph.select(r.node.id);
          showNode(graphData.nodes.find((n) => n.id === r.node.id) || r.node);
        };
        el.searchResults.appendChild(row);
      }
    } catch (err) {
      console.warn('search failed', err);
    }
  }, 220);
}

// ── events ───────────────────────────────────────────────────────────────────

function wireEvents() {
  graph.onSelect((node) => (node ? showNode(node) : hideNode()));

  const arm = () => {
    if (audioArmed) return;
    audioArmed = true;
    voice.unlockAudio();
    if (el.composerStatus.textContent === 'click anywhere to let it speak') el.composerStatus.textContent = '';
  };
  document.addEventListener('pointerdown', arm, { once: false, capture: true });
  document.addEventListener('keydown', arm, { once: false, capture: true });

  el.send.onclick = () => send();
  el.input.addEventListener('input', autosize);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  el.searchInput.addEventListener('input', onSearch);

  el.btnVoice.onclick = () => {
    voiceOn = !voiceOn;
    voice.setEnabled(voiceOn);
    el.btnVoice.classList.toggle('active', voiceOn);
    el.btnVoice.querySelector('.ico').textContent = voiceOn ? '🔊' : '🔇';
  };
  el.btnVoice.classList.add('active');

  el.btnMic.onclick = () => {
    if (!ears.supported) {
      systemMessage('Speech recognition is not available in this browser. Chrome and Edge support it.');
      return;
    }
    voice.unlockAudio();
    ears.toggle();
  };

  const showHelp = (on) => el.helpPanel.classList.toggle('hidden', !on);
  el.btnHelp.onclick = () => showHelp(true);
  el.helpClose.onclick = () => showHelp(false);
  el.helpPanel.onclick = (e) => {
    if (e.target === el.helpPanel) showHelp(false); // click the backdrop to dismiss
  };
  // The examples aren't decoration — clicking one sends it.
  for (const li of el.helpPanel.querySelectorAll('.examples li')) {
    li.onclick = () => {
      showHelp(false);
      send(li.textContent.replace(/^[\s“"]+|[\s”"]+$/g, ''));
    };
  }

  el.btnConsolidate.onclick = consolidate;
  el.btnReset.onclick = () => {
    graph.resetView();
    hideNode();
  };

  el.nodeCardClose.onclick = hideNode;
  el.nodeAsk.onclick = () => {
    if (selectedNode) send(`Tell me everything you know about "${selectedNode.label}" and what it connects to.`);
  };
  el.nodeForget.onclick = async () => {
    if (!selectedNode) return;
    if (!confirm(`Archive "${selectedNode.label}"? It stops appearing in recall but stays in the export file.`)) {
      return;
    }
    await api.deleteNode(selectedNode.id);
    hideNode();
    await refreshGraph();
  };

  el.chatCollapse.onclick = () => {
    const collapsed = el.chatPanel.classList.toggle('collapsed');
    el.chatCollapse.textContent = collapsed ? '+' : '−';
  };

  el.panelToggle.onclick = () => {
    el.leftPanel.classList.toggle('hidden-mobile');
    el.chatPanel.classList.toggle('hidden-mobile');
  };

  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      voice.cancel();
      hideNode();
      el.helpPanel.classList.add('hidden');
      return;
    }
    if (typing) return;
    if (e.key === '?') el.btnHelp.click();
    if (e.key === 'v') el.btnVoice.click();
    if (e.key === 'r') el.btnReset.click();
    if (e.key === '/') {
      e.preventDefault();
      el.searchInput.focus();
    }
    if (e.code === 'Space') {
      e.preventDefault();
      el.btnMic.click();
    }
  });

  // The canvas sizes off its parent, which only settles after first layout.
  requestAnimationFrame(() => graph.resize());
}

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 132)}px`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
