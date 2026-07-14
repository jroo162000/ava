import fs from 'fs';
const OUT = 'C:\\Users\\Dell\\Claude\\Projects\\AVA Development\\codex_review\\selfmod_audit.json';
const base = 'http://localhost:5051';
async function call(action, extra = {}) {
  try {
    const r = await fetch(base + '/self_mod', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
    let j; try { j = await r.json(); } catch { j = { _status: r.status, _text: await r.text().catch(() => '') }; }
    return j;
  } catch (e) { return { _error: e.message }; }
}
const out = {};
for (const a of ['get_status', 'list_modifications', 'list_all', 'list_pending']) {
  out[a] = await call(a);
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('audit done');
process.exit(0);
