// Skill store — reusable "how-to" procedures AVA captures from successful tasks.
// One markdown file per skill (with simple frontmatter) under memory/skills/, plus an
// always-available INDEX. Maturity counter: a skill becomes "proven" after repeats.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import avaPaths from '../utils/paths.js';

function integrationDir() {
  return process.env.AVA_INTEGRATION_DIR || avaPaths.integrationDir();
}
function skillsDir() { return path.join(integrationDir(), 'memory', 'skills'); }
function consolidationPath() { return path.join(skillsDir(), 'CONSOLIDATION.json'); }
function ensureDir() { try { fs.mkdirSync(skillsDir(), { recursive: true }); } catch { /* ignore */ } }
function slug(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'skill';
}

const SKILL_STOP = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'using', 'with']);
function skillTokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !SKILL_STOP.has(t)));
}
function similarity(a, b) {
  const aa = skillTokens(a); const bb = skillTokens(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;
  return common / Math.max(aa.size, bb.size);
}

function similarSkill(title, when) {
  const threshold = Math.min(0.95, Math.max(0.5, Number(process.env.AVA_SKILL_SIMILARITY) || 0.68));
  const query = `${title || ''} ${when || ''}`;
  return listSkills()
    .map(skill => ({ skill, score: similarity(query, `${skill.title} ${skill.when}`) }))
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score)[0] || null;
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

function readConsolidation() {
  try {
    const parsed = JSON.parse(fs.readFileSync(consolidationPath(), 'utf8'));
    return parsed && typeof parsed.aliases === 'object' ? parsed : { aliases: {} };
  } catch {
    return { aliases: {} };
  }
}

function readAllSkills() {
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

export function listSkills({ includeAliases = false } = {}) {
  const skills = readAllSkills();
  if (includeAliases) return skills;
  const aliases = readConsolidation().aliases;
  return skills.filter(skill => !aliases[skill.slug]);
}

export function getSkill(idOrTitle) {
  const s1 = slug(idOrTitle);
  const canonical = readConsolidation().aliases[s1] || s1;
  return listSkills().find((s) => s.slug === canonical || s.title.toLowerCase() === String(idOrTitle).toLowerCase()) || null;
}

function skillRank(skill) {
  return (Number(skill.proven) * 1000000) + (skill.uses * 10000) + Math.min(skill.body.length, 9999);
}

/** Build a reversible alias plan for genuinely overlapping learned procedures. */
export function buildConsolidationPlan({ threshold } = {}) {
  const similarityThreshold = Math.min(0.95, Math.max(0.5,
    Number(threshold ?? process.env.AVA_SKILL_CONSOLIDATION_SIMILARITY) || 0.72));
  const ranked = readAllSkills().sort((a, b) => skillRank(b) - skillRank(a));
  const canonical = [];
  const groups = new Map();
  const aliases = {};

  for (const candidate of ranked) {
    const candidateText = `${candidate.title} ${candidate.when} ${candidate.tags}`;
    const match = canonical
      .map(skill => ({ skill, score: similarity(candidateText, `${skill.title} ${skill.when} ${skill.tags}`) }))
      .filter(item => item.score >= similarityThreshold)
      .sort((a, b) => b.score - a.score)[0];
    if (!match) {
      canonical.push(candidate);
      groups.set(candidate.slug, []);
      continue;
    }
    aliases[candidate.slug] = match.skill.slug;
    groups.get(match.skill.slug).push({ slug: candidate.slug, similarity: Number(match.score.toFixed(3)) });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    threshold: similarityThreshold,
    totalSkills: ranked.length,
    canonicalSkills: canonical.length,
    aliasCount: Object.keys(aliases).length,
    aliases,
    groups: [...groups.entries()]
      .filter(([, members]) => members.length)
      .map(([canonicalSlug, members]) => ({ canonical: canonicalSlug, members })),
  };
}

export function saveConsolidationPlan(plan) {
  ensureDir();
  const target = consolidationPath();
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
  rebuildIndex();
  return target;
}

export function saveSkill({ title, when, steps, tags, notes }) {
  ensureDir();
  const match = similarSkill(title, when);
  if (match) title = match.skill.title;
  const s = match ? match.skill.slug : slug(title);
  const p = path.join(skillsDir(), s + '.md');
  const existing = parse(p);
  let uses = 1, created = new Date().toISOString().slice(0, 10);
  if (existing) { uses = (parseInt(existing.meta.uses || '1', 10) || 1) + 1; created = existing.meta.created || created; }
  const proven = uses >= 3;
  const stepsArr = Array.isArray(steps) ? steps : String(steps || '').split('\n').filter(Boolean);
  const proposedBody = [
    `WHEN: ${when || ''}`,
    'STEPS:',
    ...stepsArr.map((st, i) => `${i + 1}. ${String(st).replace(/^\s*\d+[.)]\s*/, '')}`),
    notes ? `NOTES: ${notes}` : '',
  ].filter(Boolean).join('\n');
  // Repeated captures prove an existing skill; they should not overwrite a
  // mature procedure with a differently worded, lower-information variant.
  const body = existing && existing.body.trim().length >= proposedBody.trim().length
    ? existing.body.trim()
    : proposedBody;
  const fm = `---\ntitle: ${title}\nslug: ${s}\nuses: ${uses}\nproven: ${proven}\n`
    + `tags: ${Array.isArray(tags) ? tags.join(', ') : (tags || '')}\ncreated: ${created}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n`;
  fs.writeFileSync(p, fm + body + '\n', 'utf8');
  rebuildIndex();
  logger?.info?.('[skillStore] saved skill', { slug: s, uses, proven });
  return { slug: s, uses, proven, created: !existing, mergedInto: match ? s : null };
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

export default {
  listSkills, getSkill, saveSkill, searchSkills, buildSkillsIndex, rebuildIndex,
  buildConsolidationPlan, saveConsolidationPlan,
  paths: { skillsDir, consolidationPath },
};
