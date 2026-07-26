/**
 * Tiny broadcast bus for live viewers.
 *
 * The 3D view used to refresh only after a chat turn in its own UI. Once Claude
 * Desktop or ChatGPT can write memories over MCP, the graph changes with no
 * local turn to hang a refresh off — so mutations are broadcast here and every
 * open viewer reacts.
 */

const subscribers = new Set();

export function subscribe(send) {
  subscribers.add(send);
  return () => subscribers.delete(send);
}

export function broadcast(event, data = {}) {
  for (const send of subscribers) {
    try {
      send(event, data);
    } catch {
      // A dead connection is dropped by its own close handler; never let one
      // broken viewer break a memory write.
      subscribers.delete(send);
    }
  }
}

export function viewerCount() {
  return subscribers.size;
}
