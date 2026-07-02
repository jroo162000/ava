// liveBus — Tier 2 #15 (transport unification): ONE WebSocket (/voice/ws, owned by
// MinimalAVA) fans every server event out to any component that cares. Components
// subscribe here instead of polling REST endpoints. MinimalAVA also publishes a
// synthetic { type: 'ws.open' } whenever the socket (re)connects, so subscribers can
// re-fetch their snapshot once and then stay purely event-driven.
const handlers = new Set();

export function publish(event) {
  for (const h of [...handlers]) {
    try { h(event); } catch { /* one bad subscriber never breaks the fan-out */ }
  }
}

export function subscribe(handler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
