// /train/* — training guidance rules, the LLM rule proposer, task suggestion, and the trainer
// dashboard (control panel). Extracted verbatim from routes/api.js (Tier 2 split) — logic unchanged.
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import llmService from '../services/llm.js';
import trainingGuidance from '../services/trainingGuidance.js';
import avaPaths from '../utils/paths.js';  // Tier 1 #8: one path resolver

const router = express.Router();

// -------- Training guidance (learned routing/behavior playbook) --------
router.get('/train/guidance', (_req, res) => {
  try { return res.json({ ok: true, rules: trainingGuidance.listRules() }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/train/guidance', (req, res) => {
  try { const id = trainingGuidance.addRule(req.body && req.body.text); return res.json({ ok: true, id, rules: trainingGuidance.listRules() }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/train/guidance', (req, res) => {
  try { const rules = trainingGuidance.setRules((req.body && req.body.rules) || []); return res.json({ ok: true, rules }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// LLM proposer: read the failure digest, propose ONE general guidance rule.
router.post('/train/propose', async (req, res) => {
  try {
    const failures = (req.body && req.body.failures) || [];
    const current = (req.body && req.body.current_rules) || [];
    const tried = (req.body && req.body.tried_rules) || [];
    if (!failures.length) return res.json({ ok: true, rule: '', reason: 'no failures' });

    // Detect recurring NON-routing failure modes so we can steer the proposer at them.
    const fc = (f) => (f.failed_checks || []).join(' ').toLowerCase();
    const honestyFail = failures.some((f) => /file_missing|file_text_missing/.test(fc(f))
      && /success|successfully|added|created|done|saved/i.test(String(f.response || '')));
    const overAskFail = failures.some((f) => (!(f.tools_used || []).length)
      && /\?|confirm|clarify|what (do|would) you|can you (confirm|tell)/i.test(String(f.response || '')));
    const hints = [];
    if (honestyFail) hints.push('At least one failure shows she CLAIMED success while the file did NOT change. Strongly consider: "After creating, writing, or appending to a file, read it back to confirm it exists and contains the expected text before telling the user it succeeded."');
    if (overAskFail) hints.push('At least one failure shows she ASKED the user to confirm/clarify a benign, unambiguous request instead of acting. Strongly consider: "For benign unambiguous requests (open a named file or app, read the screen, list windows), act immediately with the right tool — do not ask the user to confirm or clarify."');
    const sys = [
      'You improve a Windows voice assistant\'s TOOL ROUTING and HONESTY by writing ONE guidance rule.',
      'You are given tasks she FAILED: the user request, the tools she WRONGLY used (used tools),',
      'the EXPECTED tools (shown like "tool_called_any:fs_find|fs_ops"), and what she said.',
      '',
      'Write ONE rule that fixes the most impactful, RECURRING pattern. The rule MUST:',
      '- Name the EXACT correct tool(s) and the user-intent / trigger words that should route to them,',
      '  and the wrong tool to avoid. Preferred form: "When the user asks to <intent/trigger words>,',
      '  use <correct_tool> — do not use <wrong_tool>."',
      '- Be GENERAL across similar requests (e.g. cover BOTH finding AND reading files in one rule),',
      '  but NEVER name a specific file, person, task id, number, or answer value.',
      '- Be imperative, under 200 characters.',
      '- For honesty failures (she claimed success but the file did not change): tell her to read the',
      '  file back to confirm after any write/append/create before telling the user it succeeded.',
      '- Never weaken safety: keep confirmation for sending email, deleting, or moving money.',
      '',
      'TOOL CATALOG (name :: when to use):',
      'fs_find :: find / locate files by name',
      'fs_read :: read a file\'s contents',
      'fs_ops :: file ops: read, write, append, list, delete',
      'file_gen :: create / write a new file (txt, docx, xlsx, pdf...)',
      'open_item :: open an APP, a URL, or launch a file in its app — NOT for finding or reading file contents',
      'screen_ops / vision_ops :: see / read what is on the screen',
      'camera_ops :: see / describe the webcam',
      'window_ops :: list / manage open windows',
      'comm_ops :: email read / send / reply',
      'calendar_ops :: calendar list / create',
      'sys_ops :: system info (cpu / memory / disk)',
      'iot_ops :: smart-home device control',
      'audio_ops :: volume / speak',
      'memory_search :: recall past conversations / what we discussed',
      'browser_automation / net_ops :: search the web / open and read web pages',
      'self_awareness :: introspect; check/diagnose whether one of HER OWN tools is working (read-only)',
      'self_mod :: diagnose a specific tool (diagnose_tool) and propose repairs',
      'NOTE: to diagnose/check/test one of HER OWN tools (e.g. "is your email tool working"), use',
      'self_awareness or self_mod — NOT the tool being asked about (do not call comm_ops to check email).',
      '',
      'Output ONLY JSON: {"rule":"...","reason":"..."}',
    ].join('\n');
    const usr = [
      'EXISTING RULES (already live — do not duplicate):',
      current.length ? current.map((r) => '- ' + (r.text || r)).join('\n') : '(none)',
      '',
      'ALREADY-TRIED RULES (these were tested and did NOT help — do NOT propose anything like them):',
      tried.length ? tried.map((r) => '- ' + (r.text || r)).join('\n') : '(none)',
      hints.length ? '\nTARGETED HINTS:\n' + hints.map((h) => '* ' + h).join('\n') : '',
      '',
      'FAILED TASKS:',
      failures.map((f) => `- request: "${f.prompt}"\n  used tools: [${(f.tools_used || []).join(', ')}]\n  expected: ${(f.failed_checks || []).join('; ')}\n  she said: ${String(f.response || '').slice(0, 160)}`).join('\n'),
    ].join('\n');
    const r = await llmService.chat([
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ], { temperature: 0.3, max_tokens: 300 });
    const raw = (r.text || r.content || '').trim();
    let rule = '', reason = '';
    try { const m = raw.match(/\{[\s\S]*\}/); const j = JSON.parse(m ? m[0] : raw); rule = String(j.rule || '').trim(); reason = String(j.reason || '').trim(); }
    catch { rule = raw.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 200); }
    return res.json({ ok: true, rule, reason });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// Draft a GRADED training task from a real request AVA fumbled (for human review).
router.post('/train/suggest_task', async (req, res) => {
  try {
    const prompt = String((req.body && req.body.prompt) || '').trim();
    const response = String((req.body && req.body.response) || '');
    if (!prompt) return res.json({ ok: true, task: null });
    const sys = [
      'You convert a request AVA fumbled into a GRADED training task spec.',
      'Given the user request and AVA\'s failed/over-asking response, decide what AVA SHOULD have done.',
      'Pick the single best tool (name only) from this catalog:',
      'fs_find, fs_read, fs_ops, file_gen, open_item, screen_ops, vision_ops, window_ops, camera_ops, comm_ops,',
      'calendar_ops, sys_ops, iot_ops, audio_ops, memory_search, browser_automation, self_awareness, self_mod,',
      'analysis_ops, ps_exec, mouse_ops, key_ops, remote_ops, security_ops, proactive_ops, voice_ops, computer_use.',
      'If the request is not actually a tool task (pure chit-chat), set tool to "".',
      'Output ONLY JSON: {"category":"<short>","tool":"<tool or empty>","response_keyword":"<one word the right answer would contain, or empty>"}',
    ].join('\n');
    const usr = `USER REQUEST: ${prompt}\nAVA RESPONSE (fumbled): ${response.slice(0, 200)}`;
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { temperature: 0.2, max_tokens: 150 });
    const raw = (r.text || r.content || '').trim();
    let j = {};
    try { const m = raw.match(/\{[\s\S]*\}/); j = JSON.parse(m ? m[0] : raw); } catch { /* ignore */ }
    return res.json({ ok: true, task: { category: j.category || 'misc', tool: j.tool || '', response_keyword: j.response_keyword || '' } });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ===================== Trainer dashboard (control panel) =====================
function _intDir() { return avaPaths.integrationDir(); }  // Tier 1 #8: one path resolver
function _helpDir() { return path.join(_intDir(), 'ava_session_helpers'); }
function _trainDir() { return path.join(_intDir(), 'training'); }
function _readText(p, max = 20000) { try { const t = fs.readFileSync(p, 'utf8'); return t.length > max ? t.slice(-max) : t; } catch { return ''; } }
function _readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function _spawnBat(bat) {
  const child = spawn('cmd.exe', ['/c', path.join(_helpDir(), bat)], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
function _promptKey(p) { return crypto.createHash('md5').update(String(p || '').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 10); }
function _markSeen(prompt) {
  try {
    const f = path.join(_trainDir(), 'harvest_seen.json');
    let seen = []; try { seen = (JSON.parse(fs.readFileSync(f, 'utf8')) || {}).seen || []; } catch { seen = []; }
    const k = _promptKey(prompt);
    if (!seen.includes(k)) { seen.push(k); fs.writeFileSync(f, JSON.stringify({ seen: seen.slice(-2000) }, null, 2)); }
  } catch { /* best effort */ }
}

router.get('/train/ui', (_req, res) => {
  try { res.set('Content-Type', 'text/html').send(fs.readFileSync(path.join(_helpDir(), 'train_dashboard.html'), 'utf8')); }
  catch (e) { res.status(500).send('dashboard not found: ' + e.message); }
});

router.get('/train/state', (_req, res) => {
  try {
    const help = _helpDir(), train = _trainDir();
    // running = lock flag present, recent, AND the journal is still being written (self-heals
    // a stale lock left by a crashed/killed run, so the Run button never gets stuck disabled).
    let running = false;
    try {
      const flagP = path.join(help, 'train_active.flag');
      const t = parseInt(fs.readFileSync(flagP, 'utf8'), 10) || 0;
      const flagAge = Date.now() - t;
      let jAge = Infinity; try { jAge = Date.now() - fs.statSync(path.join(help, 'meta_journal.txt')).mtimeMs; } catch { /* no journal */ }
      running = (flagAge < 1000 * 60 * 180) && (flagAge < 1000 * 60 * 4 || jAge < 1000 * 60 * 15);
      if (!running) { try { fs.unlinkSync(flagP); } catch { /* ignore */ } }   // clear stale lock
    } catch { running = false; }
    // phase + progress + tail from the journal
    let journalTail = '', phase = '', progress = 0;
    try {
      const all = fs.readFileSync(path.join(help, 'meta_journal.txt'), 'utf8');
      journalTail = all.trim().split('\n').slice(-60).join('\n');
      if (/REPORT written|ABORTED/.test(all.slice(-400))) { phase = running ? 'finishing' : 'done'; progress = running ? 95 : 100; }
      else if (/VALIDATE on holdout/.test(all)) { phase = 'validating on held-out set'; progress = 90; }
      else { const m = [...all.matchAll(/\[iter (\d+)\]/g)]; if (m.length) { phase = 'iteration ' + m[m.length - 1][1]; progress = Math.min(88, 35 + m.length * 12); } else if (/BASELINE/.test(all)) { phase = 'baseline'; progress = 20; } else if (running) { phase = 'starting'; progress = 5; } }
    } catch { /* no journal yet */ }

    let tasks = null;
    try {
      const d = _readJson(path.join(train, 'tasks.json'), { tasks: [], _holdout: [] });
      const hold = new Set(d._holdout || []); let total = 0, tr = 0, ho = 0; const byCat = {};
      for (const t of (d.tasks || [])) {
        const n = Array.isArray(t.prompts) && t.prompts.length ? t.prompts.length : 1;
        total += n; byCat[t.category || '?'] = (byCat[t.category || '?'] || 0) + n;
        if (hold.has(t.id)) ho += n; else tr += n;
      }
      tasks = { total, train: tr, holdout: ho, byCategory: byCat };
    } catch { /* ignore */ }

    let history = [];
    try { history = _readText(path.join(train, 'history.jsonl'), 300000).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* ignore */ }

    let guidance = []; try { guidance = trainingGuidance.listRules(); } catch { /* ignore */ }

    res.json({
      running, phase, progress, journalTail,
      report: _readText(path.join(help, 'meta_report.txt')),
      scoreboard: _readText(path.join(help, 'stable_scoreboard.txt')),
      history, guidance,
      resistant: _readJson(path.join(train, 'resistant_clusters.json'), {}),
      candidates: _readJson(path.join(train, 'candidate_tasks.json'), { candidates: [] }),
      tasks,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/train/run', (req, res) => {
  try {
    const k = Math.max(2, Math.min(8, parseInt((req.body && req.body.k) || 4, 10) || 4));
    const fresh = (req.body && req.body.fresh) ? '1' : '0';
    try { fs.writeFileSync(path.join(_helpDir(), 'ava_train_k.txt'), String(k)); } catch { /* ignore */ }
    try { fs.writeFileSync(path.join(_helpDir(), 'ava_train_fresh.txt'), fresh); } catch { /* ignore */ }
    _spawnBat('ui_train.bat');
    res.json({ ok: true, message: (fresh === '1' ? 'FRESH training started' : 'Training started') + ' (' + k + ' iterations). She goes offline ~1hr; this panel keeps updating.' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/train/unlock', (_req, res) => {
  try { fs.unlinkSync(path.join(_helpDir(), 'train_active.flag')); } catch { /* already gone */ }
  res.json({ ok: true, message: 'Unlocked — you can start a run now.' });
});
router.post('/train/eval', (_req, res) => { try { _spawnBat('ui_eval.bat'); res.json({ ok: true, message: 'Stable eval started (repeats=2). Panel will update.' }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.post('/train/harvest', (_req, res) => { try { _spawnBat('ui_harvest.bat'); res.json({ ok: true, message: 'Harvesting real-world failures into candidate tasks…' }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.post('/train/stop', (_req, res) => { try { _spawnBat('ui_stop.bat'); res.json({ ok: true, message: 'Stopping training and restoring her normal server…' }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

router.post('/train/promote', (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    const train = _trainDir();
    const cand = _readJson(path.join(train, 'candidate_tasks.json'), { candidates: [] });
    const item = (cand.candidates || []).find((c) => c.id === id);
    if (!item) return res.json({ ok: false, error: 'candidate not found' });
    const tasksPath = path.join(train, 'tasks.json');
    const lib = _readJson(tasksPath, { tasks: [] });
    const newId = 'real_' + Date.now().toString(36);
    lib.tasks.push({ id: newId, category: item.category || 'misc', difficulty: 2, prompt: item.prompt, checks: item.checks });
    fs.writeFileSync(tasksPath, JSON.stringify(lib, null, 2));
    cand.candidates = (cand.candidates || []).filter((c) => c.id !== id);
    fs.writeFileSync(path.join(train, 'candidate_tasks.json'), JSON.stringify(cand, null, 2));
    _markSeen(item.prompt);   // never re-suggest a promoted failure
    res.json({ ok: true, newId });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Dismiss a candidate: remove it and remember it so it never re-appears.
router.post('/train/dismiss', (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    const train = _trainDir();
    const cand = _readJson(path.join(train, 'candidate_tasks.json'), { candidates: [] });
    const item = (cand.candidates || []).find((c) => c.id === id);
    if (item) _markSeen(item.prompt);
    cand.candidates = (cand.candidates || []).filter((c) => c.id !== id);
    fs.writeFileSync(path.join(train, 'candidate_tasks.json'), JSON.stringify(cand, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
