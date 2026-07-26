const json = async (res) => {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  return res.json();
};

export const api = {
  health: () => fetch('/api/health').then(json),
  graph: () => fetch('/api/graph').then(json),
  node: (id) => fetch(`/api/node/${encodeURIComponent(id)}`).then(json),
  search: (q) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then(json),

  createNode: (node) =>
    fetch('/api/node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(node),
    }).then(json),

  updateNode: (id, patch) =>
    fetch(`/api/node/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json),

  deleteNode: (id, hard = false) =>
    fetch(`/api/node/${encodeURIComponent(id)}${hard ? '?hard=1' : ''}`, { method: 'DELETE' }).then(json),

  tts: async (text, voice) => {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return res.blob();
  },

  exportUrl: '/api/export',
};

/**
 * POST an SSE stream and dispatch events to handlers.
 * EventSource can't POST, so we parse the wire format ourselves.
 *
 * @param {string} url
 * @param {object} body
 * @param {Record<string, (data: object) => void>} handlers  keyed by event name; '*' catches all
 * @param {AbortSignal} [signal]
 */
export async function streamSSE(url, body, handlers, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`stream failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (event, data) => {
    handlers['*']?.(event, data);
    handlers[event]?.(data);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line.
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (!frame.trim() || frame.startsWith(':')) continue; // keep-alive comment

      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try {
        dispatch(event, JSON.parse(dataLines.join('\n')));
      } catch {
        dispatch(event, { raw: dataLines.join('\n') });
      }
    }
  }
}
