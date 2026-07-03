// presenter.js -- AVA's visual DIRECTOR. After a reply, it decides (for visual/newsy/how-to topics)
// whether to present, and if so plans ONLY the cards that genuinely help (0..~6, any mix), gathers
// REAL content via her web tools (news + og:image, a photo, a YouTube clip) and diagrams/tables she
// writes, then opens them and picks the layout + placement. It is HER call how many, which, how they
// are arranged, and where -- there is no fixed template. Runs fire-and-forget so it never delays speech.
import llmService from './llm.js';
import toolsService from './tools.js';
import artifactBus from './artifactBus.js';
import logger from '../utils/logger.js';

const PLAN_SYS = `You are AVA's visual DIRECTOR for a live presentation panel. Given the user's question and AVA's spoken answer, decide whether a visual presentation helps and, if so, plan it. Return ONLY JSON.
{"present": false}  -- when visuals would not help (plain chat, a one-line answer, a pure action confirmation).
{"present": true, "layout": "spread" | "stack", "cards": [ CARD, ... ]}
Each CARD is exactly one of:
 {"kind":"news","title":"...","query":"search query for current articles"}
 {"kind":"image","title":"...","query":"what photo to find"}
 {"kind":"video","title":"...","query":"what youtube clip to find"}
 {"kind":"diagram","title":"...","content":"<valid mermaid>"}
 {"kind":"table","title":"...","content":"<markdown table>"}
 {"kind":"note","title":"...","content":"<short markdown>"}
Optionally add "pos":{"x":0..1,"y":0..1} to place a card.
RULES:
- Include ONLY the cards that genuinely help THIS answer. Use as few or as many as needed (0 to 6). Do NOT include every kind every time -- a how-to might be a diagram + a video; a news question might be only news; a person/place might be a photo + a couple of facts. Pull an item only if it adds something.
- The number of cards, which kinds, the layout, and the placement are all YOUR call. There is no default arrangement.
- Mermaid must be valid (e.g. start "flowchart TD"), short labels, no parentheses/quotes inside labels.
- Keep queries specific and current. Never invent facts.`;

function host(u) { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

async function webSearch(query, n = 5) {
  try {
    const r = await toolsService.executeTool('web_search', { query, max_results: n }, false, { source: 'presenter', bypassIdempotency: true });
    const inner = (r && (r.result || r)) || {};
    const results = inner.results || (inner.result && inner.result.results) || [];
    return Array.isArray(results) ? results : [];
  } catch { return [] }
}
async function ogImage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    const html = await res.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return m ? m[1] : '';
  } catch { return '' }
}
async function youtubeSearch(query) {
  try {
    const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const m = html.match(/"videoId":"([\w-]{11})"/);
    return m ? m[1] : '';
  } catch { return '' }
}

async function buildCard(card) {
  const kind = String(card.kind || '').toLowerCase();
  const pos = card.pos && typeof card.pos === 'object' ? { pos: card.pos } : {};
  if (kind === 'news') {
    const results = await webSearch(card.query || card.title, 5);
    if (!results.length) return null;
    const items = [];
    for (let i = 0; i < Math.min(results.length, 5); i++) { const r = results[i]; const image = i < 2 ? await ogImage(r.url).catch(() => '') : ''; items.push({ title: r.title, source: host(r.url), url: r.url, snippet: r.snippet, image }); }
    return { type: 'news', title: card.title || 'In the news', content: items, meta: pos };
  }
  if (kind === 'image' || kind === 'photo') {
    const results = await webSearch(card.query || card.title, 4);
    let img = ''; for (const r of results) { img = await ogImage(r.url).catch(() => ''); if (img) break; }
    if (!img) return null;
    return { type: 'image', title: card.title || 'Photo', content: img, meta: pos };
  }
  if (kind === 'video') {
    const id = await youtubeSearch(card.query || card.title);
    if (!id) return null;
    return { type: 'video', title: card.title || 'Video', content: id, meta: pos };
  }
  if (kind === 'diagram' || kind === 'mermaid') return { type: 'mermaid', title: card.title || 'Diagram', content: String(card.content || ''), meta: pos };
  if (kind === 'table') return { type: 'table', title: card.title || '', content: String(card.content || ''), meta: pos };
  if (!String(card.content || '').trim()) return null;
  return { type: 'markdown', title: card.title || '', content: String(card.content || ''), meta: pos };
}

export async function present(userText, replyText, { force = false, sessionId = '' } = {}) {
  try {
    const reply = String(replyText || '').trim();
    if (!force && reply.length < 220) return null;
    // Don't decorate a failure/incompletion: when the reply says the action did NOT happen
    // ("I haven't opened it yet", "that part didn't happen", "couldn't"), illustrative media
    // (a stock photo / random YouTube video) misrepresents the outcome — 2026-07-03 a
    // "3D Hologram Preview" card showing an unrelated YouTube video landed on the panel while
    // the hologram was never opened. Real artifacts still reach the panel via the tool-result
    // preview_url auto-present hook in agentLoop.
    if (!force && /\b(didn'?t happen|haven'?t\b|hasn'?t (been|happened)|not (yet|able)|couldn'?t|wasn'?t able|failed to|did not (run|happen|open))\b/i.test(reply)) return null;
    const usr = `User asked:\n${String(userText || '').slice(0, 800)}\n\nAVA answered:\n${reply.slice(0, 2500)}\n\n${force ? 'The user explicitly asked to SEE something, so present (present:true) with the cards that fit.' : 'Decide whether to present, and if so plan only the cards that genuinely help.'}`;
    const r = await llmService.chat([{ role: 'system', content: PLAN_SYS }, { role: 'user', content: usr }], { temperature: 0.3, max_tokens: 900 });
    const raw = String(r.text || r.content || '').trim();
    const m = raw.match(/\{[\s\S]*\}/); if (!m) return null;
    let plan; try { plan = JSON.parse(m[0]) } catch { return null }
    if (!plan || !plan.present || !Array.isArray(plan.cards) || !plan.cards.length) return null;
    // A live localhost artifact IS the visual: when the reply carries a localhost preview URL
    // (scene3d / web_builder result — already auto-presented as a web card), web-SEARCHED
    // image/video cards for the same thing are look-alike stock media, not the user's artifact
    // (2026-07-03: Meshy's website OG image landed on the panel as "3D Hologram Preview" next
    // to the real scene). Keep markdown/table/mermaid cards; drop searched media for this turn.
    const _hasLiveArtifact = /https?:\/\/(localhost|127\.0\.0\.1)/i.test(reply);
    if (_hasLiveArtifact) plan.cards = plan.cards.filter((c) => !/^(image|photo|video)$/i.test(String((c && c.kind) || '')));
    if (!plan.cards.length) return null;
    if (plan.layout === 'stack' || plan.layout === 'spread') artifactBus.setLayout(plan.layout);
    const built = [];
    for (const c of plan.cards.slice(0, 6)) { const card = await buildCard(c); if (card) built.push(artifactBus.open(card).id) }
    if (built.length) artifactBus.focus(built[0]);
    logger.info('[presenter] presented', { cards: built.length, layout: plan.layout });
    return { cards: built.length };
  } catch (e) { logger.warn('[presenter] failed', { error: e.message }); return null; }
}
export default { present };
