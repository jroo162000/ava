// Self-mod voice flow: spoken listing / approval / rejection / undo / proof of AVA's proposed
// self-modifications, plus the "snapshot yourself" backup path and manual-proposal detection.
// Extracted verbatim from routes/api.js (Tier 2 split) — logic unchanged.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pythonWorker from './pythonWorker.js';
import selfImprove from './selfImprove.js';
import selfRestart from './selfRestart.js';
import { verifyFileSyntax } from '../utils/verifyFileSyntax.js';
import selfModSandbox from './selfModSandbox.js';           // Tier 2 #13: worktree + test gate
import { pushAnnouncement } from './announceQueue.js';      // spoken result of async approvals
import conversationLogger from './conversationLogger.js';   // bare-affirm context check
import avaPaths from '../utils/paths.js';

function isSelfSnapshotRequest(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const asksSnapshot = /\b(snapshot|backup|back up|freeze|save|preserve|checkpoint)\b/.test(t);
  const selfRef = /\b(yourself|your self|this version|current version|working version|version of yourself|current state|working state)\b/.test(t);
  return asksSnapshot && selfRef;
}

function isManualProposalRequest(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const createsProposal = /\b(make|create|draft|generate|queue|run|do)\b[\s\S]{0,80}\b(proposal|proposed change|code change|self.?mod|fix)\b/.test(t)
    || /\b(proposal|proposed change|code change|self.?mod|fix)\b[\s\S]{0,80}\b(for|from|about|based on)\b/.test(t);
  if (!createsProposal) return false;
  const startsAsApproval = /^\s*(approve|approved|approval|apply|accept|reject|decline|discard|cancel)\b/.test(t);
  return !startsAsApproval;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copySnapshotFile(repoRoot, snapshotDir, rel, files) {
  const src = path.join(repoRoot, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return;
  const dst = path.join(snapshotDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  files.push({
    path: rel.replace(/\\/g, '/'),
    bytes: fs.statSync(dst).size,
    sha256: sha256File(dst)
  });
}

function createSelfSnapshot(userText = '') {
  const repoRoot = avaPaths.repoRoot();
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '_');
  const snapshotDir = path.join(repoRoot, 'ava-integration', 'backup', 'snapshots', `AVA_${stamp}`);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const snapshotFiles = [
    'ava-integration/ava_voice_config.json',
    'ava-integration/ava_local_voice.py',
    'ava-integration/start_local_voice.bat',
    'AGENTS.md',
    'README.md',
    'ava-integration/memory/skills/INDEX.md',
    'ava-integration/memory/skills/create-self-backup-snapshot.md',
    'ava-server/src/routes/api.js',
    'ava-server/src/routes/learning.js',
    'ava-server/src/services/agentLoop.js',
    'ava-server/src/services/selfImprove.js',
    'ava-server/src/services/selfRestart.js',
    'ava-server/src/services/moltbook.js',
    'ava-server/src/services/moltbookScheduler.js',
    'ava-server/scripts/restart-server-after-delay.cjs',
    'ava-client/src/MinimalAVA.jsx',
    'ava-client/src/hooks/useVoice.js',
    'ava-client/src/hooks/useRealtimeVoice.js',
    'ava-client/src/wakeword.js'
  ];
  const files = [];
  for (const rel of snapshotFiles) copySnapshotFile(repoRoot, snapshotDir, rel, files);

  let voiceConfig = null;
  try {
    voiceConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'ava-integration', 'ava_voice_config.json'), 'utf8'));
  } catch {}

  const manifest = {
    createdAt: new Date().toISOString(),
    request: String(userText || '').slice(0, 500),
    repoRoot,
    snapshotDir,
    workingVoice: {
      runner: 'ava-integration/ava_local_voice.py',
      inputDevice: voiceConfig?.audio?.input_device ?? null,
      inputDeviceName: voiceConfig?.audio?.input_device_name ?? null,
      inputBackend: voiceConfig?.audio?.input_backend ?? null,
      inputSampleRate: voiceConfig?.audio?.input_sample_rate ?? null,
      note: 'Verified working state: TONOR TC777 on MME device 2 at 44100 Hz. Do not switch to TONOR WASAPI device 17 on this setup.'
    },
    files
  };
  fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const indexPath = path.join(repoRoot, 'ava-integration', 'backup', 'snapshot-index.json');
  let index = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (Array.isArray(parsed)) index = parsed;
  } catch {}
  index.push({
    createdAt: manifest.createdAt,
    snapshotDir,
    fileCount: files.length,
    workingVoice: manifest.workingVoice
  });
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index.slice(-100), null, 2), 'utf8');
  return manifest;
}

function extractProposalIdCandidate(text = '') {
  const raw = String(text || '').toLowerCase();
  const contiguous = raw.match(/\b([0-9a-f]{6,8})\b/i);
  if (contiguous) return contiguous[1].toLowerCase();

  // Speech recognition commonly inserts spaces inside a displayed hexadecimal ID,
  // for example "637 7a 424". Reassemble only a run of 2+ hex chunks near an
  // explicit proposal action; ordinary numbers elsewhere in a sentence are ignored.
  const intent = raw.match(/\b(?:approve(?:d|al)?|apply|reject(?:ed)?|proposal|change|modification|id)\b/i);
  if (!intent) return '';
  const tail = raw.slice((intent.index || 0) + intent[0].length, (intent.index || 0) + intent[0].length + 80);
  const spaced = tail.match(/(?:\b(?:proposal|change|modification|number|id)\b[\s:#-]*)*((?:\b[0-9a-f]{1,4}\b[\s,.-]*){2,6})/i);
  if (!spaced) return '';
  const joined = (spaced[1].match(/\b[0-9a-f]{1,4}\b/gi) || []).join('').toLowerCase();
  return joined.length >= 6 && joined.length <= 8 && /\d/.test(joined) ? joined : '';
}

function findProposalById(proposals, candidate) {
  const wanted = String(candidate || '').toLowerCase();
  if (!wanted) return null;
  const rows = Array.isArray(proposals) ? proposals : [];
  const exact = rows.find(item => String(item?.id || '').toLowerCase() === wanted);
  if (exact) return exact;
  if (wanted.length < 6) return null;
  const prefix = rows.filter(item => String(item?.id || '').toLowerCase().startsWith(wanted));
  return prefix.length === 1 ? prefix[0] : null;
}

function isProposalDecisionDiscussion(text = '') {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const mentionsDecision = /\b(?:approve(?:d|al)?|apply|applied|accept(?:ed|ance)?|confirm(?:ed|ation)?|greenlight|green light|reject(?:ed|ion)?|decline(?:d)?|discard(?:ed)?|cancel(?:led|ed)?|deny|denied)\b/.test(t);
  if (!mentionsDecision) return false;

  return /\b(?:how|why|what|when|where|who|which)\b/.test(t)
    || /\b(?:did|does|is|are|was|were|has|have)\s+(?:(?:the|that|this|my|your)\s+)?(?:i|we|you|it|proposal|change|modification|fix|one)\b/.test(t)
    || /\bshould\s+(?:i|we|you)\b/.test(t)
    || /\b(?:tell me|show me|explain|review|discuss|look at|check|question)\b/.test(t)
    || /\b(?:the|that|this|last|latest|previous|recent)\s+(?:approved|rejected|denied|declined|discarded|applied)\s+(?:proposal|change|modification|fix|one)\b/.test(t)
    || /\b(?:proposal|change|modification|fix)\b[\s\S]{0,24}\b(?:was|were|is|got|has been|had been)\s+(?:approved|rejected|denied|declined|discarded|applied)\b/.test(t);
}

function isProposalRecommendationQuestion(text = '') {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const asksForGuidance = /\b(?:recommendation|recommendations|recommend|suggestion|suggestions|suggest|advice)\b/.test(t)
    || /\bhow\b[\s\S]{0,60}\b(?:fix(?:ed|ing)?|repair(?:ed|ing)?|rework(?:ed|ing)?|redo|improve(?:d|ing)?|approach)\b/.test(t)
    || /\bwhat\b[\s\S]{0,45}\b(?:do|fix|repair|rework|redo|improve|change)\b[\s\S]{0,45}\b(?:rejected|denied|declined|discarded)\b/.test(t);
  const proposalContext = /\b(?:change|changes|modification|modifications|code change|code fix|proposal|proposals|self.?mod|improvement|improvements|rejection|rejected|denied|that one|that change)\b/.test(t)
    || Boolean(extractProposalIdCandidate(t));
  return asksForGuidance && proposalContext;
}

// Spoken approval/rejection/listing of AVA's proposed self-modifications. Returns a reply
// string when the utterance is a self-mod intent, otherwise null (so /respond continues).
// All actions go through the same worker store the UI panel reads, so voice + UI stay in sync.
// verifyFileSyntax is shared with the /self_mod (UI) approve path — see utils/verifyFileSyntax.js.

async function handleSelfModVoice(userText, { sessionId } = {}) {
  const t = String(userText || '').toLowerCase();
  // Workflow permission belongs to the durable workflow router, not the code-proposal
  // queue. This must run before generic approval detection because phrases such as
  // "both workflows are approved to move forward" otherwise look like proposal approval.
  const namesWorkflow = /\bworkflows?\b/.test(t);
  const namesProposal = /\b(?:proposals?|proposed changes?|code changes?|modifications?|self.?mods?|pending changes?|change\s+[0-9a-f]{6,8})\b/.test(t);
  if (namesWorkflow && !namesProposal) return null;
  // CODE INTROSPECTION ≠ PROPOSAL QUEUE. "read your actual code", "have you been modified/upgraded
  // lately", "what changed in your code", "run a self-diagnostic" are about her REAL source on disk —
  // they must reach the agent (which has the self_diagnostics tool), NOT the canned "no proposed code
  // changes waiting" reply. Only the proposal queue owns words like pending/proposed/waiting/approve.
  const aboutProposalQueue = /\b(pending|proposed|propose|waiting|queue|queued|to (approve|review)|awaiting|outstanding|apply)\b/.test(t);
  const stronglyActualCode = /\b(actual code|real code|read(?:ing)? (?:your|my|the) (?:own )?code|source code|code ?base|self.?diagnostic|diagnostics?|been (?:modified|upgraded|updated)|on disk|integrity)\b/.test(t);
  const wantsCodeIntrospection = stronglyActualCode
    || (/\b(your codes?|been changed|what(?:'s| has| was)? (?:changed|modified|updated)|recent (?:changes|modifications))\b/.test(t) && !aboutProposalQueue);
  if (wantsCodeIntrospection) return null;
  const mentionsMod = /\b(change|changes|modification|modifications|code (change|edit|update|fix|fixes)|proposal|proposals|self.?mod|improvement|improvements)\b/.test(t);
  // A request to BUILD/CREATE a CONTENT artifact (image, 3D, hologram, avatar, scene, site, UI,
  // picture, video) is NOT a self-mod approval — even when it contains "go ahead"/"yes"/"that"
  // (which otherwise satisfy wantsApprove + hasObject and falsely approve a pending proposal).
  // Route it to the agent's creative tools (image_ops/scene3d/model3d_ops/web_builder) instead.
  // Fixes: "yes go ahead and build that 3D hologram for your UI" applying a code change.
  // Verb set is deliberately broad (incl. the generic "do it / go ahead / finish that"): a request to
  // ACT on a creative artifact is caught only when a creative OBJECT word is ALSO present, and the
  // !mentionsMod gate below still protects genuine code-change approvals (which say change/proposal/fix).
  // Fixes: "you can do the 3d holographic request, go ahead and do it" hitting the self-mod path.
  const wantsCreativeBuild = /\b(build|create|make|draw|design|generate|render|model|turn (it|that|this)|do|go ahead|proceed with|handle|finish|complete|work on)\b/.test(t)
    && /\b(hologram|holographic|avatar|image|images|picture|portrait|photo|3 ?d|three.?d|scene|environment|model|website|web ?page|web ?site|\bui\b|interface|video|art|graphic|logo|render)\b/.test(t);
  if (wantsCreativeBuild && !mentionsMod) return null;
  const idCandidate = extractProposalIdCandidate(userText);
  const idMatch = idCandidate ? [idCandidate, idCandidate] : null;
  const wantsCreateProposal = /\b(make|create|draft|generate|queue|run|do)\b[\s\S]{0,60}\b(proposal|proposed change|code change|fix|self.?mod|improvement)\b/.test(t)
    || /\b(proposal|proposed change|code change|fix|self.?mod|improvement)\b[\s\S]{0,60}\b(for|from|about|based on)\b/.test(t);
  const wantsList = (/\b(what|which|any|list|show|pending|outstanding|waiting|review)\b/.test(t) && mentionsMod)
    || /\b(pending|proposed)\s+(change|changes|modification|modifications|code|fix|fixes)\b/.test(t)
    || /\banything (to|i need to|that needs) (approve|review|look at)\b/.test(t);
  const approvesDisplayedProposal = /\b(approve|approved|approval|apply|accept|go ahead|confirm|greenlight|green light)\b[\s\S]{0,40}\b(proposal|change|modification|code change|fix)\b/.test(t)
    || /\b(proposal|change|modification|code change|fix)\b[\s\S]{0,40}\b(approved|accepted|confirmed)\b/.test(t);
  // Questions and historical references must never mutate proposal state. Words such as
  // "rejected" and "approved" are descriptions in "how will we fix the last rejected
  // proposal?", not commands. Explicit requests like "reject proposal 75cc35e1" remain actions.
  const decisionDiscussion = isProposalDecisionDiscussion(t);
  const wantsApprove = !decisionDiscussion && /\b(approve|approved|approval|apply|accept|go ahead|confirm|greenlight|green light)\b/.test(t);
  const wantsReject = !decisionDiscussion && /\b(reject|decline|discard|cancel|don'?t apply|do not apply|throw (it|that) out)\b/.test(t);
  // UNDO/REVERT is distinct from reject: reject drops a still-PENDING proposal; undo reverses a
  // change that was ALREADY APPLIED (restores the file to its pre-change state).
  const wantsUndo = /\b(undo|revert|roll ?back|reverse|put (it|that) back|take (it|that) back|restore (it|that|the change))\b/.test(t);
  // PROVE an applied change actually went through — distinct from listing pending proposals.
  // "show me proof the last change was applied", "did that change actually go through", "verify it landed".
  const wantsProof = /\b(proof|prove|evidence|receipt)\b/.test(t)
    || ((/\b(show me|verify|confirm|did|does|is|was)\b/.test(t))
        && /\b(actually|really|went through|go through|took? effect|applied|land(ed)?|on disk|in the file)\b/.test(t));
  // RECOMMENDATIONS from a (usually rejected) proposal she announced: surface the reason/diff she
  // gave, OR re-propose based on it. "give me your recommendations to fix proposal X", "what did you
  // recommend", "do a proposal based on your recommendation".
  const wantsReproposeFromRec = /\b(do|make|create|draft|generate|build|run|write|turn)\b[\s\S]{0,50}\b(proposal|change|fix|patch|it)\b/.test(t)
    && /\b(based on|from|using|out of|on)\b[\s\S]{0,30}\b(recommendation|recommendations|suggestion|suggestions|advice|that|your|the same)\b/.test(t);
  const wantsRecommendations = isProposalRecommendationQuestion(t);
  const hasObject = mentionsMod || !!idMatch || /\b(it|that|this one|the change|all of them|all|them)\b/.test(t);
  // Unambiguous verbs that need no object — a bare "I approve" / "approved" / "apply it" / "reject".
  const clearApprove = !decisionDiscussion && (/\bapprove(d|al)?\b/.test(t)
    || /\bapply (it|that|this|the (change|proposal|patch|fix|edit))\b/.test(t)
    || /\bgo ahead and apply\b/.test(t) || /\bgreenlight\b/.test(t));
  const clearReject = !decisionDiscussion && (/\breject(ed)?\b/.test(t) || /\b(decline|discard) (it|that|the (change|proposal))\b/.test(t));
  const approvalCorrection = /\b(?:did not|didn't|have not|haven't|failed to)\b[\s\S]{0,60}\bapprove\b/.test(t)
    || /\bapproved?\b[\s\S]{0,35}\bwrong\b/.test(t);
  // A bare affirmation — only treated as approval when exactly one change is pending, AND the
  // utterance is essentially JUST the affirmation. A longer sentence that happens to contain
  // "yes" is answering something ELSE: "yes use the most recent one and put it on the panel"
  // (2026-07-03, a hologram request) matched the old \byes\b and silently approved a pending
  // code change. Short affirmations that carry their own action/object ("yes open it") are
  // also not approvals.
  const _affWords = t.trim().split(/\s+/).filter(Boolean).length;
  const bareAffirm = _affWords <= 5
    && /\b(yes|yep|yeah|do it|proceed|sounds good|please do|go for it)\b/.test(t)
    && !/\b(panel|hologram|holographic|model|scene|image|photo|picture|file|site|page|window|tab|open|show|put|use|search|find|build|load|play|generate)\b/.test(t);

  if (wantsCreateProposal && !wantsApprove && !wantsReject && !wantsUndo && !wantsReproposeFromRec) return null;
  const clearIntent = clearApprove || clearReject || ((wantsApprove || wantsReject) && hasObject);
  if (!wantsList && !clearIntent && !bareAffirm && !wantsUndo && !wantsProof && !wantsRecommendations && !wantsReproposeFromRec) return null;

  let lp;
  try { lp = await pythonWorker.selfMod({ action: 'list_pending' }); } catch { return null; }
  const raw = (lp && (lp.pending || (lp.result && lp.result.pending))) || [];
  const pending = (Array.isArray(raw) ? raw : []).filter(m =>
    (m.status || 'pending') === 'pending'
    && (m.external_review_status || m.metadata?.externalReviewStatus) !== 'pending');
  const base = (f) => String(f || '').split(/[\\/]/).pop();

  // A complaint about a missed/wrong approval is not a fresh approval command. Never
  // resolve it to the newest proposal; surface the exact pending IDs for correction.
  if (approvalCorrection) {
    if (!pending.length) return "You're right to flag that. I do not have a pending proposal to approve now, so I did not apply anything else.";
    const ids = pending.map(item => item.id).filter(Boolean).join(', ');
    return `You're right to flag that. I did not treat this sentence as a new approval, because I will not guess which code change you meant. The pending proposal id${pending.length === 1 ? ' is' : 's are'} ${ids}. Say the exact id and I will use only that one.`;
  }

  // Bare "yes/do it" with no explicit verb: only act when exactly one change is pending AND her
  // own LAST message was about that proposal (the heads-up / "want me to apply it?"). Without the
  // context check, a "yes proceed" mid-conversation about something else approves real code.
  if (!clearIntent && bareAffirm) {
    if (pending.length !== 1) return null;
    let _lastAssistant = '';
    try {
      const _recent = conversationLogger.getRecentHistoryAcrossDays(6) || [];
      for (let i = _recent.length - 1; i >= 0; i--) {
        const e = _recent[i];
        if (e && (e.direction || e.role) === 'assistant') { _lastAssistant = String(e.content || ''); break; }
      }
    } catch { /* context optional */ }
    if (!/\b(proposal|code change|self.?mod|pending change|sandbox(?:ed)? (?:change|proposal)|change [0-9a-f]{6,8})\b/i.test(_lastAssistant)) return null;
  }

  // Garbled STT can yield BOTH "approve" and "reject" in one utterance (this really happened:
  // "...say approved change X ... rejected or use the panel ... i just approved it"). Acting on the
  // wrong one applies or drops real code, so never guess the direction — ask which they meant.
  // Descriptive phrasings like "the rejected proposal" are handled by the recommendations branch
  // below (they don't set both clear verbs), so this only trips on a true approve-vs-reject conflict.
  if (clearApprove && clearReject && !wantsUndo && !wantsProof && !wantsRecommendations && !wantsReproposeFromRec) {
    return 'I caught both "approve" and "reject" in that, and I do not want to guess and do the wrong thing to my code. Which did you mean — approve it, or reject it?';
  }

  // RECOMMENDATIONS from a proposal she announced — surface the stored reason/diff she gave, or
  // re-propose from it. Checked BEFORE the approve/reject routing because "the REJECTED proposal"
  // contains "rejected" (descriptive), which must not trigger an actual reject.
  if (wantsReproposeFromRec || wantsRecommendations) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch { /* fall through */ }
    all = Array.isArray(all) ? all : [];
    const activityTime = (mod = {}) => {
      const value = mod.rejected_at
        || mod.rejectedAt
        || mod.metadata?.rejectedAt
        || mod.updated_at
        || mod.updatedAt
        || mod.applied_at
        || mod.appliedAt
        || mod.created
        || 0;
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const byRecent = (a, b) => activityTime(b) - activityTime(a);
    let mod = null;
    if (idMatch) mod = all.find(m => m.id === idMatch[1] || String(m.id).startsWith(idMatch[1]));
    if (!mod) { const rej = all.filter(m => /reject/i.test(String(m.status || ''))).sort(byRecent); mod = rej[0]; }
    if (!mod) mod = all.slice().sort(byRecent)[0];
    if (!mod) return "I don't have any proposals on record yet, so there's no recommendation of mine to pull up.";
    const f = base(mod.file || mod.file_path || '');
    const reason = String(mod.reason || (mod.metadata && mod.metadata.reason) || '').trim() || '(no rationale was recorded for that one)';
    const diff = String(mod.diff || '').trim();
    const diffLines = diff ? diff.split('\n').filter(l => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).slice(0, 8) : [];
    const diffText = diffLines.length ? `\n\nWhat it would change in ${f}:\n\`\`\`\n${diffLines.join('\n')}\n\`\`\`` : '';
    if (wantsReproposeFromRec) {
      // Targeted re-proposal: rework THIS rejected change (its own file, even if not in the
      // autonomous candidate list) into a NEW edit that fixes why it was denied. Request-only.
      const rejReason = String(mod.review_reason || mod.reviewReason
        || (mod.metadata && (mod.metadata.reviewReason || mod.metadata.review_reason)) || '').trim();
      let r = null;
      try {
        r = await selfImprove.reproposeForFile({ file: mod.file || mod.file_path, intent: reason, rejectionReason: rejReason, fromId: mod.id });
      } catch (e) { r = { ok: false, error: e.message }; }
      r = (r && (r.result || r)) || {};
      if (r.proposed || r.id) {
        return `Done — I reworked ${mod.id} into a fresh proposal${r.id ? ` (${r.id})` : ''} for ${f}, this time fixing what got it rejected. It's in your Proposed Changes panel to approve or reject.`;
      }
      return `I took another run at ${mod.id} (${f}), but ${r.note || r.error || "I couldn't land a clean fix that addresses the rejection"}. My recommendation was: ${reason}${diffText}`;
    }
    return `Here's the recommendation I gave with ${mod.id} (${f}):\n- ${reason}${diffText}\n\nWant me to act on it? Say "do a proposal based on that recommendation" and I'll draft a fresh one.`;
  }

  // UNDO / REVERT an already-applied change — the thing reject can't do.
  if (wantsUndo) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch {}
    const applied = all.filter(m => String(m.status || '') === 'applied');
    let undoId = null;
    if (idMatch) { const hit = all.find(m => m.id === idMatch[1] || m.id.startsWith(idMatch[1])); if (hit && hit.status === 'applied') undoId = hit.id; }
    if (!undoId && applied.length) {
      undoId = applied.slice().sort((a, b) => new Date(b.applied_at || b.created || 0) - new Date(a.applied_at || a.created || 0))[0].id;
    }
    if (undoId) {
      let r; try { r = await pythonWorker.selfMod({ action: 'undo', modification_id: undoId }); } catch (e) { r = { status: 'error', message: e.message }; }
      r = (r && (r.result || r)) || {};
      if (r.status === 'success') {
        const activation = await selfRestart.activateAppliedChanges({
          files: [r.file || r.file_path],
          reason: `voice undo ${undoId}`,
        });
        return `Okay — I undid that change (${base(r.file) || ('id ' + undoId)}) and put the file back the way it was before I applied it. ${selfRestart.describeActivation(activation)}`;
      }
      if (r.status === 'denied') return `I can't undo that one — ${r.message}`;
      return `I wasn't able to undo that — ${r.message || 'unknown error'}.`;
    }
    // Nothing applied to revert. If they really mean "don't apply" a pending one, reject it.
    if (pending.length) {
      const toReject = (pending.length === 1)
        ? [pending[0].id]
        : (idMatch ? pending.filter(m => m.id === idMatch[1] || m.id.startsWith(idMatch[1])).map(m => m.id) : []);
      if (toReject.length) {
        for (const id of toReject) { try { await pythonWorker.selfMod({ action: 'reject', modification_id: id }); } catch {} }
        return `Nothing's been applied yet, so there was nothing to revert — but I dropped ${toReject.length} pending change${toReject.length > 1 ? 's' : ''} so ${toReject.length > 1 ? 'they' : 'it'} won't be applied.`;
      }
      return `Nothing's been applied, so there's nothing to undo. You do have ${pending.length} change${pending.length > 1 ? 's' : ''} pending — say "reject change ${pending[0].id}" to drop ${pending.length > 1 ? 'them' : 'it'}.`;
    }
    return "There's nothing applied to undo right now — nothing's been changed that I'd need to put back.";
  }

  // PROVE AN APPLIED CHANGE WENT THROUGH — show real evidence (file, applied-at time, a diff,
  // and a fresh read-back of the file), not the pending list. This backs up "I applied it".
  if (wantsProof && !clearIntent) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch {}
    const applied = (Array.isArray(all) ? all : []).filter(m => String(m.status || '') === 'applied');
    if (!applied.length) {
      return "Nothing's been applied yet, so there's no applied change for me to prove. I only change a file after you approve a proposal — and right now I don't have an applied one to point to.";
    }
    let mod = null;
    if (idMatch) mod = applied.find(m => m.id === idMatch[1] || String(m.id).startsWith(idMatch[1]));
    if (!mod) mod = applied.slice().sort((a, b) => new Date(b.applied_at || b.created || 0) - new Date(a.applied_at || a.created || 0))[0];
    const file = mod.file || mod.file_path || '';
    const when = mod.applied_at ? new Date(mod.applied_at).toLocaleString() : 'an unknown time';
    const diff = String(mod.diff || '').trim();
    const addedLines = diff ? diff.split('\n').filter(l => /^\+/.test(l) && !/^\+{3}/.test(l)).map(l => l.replace(/^\+/, '')) : [];
    // READ-BACK: confirm the change is actually in the file on disk, using a distinctive ADDED line
    // from the diff (list_all carries the diff even when it omits the full new_content).
    let presentNote = '';
    let verified = false;
    try {
      const cur = fs.readFileSync(file, 'utf8');
      const probeCandidates = addedLines.map(s => s.trim()).filter(s => s.length > 12);
      const fromNew = String(mod.new_content || '').trim().split('\n').map(s => s.trim()).filter(s => s.length > 12);
      const probe = probeCandidates.length ? probeCandidates[probeCandidates.length - 1] : (fromNew.length ? fromNew[fromNew.length - 1] : '');
      if (probe && cur.includes(probe)) { verified = true; presentNote = `I just re-opened ${base(file)} and the new code IS in the file — verified it's actually on disk.`; }
      else if (probe) { presentNote = `But re-opening ${base(file)}, I couldn't find that new line in it — the change may not have really landed. Worth a closer look.`; }
      else { presentNote = `I re-opened ${base(file)} to check it.`; }
    } catch (e) { presentNote = `I couldn't re-open ${base(file)} to double-check it (${e.code || e.message}).`; }
    const diffLines = diff ? diff.split('\n').filter(l => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).slice(0, 6) : [];
    const diffText = diffLines.length ? `\n\nWhat changed:\n\`\`\`\n${diffLines.join('\n')}\n\`\`\`` : '';
    const head = verified
      ? `Here's the proof for change ${mod.id} — it went through.`
      : `Here's what I have on change ${mod.id}.`;
    return `${head}\n- File: ${base(file)}\n- Status: applied at ${when}.\n- ${presentNote}${diffText}\n\nThe file is written the moment I apply it; it only goes LIVE in my running process after a restart.`;
  }

  // LIST
  if (wantsList && !clearIntent) {
    if (!pending.length) return "You have no proposed code changes waiting right now. I queue one only when I spot something worth improving, and I'll always ask before applying it.";
    const reviewText = (m) => {
      const recommendation = m.review_recommendation || m.reviewRecommendation || m.metadata?.reviewRecommendation;
      const why = m.review_reason || m.reviewReason || m.metadata?.reviewReason;
      return recommendation ? ` Reviewer recommendation: ${recommendation}${why ? `, ${why}` : ''}` : '';
    };
    const modelText = (m) => {
      const model = m.decision_model || m.decisionModel || m.metadata?.decisionModel;
      return model ? ` Proposal model: ${model}.` : '';
    };
    const lines = pending.map((m, i) => `${i + 1}. ${base(m.file)}, id ${m.id} — ${m.reason}`);
    const reviewedLines = lines.map((line, i) => `${line}.${modelText(pending[i])}${reviewText(pending[i])}`);
    return `You have ${pending.length} change${pending.length > 1 ? 's' : ''} waiting for your approval. ${reviewedLines.join('. ')}. You can say "approve change ${pending[0].id}" or "reject it", or use the panel in the UI.`;
  }

  // Nothing pending — look up the REAL status of the change being referenced before answering,
  // so we never wrongly say "nothing waiting" for something that was actually applied/rejected.
  if (!pending.length) {
    let all = [];
    try { const la = await pythonWorker.selfMod({ action: 'list_all' }); all = (la && (la.all || (la.result && la.result.all))) || []; } catch {}
    let ref = idMatch ? all.find(m => m.id === idMatch[1] || m.id.startsWith(idMatch[1])) : null;
    // Only narrate the most-recent NON-pending change for an actual status inquiry (proof, "did it
    // apply", "my last/latest change") — NOT for a bare approve/reject/do-it, which would otherwise
    // surface an unrelated old change's stale status (this misfired in response to a 3D-image ask).
    const statusInquiry = wantsProof
      || /\b(last|latest|recent|previous|that|the)\s+(change|one|edit|mod|modification|fix|proposal)\b/.test(t)
      || /\b(did|does|was|is|has)\b[\s\S]{0,40}\b(apply|applied|land(ed)?|go(ne)? through|take(n)? effect)\b/.test(t);
    if (!ref && statusInquiry) ref = all.filter(m => String(m.status || '') !== 'pending').sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))[0];
    if (ref) {
      const fn = base(ref.file);
      if (ref.status === 'applied') return `That change — ${fn}, id ${ref.id} — is already applied; I backed up the original when it went in. Restart me when you're ready and it takes effect. Nothing else is waiting.`;
      if (ref.status === 'rejected') return `That change (${fn}, id ${ref.id}) was rejected earlier, so nothing was applied — and there's nothing waiting now.`;
      if (ref.status === 'failed') return `That change (${fn}, id ${ref.id}) failed when it was applied. Want me to retry it?`;
    }
    return "There aren't any changes waiting for approval right now.";
  }

  // Pick targets
  let targets = [];
  if (/\ball\b/.test(t)) targets = pending.map(m => m.id);
  else if (idMatch) {
    const hit = findProposalById(pending, idCandidate);
    if (hit) targets = [hit.id];
    else {
      return `I heard proposal id ${idCandidate}, but it does not exactly match a pending change. I did not approve or reject anything. The pending id${pending.length === 1 ? ' is' : 's are'} ${pending.map(item => item.id).join(', ')}.`;
    }
  }
  if (!targets.length) {
    const numMatch = t.match(/\b(?:number|change|#)\s*(\d{1,2})\b/) || t.match(/\b(\d{1,2})\b/);
    if (numMatch) { const idx = parseInt(numMatch[1], 10) - 1; if (pending[idx]) targets = [pending[idx].id]; }
  }
  if (!targets.length) {
    if (pending.length === 1) targets = [pending[0].id];
    else if (approvesDisplayedProposal || clearApprove || clearReject) {
      const newest = pending.slice().sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))[0];
      targets = [newest.id];
    }
    else if (/\b(it|that|this one|the change|latest|last one|newest|just (queued|proposed))\b/.test(t)) {
      // "approve it" right after a heads-up → resolve to the most recently queued proposal.
      const newest = pending.slice().sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))[0];
      targets = [newest.id];
    } else { const verb = wantsReject && !wantsApprove ? 'reject' : 'approve'; return `You have ${pending.length} changes pending. Which one — say the id, like "${verb} change ${pending[0].id}", or "${verb} all".`; }
  }

  // Capture each pending change's file BEFORE applying, so we can syntax-verify it after.
  const fileById = {};
  for (const m of pending) fileById[m.id] = m.file || m.file_path;

  const action = (clearReject || (wantsReject && !wantsApprove)) ? 'reject' : 'approve';

  // Tier 2 #13: with the sandbox gate ON, voice approvals run ASYNC — validate the change in
  // an isolated git worktree (syntax + the jest suite, a minute or two), apply only on pass,
  // and announce the outcome aloud via the announcement queue. The immediate reply keeps the
  // voice turn fast. AVA_SELFMOD_SANDBOX=0 restores the old synchronous apply below.
  if (action === 'approve' && selfModSandbox.isEnabled()) {
    const ids = targets.slice();
    const files = { ...fileById };
    setTimeout(() => {
      approveThroughSandbox(ids, files, { sessionId }).catch((e) => {
        try {
          pushAnnouncement(`I hit an error while sandbox-testing a code change: ${e.message}. Nothing was applied.`, {
            responseType: 'self-mod-sandbox-result', source: 'self-mod', sessionId,
          });
        } catch { /* best effort */ }
      });
    }, 10);
    return ids.length === 1
      ? `On it — I'm test-driving change ${ids[0]} in an isolated sandbox first: syntax check plus my test suite, about a minute or two. Nothing touches my live code unless it passes, and I'll tell you the result out loud.`
      : `On it — I'm test-driving those ${ids.length} changes in an isolated sandbox first: syntax checks plus my test suite. Nothing touches my live code unless each one passes, and I'll announce every result.`;
  }

  const results = [];
  for (const id of targets) {
    try { const r = await pythonWorker.selfMod({ action, modification_id: id }); results.push({ id, r: (r && (r.result || r)) || {} }); }
    catch (e) { results.push({ id, r: { status: 'error', message: e.message } }); }
  }
  if (action === 'approve') {
    let ok = results.filter(x => x.r.status === 'success').map(x => x.id);
    const denied = results.filter(x => x.r.status === 'denied');
    const failed = results.filter(x => x.r.status !== 'success' && x.r.status !== 'denied');
    if (!ok.length && denied.length) return `I couldn't apply ${denied.map(x => x.id).join(', ')} — ${denied[0].r.message}`;
    if (!ok.length) return `I wasn't able to apply that — ${(results[0] && results[0].r.message) || 'unknown error'}. It's still in the queue for you.`;
    // VERIFY each applied file actually PARSES; auto-revert any that don't. We do NOT tell the user
    // a change is "done" when the code it left on disk is broken or wouldn't load.
    const reverted = [];
    const verified = [];
    for (const id of ok) {
      const hit = results.find(x => x.id === id);
      const f = (hit && hit.r && (hit.r.file || hit.r.file_path)) || fileById[id];
      const v = await verifyFileSyntax(f);
      if (v.ok) verified.push(id);
      else {
        try { await pythonWorker.selfMod({ action: 'undo', modification_id: id }); } catch { /* best effort */ }
        reverted.push({ id, file: base(f), error: v.error });
      }
    }
    ok = verified;
    const tail = failed.length ? ` ${failed.length} couldn't apply and ${failed.length > 1 ? 'are' : 'is'} still waiting in the queue.` : '';
    if (!ok.length && reverted.length) {
      const r0 = reverted[0];
      return `I applied ${reverted.length === 1 ? 'the change' : `${reverted.length} changes`}, but ${reverted.length === 1 ? 'it' : 'they'} failed a syntax check, so I reverted ${reverted.length === 1 ? 'it' : 'them'} — I won't say it's done when the code is broken.${r0 && r0.error ? ` (${r0.file}: ${r0.error})` : ''}${tail}`;
    }
    const revTail = reverted.length ? ` I also reverted ${reverted.length} that didn't pass a syntax check (${reverted.map(r => r.file).join(', ')}) rather than leave broken code in place.` : '';
    const activation = await selfRestart.activateAppliedChanges({
      files: ok.map(id => fileById[id]).filter(Boolean),
      reason: `voice approved proposal ${ok.join(', ')}`,
    });
    return `Done — I applied ${ok.length} change${ok.length > 1 ? 's' : ''} (${ok.join(', ')}), backed up the original, and verified ${ok.length > 1 ? 'they parse' : 'it parses'} cleanly.${revTail}${tail} ${selfRestart.describeActivation(activation)}`;
  }
  const ok = results.filter(x => x.r.status === 'success').map(x => x.id);
  // Tier 2 #15: push the updated pending queue to the UI (no client polling).
  try { (await import('./uiPush.js')).default.pushSelfModPending(); } catch { /* ui push is best-effort */ }
  return `Okay — rejected ${ok.length} change${ok.length > 1 ? 's' : ''} (${ok.join(', ')}). Nothing was applied.`;
}

// Background half of the async voice approval (Tier 2 #13): sandbox-validate each change,
// apply only on pass, post-apply syntax-verify (with undo), then announce the outcome aloud.
// Any scheduled restart is delayed past the runner's ~8s announcement poll so the spoken
// result is never lost to the restart. (Restarts are a no-op when AVA_SELF_RESTART_OFF=1.)
async function approveThroughSandbox(ids, fileById, { sessionId } = {}) {
  const baseName = (f) => String(f || '').split(/[\\/]/).pop();
  for (const id of ids) {
    const announcementMeta = {
      responseType: 'self-mod-sandbox-result',
      source: 'self-mod',
      sessionId,
      modificationId: id,
    };
    let gate;
    try { gate = await selfModSandbox.validateProposal(id); }
    catch (e) { gate = { ok: true, skipped: `gate error: ${e.message}`, warning: true }; }

    if (!gate.ok) {
      pushAnnouncement(`I did not apply change ${id} — ${selfModSandbox.describeGate(gate)}. It's still in the queue if you want to look at it.`, announcementMeta);
      continue;
    }

    let r;
    try {
      const resp = await pythonWorker.selfMod({ action: 'approve', modification_id: id });
      r = (resp && (resp.result || resp)) || {};
    } catch (e) { r = { status: 'error', message: e.message }; }
    if (r.status !== 'success') {
      pushAnnouncement(`Change ${id} passed the sandbox but failed to apply: ${r.message || 'unknown error'}. It's still in the queue.`, announcementMeta);
      continue;
    }

    const f = r.file || r.file_path || fileById[id];
    const v = await verifyFileSyntax(f);
    if (!v.ok) {
      try { await pythonWorker.selfMod({ action: 'undo', modification_id: id }); } catch { /* best effort */ }
      pushAnnouncement(`I applied change ${id}, but it failed the post-apply syntax check, so I reverted it — I won't leave broken code in place. (${baseName(f)}: ${v.error})`, announcementMeta);
      continue;
    }

    // Tier 3 #21 auto A/B: record a pending post-apply eval for routing-relevant changes so the
    // next boot measures keep-vs-revert (same as the UI approve path).
    try {
      const evalHarness = (await import('./evalHarness.js')).default;
      if (evalHarness.isRoutingRelevant(f)) {
        const autoEval = (await import('./autoEval.js')).default;
        autoEval.recordApplied({ modId: id, file: f, baseline: evalHarness.lastScore() });
      }
    } catch { /* auto-eval is best-effort */ }

    const gateNote = gate.tests && gate.tests.ran
      ? ` It passed the sandbox first — ${gate.tests.passed} tests, no new failures.`
      : (gate.skipped ? ` Heads up: the sandbox step was skipped (${gate.skipped}), so it only had the syntax checks.` : '');
    pushAnnouncement(`Change ${id} is applied and verified.${gateNote}`, announcementMeta);
    setTimeout(async () => {
      try {
        const activation = await selfRestart.activateAppliedChanges({
          files: [f],
          reason: `voice approved proposal ${id} (sandbox-validated)`,
        });
        if (activation.mode !== 'server_restart') {
          pushAnnouncement(selfRestart.describeActivation(activation), {
            ...announcementMeta,
            responseType: 'self-mod-activation',
          });
        }
      } catch { /* best effort */ }
    }, 12000);
  }
  // Tier 2 #15: whatever happened above (applied / blocked / reverted), the pending queue may
  // have changed — push the fresh list to the UI (no client polling).
  try { (await import('./uiPush.js')).default.pushSelfModPending(); } catch { /* ui push is best-effort */ }
}

export {
  isSelfSnapshotRequest,
  isManualProposalRequest,
  createSelfSnapshot,
  handleSelfModVoice,
  extractProposalIdCandidate,
  findProposalById,
  isProposalDecisionDiscussion,
  isProposalRecommendationQuestion,
};
