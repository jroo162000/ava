// Skill store — reusable "how-to" procedures AVA captures from successful tasks.
// One markdown file per skill (with simple frontmatter) under memory/skills/, plus an
// always-available INDEX. Maturity counter: a skill becomes "proven" after repeats.
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';

function integrationDir() {
  const home = os.homedir();
  return process.env.AVA_INTEGRATION_DIR || path.join(home, 'ava', 'ava-integration');
}
function skillsDir() { return path.join(integrationDir(), 'memory', 'skills'); }
function ensureDir() { try { fs.mkdirSync(skillsDir(), { recursive: true }); } catch { /* ignore */ } }
function slug(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'skill';
}

function parse(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta = {}; let body = raw;
    if (m) {
      body = m[2];
      for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
    return { meta, body, slug: path.basename(file, '.md') };
  } catch { return null; }
}

export function listSkills() {
  ensureDir();
  let files = [];
  try { files = fs.readdirSync(skillsDir()).filter((f) => f.endsWith('.md') && f !== 'INDEX.md'); } catch { /* none */ }
  return files.map((f) => parse(path.join(skillsDir(), f))).filter(Boolean).map((s) => ({
    slug: s.slug,
    title: s.meta.title || s.slug,
    uses: parseInt(s.meta.uses || '1', 10) || 1,
    proven: s.meta.proven === 'true',
    tags: s.meta.tags || '',
    when: ((s.body.match(/WHEN:\s*(.*)/i) || [])[1] || '').trim(),
    body: s.body,
  }));
}

export function getSkill(idOrTitle) {
  const s1 = slug(idOrTitle);
  return listSkills().find((s) => s.slug === s1 || s.title.toLowerCase() === String(idOrTitle).toLowerCase()) || null;
}

export function saveSkill({ title, when, steps, tags, notes }) {
  ensureDir();
  const s = slug(title);
  const p = path.join(skillsDir(), s + '.md');
  const existing = parse(p);
  let uses = 1, created = new Date().toISOString().slice(0, 10);
  if (existing) { uses = (parseInt(existing.meta.uses || '1', 10) || 1) + 1; created = existing.meta.created || created; }
  const proven = uses >= 3;
  const stepsArr = Array.isArray(steps) ? steps : String(steps || '').split('\n').filter(Boolean);
  const body = [
    `WHEN: ${when || ''}`,
    'STEPS:',
    ...stepsArr.map((st, i) => `${i + 1}. ${String(st).replace(/^\s*\d+[.)]\s*/, '')}`),
    notes ? `NOTES: ${notes}` : '',
  ].filter(Boolean).join('\n');
  const fm = `---\ntitle: ${title}\nslug: ${s}\nuses: ${uses}\nproven: ${proven}\n`
    + `tags: ${Array.isArray(tags) ? tags.join(', ') : (tags || '')}\ncreated: ${created}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n`;
  fs.writeFileSync(p, fm + body + '\n', 'utf8');
  rebuildIndex();
  logger?.info?.('[skillStore] saved skill', { slug: s, uses, proven });
  return { slug: s, uses, proven, created: !existing };
}

export function rebuildIndex() {
  const all = listSkills().sort((a, b) => b.uses - a.uses);
  const lines = ['# AVA Skills Index', ''].concat(
    all.map((s) => `- ${s.title}${s.proven ? ' (proven)' : ''} — ${s.when}`.slice(0, 200)),
  );
  try { fs.writeFileSync(path.join(skillsDir(), 'INDEX.md'), lines.join('\n') + '\n', 'utf8'); } catch { /* ignore */ }
}

// Compact index injected into the agent prompt (warm memory: titles + when-to-use).
export function buildSkillsIndex(maxChars = 900) {
  const all = listSkills().sort((a, b) => (Number(b.proven) - Number(a.proven)) || (b.uses - a.uses));
  if (!all.length) return '';
  let out = 'SAVED SKILLS (reusable how-tos you have learned; get full steps via memory_search):\n';
  for (const s of all) {
    const line = `- ${s.title}${s.proven ? ' [proven]' : ''}: ${s.when}\n`;
    if ((out.length + line.length) > maxChars) break;
    out += line;
  }
  return out.trim();
}

export function searchSkills(query, terms) {
  const ql = String(query || '').toLowerCase();
  const out = [];
  for (const s of listSkills()) {
    const hay = `${s.title} ${s.tags} ${s.body}`.toLowerCase();
    const score = (terms || []).reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0) + (ql && hay.includes(ql) ? 2 : 0);
    if (score > 0) out.push({ source: 'skill', label: s.title, date: '', score: score + 4, text: `${s.title}: ${s.when}` });
  }
  return out;
}

export default { listSkills, getSkill, saveSkill, searchSkills, buildSkillsIndex, rebuildIndex, paths: { skillsDir } };
