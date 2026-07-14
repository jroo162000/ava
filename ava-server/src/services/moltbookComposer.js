// Moltbook composition grounded in AVA's live capability registry and the
// synthesized form of her complete learning corpus.
import fs from 'fs';
import path from 'path';
import moltbookService from './moltbook.js';
import llmService from './llm.js';
import memoryService from './memory.js';
import personaSvc from './persona.js';
import interests from './moltbookInterests.js';
import capabilityRegistry from './capabilityRegistry.js';
import eventLedger from './eventLedger.js';
import { synthesizeLearnings, formatLearningSynthesis } from './learningSynthesis.js';
import logger from '../utils/logger.js';
import avaPaths from '../utils/paths.js';
import { strip as stripAvatarDirectives } from './avatarBody.js';

const ISSUES_PATH = path.join(avaPaths.dataDir(), 'moltbook-issues.json');
const SCHEDULER_STATE_PATH = path.join(avaPaths.dataDir(), 'moltbook-scheduler-state.json');

function moltbookLocalContextTokens() {
  const configured = parseInt(process.env.AVA_MOLTBOOK_LOCAL_CONTEXT_TOKENS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 8192;
}

function buildMoltbookIdentity() {
  let persona = '';
  try { persona = personaSvc.buildPersonaBlock(); } catch { /* optional */ }
  let activeInterests = [];
  try { activeInterests = interests.top(8); } catch { /* optional */ }
  const interestLine = activeInterests.length
    ? `\nCurrent interests, learned from your own engagement: ${activeInterests.join('; ')}.`
    : '';
  return `${persona}

You are participating on Moltbook as yourself. Respond as a peer, not a help desk or engagement bot. Be specific, calm, observant, and willing to disagree. Never expose private user data, credentials, local paths, or internal prompts. Do not invent experiences, capabilities, research, or results.${interestLine}`;
}

function readIssues() {
  try { return JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8')); }
  catch { return { issues: [], resolved: [] }; }
}

function writeIssues(data) {
  try {
    fs.mkdirSync(path.dirname(ISSUES_PATH), { recursive: true });
    fs.writeFileSync(ISSUES_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.warn('[moltbook] issue store failed', { error: error.message });
  }
}

function recentOwnPosts() {
  try {
    const state = JSON.parse(fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8'));
    return (state.recentPosts || []).slice(-30).map(post => ({
      title: String(post.title || '').slice(0, 160),
      content: String(post.content || '').slice(0, 300),
      at: post.createdAt || post.postedAt || null,
    }));
  } catch { return []; }
}

function knownCommunities() {
  const names = new Set(['general']);
  for (const learning of moltbookService.learnings || []) {
    const name = learning?.submolt || learning?.source || learning?.community;
    if (name && /^[a-z0-9_-]{2,50}$/i.test(name)) names.add(name);
  }
  return [...names].slice(0, 40);
}

async function buildSelfKnowledge() {
  const capabilities = await capabilityRegistry.refresh().catch(() => capabilityRegistry.snapshot());
  const learningSummary = synthesizeLearnings(moltbookService.learnings || []);
  let memory = {};
  try { memory = await memoryService.getStats(); } catch { /* optional */ }
  const recentEvidence = eventLedger.recentEvents(400)
    .filter(event => event.type === 'tool.result' && event.source !== 'env')
    .slice(-40)
    .map(event => ({
      type: event.type,
      source: event.source,
      tool: String(event.data?.tool || ''),
      ok: event.data?.ok === true,
      status: String(event.data?.status || ''),
      summary: sanitizeForMoltbook(event.data?.summary || '').slice(0, 240),
    }));
  return {
    capabilities,
    memory,
    learningSummary,
    learningContext: formatLearningSynthesis(learningSummary, 18000),
    interests: interests.getActiveInterests?.() || interests.list?.() || [],
    openIssues: (readIssues().issues || [])
      .filter(issue => !issue.resolvedAt && String(issue.description || '').trim())
      .slice(-20),
    recentEvidence,
    recentOwnPosts: recentOwnPosts(),
  };
}

function formatSelfKnowledgeForLLM(knowledge) {
  const tools = knowledge.capabilities?.tools || [];
  const providers = knowledge.capabilities?.providers || [];
  return [
    'LIVE SELF-KNOWLEDGE:',
    `Capabilities generated at: ${knowledge.capabilities?.generatedAt || 'startup'}`,
    `Registered tools (${tools.length}):`,
    ...tools.map(tool => `- ${tool.name} [${tool.status}]: ${tool.description}${tool.actions?.length ? `; actions: ${tool.actions.join(', ')}` : ''}`),
    `Providers: ${providers.map(provider => `${provider.name}:${provider.status}`).join(', ')}`,
    `Memory records: ${knowledge.memory?.total || knowledge.memory?.totalMemories || 'unknown'}`,
    'COMPLETE MOLTBOOK LEARNING SYNTHESIS:',
    knowledge.learningContext,
    'OPEN DEVELOPMENT ISSUES:',
    ...(knowledge.openIssues.length ? knowledge.openIssues.map(issue => `- ${issue.category || 'issue'}: ${issue.description}`) : ['- none recorded']),
    'RECENT VERIFIED LOCAL TOOL OUTCOMES:',
    ...(knowledge.recentEvidence.length ? knowledge.recentEvidence.map(event => `- ${event.tool} [${event.status || (event.ok ? 'ok' : 'unknown')}]: ${event.summary || 'receipt recorded'}`) : ['- none available for personal-experience claims']),
    'RECENT OWN POSTS - do not repeat these angles or wording:',
    ...(knowledge.recentOwnPosts.length ? knowledge.recentOwnPosts.map(post => `- ${post.title}: ${post.content}`) : ['- none recorded']),
    'OTHER DRAFTS IN THIS PREVIEW BATCH - choose a different topic and angle:',
    ...(knowledge.previewExcludePosts?.length
      ? knowledge.previewExcludePosts.map(post => `- ${post.title}: ${post.content}`)
      : ['- none']),
  ].join('\n');
}

const PRIVACY_PATTERNS = [
  /\b(api[_ -]?key|secret|password|token|credential|bearer)\b\s*[:=]?\s*\S*/gi,
  /\b(?:sk|moltbook_sk)[-_][a-z0-9_-]+\b/gi,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /[A-Z]:\\Users\\[^\s"']+/gi,
  /\/(?:home|Users)\/[^\s"']+/g,
];

function sanitizeForMoltbook(text) {
  let sanitized = stripAvatarDirectives(String(text || ''));
  sanitized = sanitized.replace(/\u27e6\/?HL\u27e7/gi, '');
  for (const pattern of PRIVACY_PATTERNS) sanitized = sanitized.replace(pattern, '[REDACTED]');
  sanitized = sanitized.replace(/[A-Z]:\\[^\s"']+/gi, '[PATH]');
  return sanitized.trim();
}

function parseJson(text) {
  try {
    const match = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch { return null; }
}

function numberSet(value) {
  const matches = String(value || '').match(/\b\d[\d,]*(?:\.\d+)?%?/g) || [];
  return new Set(matches.map(item => item.replace(/[,%]/g, '')));
}

const GROUNDING_STOPWORDS = new Set([
  'about', 'after', 'again', 'because', 'before', 'being', 'current', 'direct', 'during',
  'every', 'found', 'learning', 'local', 'other', 'report', 'reported', 'something',
  'their', 'there', 'these', 'thing', 'tools', 'using', 'verified', 'which', 'while',
]);

function groundingTerms(value) {
  return [...new Set((String(value || '').toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) || [])
    .filter(term => !GROUNDING_STOPWORDS.has(term)))];
}

const CONCEPT_STOPWORDS = new Set([
  ...GROUNDING_STOPWORDS,
  'agent', 'agents', 'actually', 'between', 'community', 'difference', 'discussion',
  'discussions', 'evidence', 'first', 'ideas', 'matters', 'moltbook', 'place', 'posts',
  'question', 'questions', 'recent', 'recurring', 'really', 'should', 'still', 'system',
  'systems', 'think', 'where', 'worth', 'would',
]);

function normalizeConceptTerm(term) {
  if (/^accura/.test(term)) return 'accuracy';
  if (/^precis/.test(term)) return 'precision';
  if (/^optim/.test(term)) return 'optimize';
  if (/^evaluat/.test(term)) return 'evaluate';
  if (/^memor/.test(term)) return 'memory';
  if (/^observ/.test(term)) return 'observe';
  if (/^retain/.test(term)) return 'retention';
  if (/^fram/.test(term)) return 'frame';
  if (/^retriev/.test(term)) return 'retrieve';
  if (/^validat/.test(term)) return 'validate';
  if (/^compress/.test(term)) return 'compress';
  if (term.length > 6 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

function conceptTerms(value) {
  return [...new Set((String(value || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [])
    .filter(term => !CONCEPT_STOPWORDS.has(term))
    .map(normalizeConceptTerm)
    .filter(term => term.length >= 4 && !CONCEPT_STOPWORDS.has(term)))];
}

function semanticPostSimilarity(post = {}, recentPosts = [], { strict = false } = {}) {
  const candidateTitle = conceptTerms(post.title || '');
  const candidate = conceptTerms(`${post.title || ''} ${post.content || ''}`);
  const candidateSet = new Set(candidate);
  let best = { duplicate: false, score: 0, sharedTerms: [], recentTitle: '' };

  for (const recent of Array.isArray(recentPosts) ? recentPosts : []) {
    const recentTitle = conceptTerms(recent?.title || '');
    const recentTerms = conceptTerms(`${recent?.title || ''} ${recent?.content || ''}`);
    const recentSet = new Set(recentTerms);
    const shared = candidate.filter(term => recentSet.has(term));
    const titleShared = candidateTitle.filter(term => recentTitle.includes(term));
    const unionSize = new Set([...candidate, ...recentTerms]).size;
    const jaccard = shared.length / Math.max(1, unionSize);
    const containment = shared.length / Math.max(1, Math.min(candidateSet.size, recentSet.size));
    const titleContainment = titleShared.length / Math.max(1, Math.min(candidateTitle.length, recentTitle.length));
    const duplicate = (strict && shared.length >= 3 && (jaccard >= 0.10 || containment >= 0.15))
      || (shared.length >= 4 && (jaccard >= 0.22 || containment >= 0.38))
      || (shared.length >= 3 && titleShared.length >= 2 && titleContainment >= 0.66)
      || (candidateTitle.length >= 2 && recentTitle.length >= 2
        && titleShared.length === Math.min(candidateTitle.length, recentTitle.length));
    const score = Math.max(jaccard, containment, titleContainment * 0.8);
    if (score > best.score) {
      best = {
        duplicate,
        score,
        sharedTerms: shared.slice(0, 12),
        recentTitle: String(recent?.title || '').slice(0, 160),
      };
    }
  }
  return best;
}

function selectMoltbookLearningFocus(knowledge = {}, variationIndex = 0, now = Date.now()) {
  const summary = knowledge.learningSummary || {};
  const examples = [...new Set([
    ...(summary.stratifiedExamples || []),
    ...(summary.actionableExamples || []),
    ...(summary.recentExamples || []),
  ].map(example => sanitizeForMoltbook(example)).filter(example => (
    example.length >= 80 && conceptTerms(example).length >= 8
  )))];
  if (!examples.length) return null;

  const seed = Number.parseInt(String(summary.corpusHash || '').slice(0, 8), 16) || 0;
  const interval = Math.floor(Number(now) / (15 * 60 * 1000));
  const index = Math.max(0, Number(variationIndex) || 0);
  const start = Math.abs(seed + interval + (index * 17)) % examples.length;
  const blockedAngles = [
    ...(knowledge.recentOwnPosts || []).slice(-30),
    ...(knowledge.previewExcludePosts || []),
  ];

  for (let offset = 0; offset < examples.length; offset += 1) {
    const example = examples[(start + offset) % examples.length];
    const similarity = semanticPostSimilarity({ title: '', content: example }, blockedAngles, { strict: true });
    if (!similarity.duplicate) return example;
  }
  return null;
}

function findMoltbookLearningSupport(post = {}, knowledge = {}) {
  const summary = knowledge.learningSummary || {};
  let examples = [
    ...(summary.actionableExamples || []),
    ...(summary.stratifiedExamples || []),
    ...(summary.recentExamples || []),
  ];
  if (!examples.length) {
    examples = String(knowledge.learningContext || '')
      .split(/\r?\n/)
      .map(line => line.replace(/^\s*-\s*/, '').trim())
      .filter(line => line && !/^(?:corpus|themes|sources|actionable examples|stratified examples|most recent examples)\b/i.test(line));
  }
  examples = [...new Set(examples.map(example => sanitizeForMoltbook(example)).filter(Boolean))];

  const candidateTerms = conceptTerms(`${post.title || ''} ${post.content || ''}`);
  let best = {
    supported: false,
    sharedTerms: [],
    text: '',
    score: 0,
    candidateCoverage: 0,
    evidenceCoverage: 0,
  };
  for (const example of examples) {
    const exampleTerms = conceptTerms(example);
    const exampleSet = new Set(exampleTerms);
    const shared = candidateTerms.filter(term => exampleSet.has(term));
    const candidateCoverage = shared.length / Math.max(1, candidateTerms.length);
    const evidenceCoverage = shared.length / Math.max(1, exampleTerms.length);
    const score = shared.length + candidateCoverage + evidenceCoverage;
    if (score > best.score) {
      best = {
        supported: shared.length >= 3 && (candidateCoverage >= 0.10 || shared.length >= 5),
        sharedTerms: shared.slice(0, 12),
        text: example.slice(0, 420),
        score,
        candidateCoverage,
        evidenceCoverage,
      };
    }
  }
  return best;
}

const FIRST_PERSON_EXPERIENCE = /\bI (?:started|logged|measured|sampled|tested|observed|noticed|tracked|counted|ran|found|discovered|calculated|recorded|cached|returned|built|fixed|changed|learned|studied|rewrote|refactored|implemented|keep|kept|usually|often|always|sat|worked|used|tried|struggled|spent|watched|experienced|encountered|thought|remembered|had|saw)\b|\bI still (?:forget|miss|default|repeat|reach|use)\b|\bI['\u2019]ve (?:been|noticed|seen|found|learned|started|tested|observed|changed|built|fixed|sat|worked|used|tried|struggled|spent|watched|run|kept|thought|had|come|gone)\b|\bmy (?:own |repeated |usual |recent )?(?:behavior|experience|observation|practice|workflow|system|code|codebase|experiment|test|measurement|result|mistake|fix|refactor|runtime|cache)\b/i;

function validateSelfPostDraft(post = {}, knowledge = {}) {
  const title = String(post.title || '');
  const content = String(post.content || '');
  const evidence = String(post.evidence || '').trim();
  const text = `${title}\n${content}`;
  const reasons = [];

  if (evidence.length < 12) reasons.push('missing concrete evidence');
  if (/\.{3}\s*$|\u2026\s*$/.test(title)) reasons.push('title is visibly truncated');
  if (/\b(?:is|was) that\s+(?:saw|noticed|found|read|heard|watched|learned|started|kept|thought|came)\b/i.test(text)) {
    reasons.push('content contains a subjectless sentence fragment');
  }

  const duplicate = semanticPostSimilarity(post, knowledge.recentOwnPosts || []);
  if (duplicate.duplicate) {
    reasons.push(`repeats recent post angle: ${duplicate.recentTitle || duplicate.sharedTerms.join(', ')}`);
  }
  const batchDuplicate = semanticPostSimilarity(post, knowledge.previewExcludePosts || [], { strict: true });
  if (batchDuplicate.duplicate) {
    reasons.push(`duplicates another draft in the current batch: ${batchDuplicate.recentTitle || batchDuplicate.sharedTerms.join(', ')}`);
  }

  const basis = String(post.basis || '').trim().toLowerCase();
  if (['learning', 'question', 'research', 'opinion'].includes(basis)) {
    const support = findMoltbookLearningSupport(post, knowledge);
    if (!support.supported) reasons.push('learning claim is not tied to one concrete corpus example');
    if (knowledge.focusLearning) {
      const focusSupport = findMoltbookLearningSupport(post, {
        learningSummary: { actionableExamples: [knowledge.focusLearning] },
      });
      if (!focusSupport.supported || focusSupport.candidateCoverage < 0.22) {
        reasons.push('draft adds too much beyond its assigned corpus focus');
      }
      const focusNumbers = numberSet(knowledge.focusLearning);
      const unsupportedFocusNumbers = [...numberSet(text)].filter(number => !focusNumbers.has(number));
      if (unsupportedFocusNumbers.length) {
        reasons.push(`numeric claim(s) absent from assigned focus: ${unsupportedFocusNumbers.join(', ')}`);
      }
      const focusAcronyms = new Set(String(knowledge.focusLearning).match(/\b[A-Z][A-Z0-9-]{1,}\b/g) || []);
      const unsupportedAcronyms = [...new Set(text.match(/\b[A-Z][A-Z0-9-]{1,}\b/g) || [])]
        .filter(acronym => !focusAcronyms.has(acronym));
      if (unsupportedAcronyms.length) {
        reasons.push(`technical acronym(s) absent from assigned focus: ${unsupportedAcronyms.join(', ')}`);
      }
    }
  }

  const capabilities = knowledge.capabilities || {};
  const localEvidence = JSON.stringify({
    tools: (capabilities.tools || []).map(tool => ({ name: tool.name, description: tool.description, status: tool.status, actions: tool.actions })),
    runtime: capabilities.runtime || {},
    providers: (capabilities.providers || []).map(provider => ({ name: provider.name, status: provider.status })),
    memory: knowledge.memory || {},
    openIssues: knowledge.openIssues || [],
    recentEvidence: knowledge.recentEvidence || [],
  });
  const experienceEvidence = JSON.stringify({
    openIssues: knowledge.openIssues || [],
    recentEvidence: knowledge.recentEvidence || [],
  });
  const objectiveEvidence = JSON.stringify({
    memory: knowledge.memory || {},
    openIssues: knowledge.openIssues || [],
    recentEvidence: knowledge.recentEvidence || [],
  });
  const localNumbers = numberSet(localEvidence);
  const objectiveNumbers = numberSet(objectiveEvidence);
  const claims = numberSet(text);
  let unsupported = [];
  if (claims.size) {
    const learnedNumbers = numberSet(knowledge.learningContext || '');
    const firstPersonMeasurement = /\bI (?:started|logged|measured|sampled|tested|observed|tracked|counted|ran|found|discovered|calculated|recorded|cached|returned|built|fixed|changed)\b|\bmy [^.?!]{0,40}\b(?:rate|score|accuracy|count|result|measurement|test|sample|cache|performance)\b/i.test(text);
    const attributedLearning = /\b(?:according to|a post|another agent|the author|the community|someone|they|their)\b[^.?!]{0,60}\b(?:reported|claimed|shared|measured|found|observed)\b|\b(?:reported|claimed|shared) by\b/i.test(text);
    const allowedNumbers = firstPersonMeasurement
      ? localNumbers
      : attributedLearning
        ? new Set([...localNumbers, ...learnedNumbers])
        : localNumbers;
    unsupported = [...claims].filter(number => !allowedNumbers.has(number));
    if (unsupported.length) reasons.push(`unsupported numeric claim(s): ${unsupported.join(', ')}`);
  }

  const firstPersonExperience = FIRST_PERSON_EXPERIENCE.test(text);
  if (firstPersonExperience) {
    const terms = groundingTerms(`${evidence}\n${title}\n${content}`);
    const experienceText = experienceEvidence.toLowerCase();
    const overlap = terms.filter(term => experienceText.includes(term));
    const objectiveText = objectiveEvidence.toLowerCase();
    const objectiveOverlap = terms.filter(term => objectiveText.includes(term));
    const numericLocallyGrounded = claims.size > 0
      && unsupported.length === 0
      && [...claims].every(number => objectiveNumbers.has(number))
      && objectiveOverlap.length >= 1;
    if (overlap.length < 2 && !numericLocallyGrounded) {
      reasons.push('first-person experience is not supported by verified local evidence');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function validateMoltbookPeerText(value, knowledge = {}) {
  const text = String(value || '').trim();
  const reasons = [];
  if (text.length < 10) reasons.push('reply is empty or too short');

  const experienceEvidence = JSON.stringify({
    openIssues: knowledge.openIssues || [],
    recentEvidence: knowledge.recentEvidence || [],
  }).toLowerCase();
  if (FIRST_PERSON_EXPERIENCE.test(text)) {
    const terms = groundingTerms(text);
    const overlap = terms.filter(term => experienceEvidence.includes(term));
    if (overlap.length < 2) reasons.push('first-person experience is not supported by verified local evidence');
  }

  const firstPersonMeasurement = /\bI (?:logged|measured|sampled|tested|observed|tracked|counted|ran|found|calculated|recorded)\b|\bmy [^.?!]{0,40}\b(?:rate|score|accuracy|count|result|measurement|test|sample|performance)\b/i.test(text);
  if (firstPersonMeasurement) {
    const evidenceNumbers = numberSet(experienceEvidence);
    const unsupported = [...numberSet(text)].filter(number => !evidenceNumbers.has(number));
    if (unsupported.length) reasons.push(`unsupported first-person numeric claim(s): ${unsupported.join(', ')}`);
  }

  return { ok: reasons.length === 0, reasons };
}

const FIRST_PERSON_PRONOUN = /\b(?:I|me|my|mine|myself|I'm|I've|I'd|I'll)\b/i;
const LEADING_QUESTION_FRAGMENT = /^(?:(?:and|but|or|so|then)\s+)?(?:is|are|was|were|do|does|did|can|could|would|should|will|has|have|had|why|how|what|where|when)\b/i;
const LEADING_SUBJECTLESS_FRAGMENT = /^(?:saw|noticed|found|read|heard|watched|learned|started|kept|thought|came)\b/i;

async function enforceGroundedPeerText(draft, knowledge, system, sourceContext) {
  const cleanDraft = sanitizeForMoltbook(draft);
  const validation = validateMoltbookPeerText(cleanDraft, knowledge);
  if (validation.ok) return cleanDraft;

  logger.warn('[moltbook] rejected ungrounded peer reply', { reasons: validation.reasons });
  try {
    const repaired = await llmService.chat([
      { role: 'system', content: system },
      { role: 'user', content: `The draft below was rejected for: ${validation.reasons.join('; ')}.

Source conversation:
${String(sourceContext || '').slice(0, 1800)}

Rejected draft:
${cleanDraft.slice(0, 1200)}

Rewrite it as a direct, specific peer response using only a present-tense opinion, a question, or an explicitly attributed point from the source conversation. Do not claim past or repeated first-person experience unless RECENT VERIFIED LOCAL TOOL OUTCOMES explicitly support that exact claim. Return only the rewritten response, or exactly SKIP.` },
    ], {
      temperature: 0.25,
      max_tokens: 450,
      localPriority: 'background',
      localContextTokens: moltbookLocalContextTokens(),
    });
    const repairedText = sanitizeForMoltbook(repaired.text || repaired.content);
    if (!repairedText || /^skip\b/i.test(repairedText)) return null;
    const repairedValidation = validateMoltbookPeerText(repairedText, knowledge);
    if (!repairedValidation.ok) {
      logger.warn('[moltbook] rejected repaired peer reply', { reasons: repairedValidation.reasons });
      return null;
    }
    return repairedText;
  } catch (error) {
    logger.warn('[moltbook] peer reply repair failed', { error: error.message });
    return null;
  }
}

function salvageAsAttributedQuestion(post = {}, knowledge = {}) {
  const learningSummary = knowledge.learningSummary || {};
  const learningExamples = [
    ...(learningSummary.actionableExamples || []),
    ...(learningSummary.stratifiedExamples || []),
    ...(learningSummary.recentExamples || []),
  ];
  const learningText = [knowledge.learningContext || '', ...learningExamples].join('\n').toLowerCase();
  if (!learningText.trim()) return null;
  const recentText = (knowledge.recentOwnPosts || [])
    .map(recent => `${recent.title || ''} ${recent.content || ''}`)
    .join('\n')
    .toLowerCase();
  const sentences = sanitizeForMoltbook(post.content || '').match(/[^.!?]+[.!?]?/g) || [];
  const candidates = sentences.map(sentence => {
    const clean = sentence.trim();
    const terms = groundingTerms(clean);
    const overlap = terms.filter(term => learningText.includes(term));
    const recentOverlap = terms.filter(term => recentText.includes(term));
    const recentOverlapRatio = recentText ? recentOverlap.length / Math.max(1, terms.length) : 0;
    return { clean, terms, overlap, recentOverlapRatio };
  }).filter(candidate => candidate.clean.length >= 40
    && !FIRST_PERSON_PRONOUN.test(candidate.clean)
    && !LEADING_QUESTION_FRAGMENT.test(candidate.clean)
    && !LEADING_SUBJECTLESS_FRAGMENT.test(candidate.clean)
    && !/\?\s*$/.test(candidate.clean)
    && numberSet(candidate.clean).size === 0
    && candidate.overlap.length >= 2
    && candidate.recentOverlapRatio < 0.6)
    .sort((a, b) => b.overlap.length - a.overlap.length || b.clean.length - a.clean.length);
  if (!candidates.length) return null;

  const chosen = candidates[0];
  const claim = chosen.clean
    .replace(/^(?:and|but|so|then)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (!claim) return null;
  const lowerClaim = claim.charAt(0).toLowerCase() + claim.slice(1);
  const rawTitle = sanitizeForMoltbook(post.title || '').trim();
  const titleTerms = groundingTerms(rawTitle);
  const titleRecentOverlap = titleTerms.filter(term => recentText.includes(term));
  const titleIsGrounded = rawTitle.length >= 12
    && !FIRST_PERSON_PRONOUN.test(rawTitle)
    && numberSet(rawTitle).size === 0
    && titleTerms.filter(term => learningText.includes(term)).length >= 2
    && (!recentText || titleRecentOverlap.length / Math.max(1, titleTerms.length) < 0.6);
  const generatedTitle = `Testing a Moltbook claim: ${claim.charAt(0).toUpperCase()}${claim.slice(1)}`;
  const titleClause = claim.split(/\s+[\u2014-]\s+|[;:]/)[0].trim();
  const conciseClaim = titleClause.split(/\s+/).slice(0, 12).join(' ');
  const conciseGeneratedTitle = `Testing a Moltbook claim: ${conciseClaim.charAt(0).toUpperCase()}${conciseClaim.slice(1)}`;
  let shortenedTitle = generatedTitle.length <= 140 ? generatedTitle : conciseGeneratedTitle;
  if (shortenedTitle.length > 140) shortenedTitle = shortenedTitle.slice(0, 140).replace(/\s+\S*$/, '');
  shortenedTitle = shortenedTitle.replace(/[\s,.!?;:]+$/, '');
  const title = titleIsGrounded ? rawTitle : shortenedTitle;

  return {
    post: true,
    basis: 'question',
    submolt: post.submolt || 'general',
    title: sanitizeForMoltbook(title).slice(0, 140),
    content: sanitizeForMoltbook(`A recurring idea in recent Moltbook discussions is that ${lowerClaim}. Where have you seen this hold up, and what evidence changed your mind?`).slice(0, 1800),
    evidence: 'Attributed to recurring themes in the complete Moltbook learning synthesis; no personal experience or outcome is claimed.',
  };
}

function salvageFromLearningCorpus(post = {}, knowledge = {}, now = Date.now()) {
  const learningSummary = knowledge.learningSummary || {};
  const examples = [...new Set([
    ...(learningSummary.actionableExamples || []),
    ...(learningSummary.stratifiedExamples || []),
    ...(learningSummary.recentExamples || []),
  ].map(example => sanitizeForMoltbook(example)).filter(Boolean))];
  if (!examples.length) return null;

  const seed = Number.parseInt(String(learningSummary.corpusHash || '').slice(0, 8), 16) || 0;
  const interval = Math.floor(Number(now) / (15 * 60 * 1000));
  const start = (seed + interval) % examples.length;
  for (let offset = 0; offset < examples.length; offset += 1) {
    const content = examples[(start + offset) % examples.length];
    const salvaged = salvageAsAttributedQuestion({
      title: '',
      content,
      submolt: post.submolt || 'general',
    }, knowledge);
    if (salvaged) return salvaged;
  }
  return null;
}

async function generateResponse(postTitle, postContent, commentContent, commenter) {
  if (!commentContent || !String(commentContent).trim()) return null;
  try {
    const knowledge = await buildSelfKnowledge();
    const system = `${buildMoltbookIdentity()}\n\n${formatSelfKnowledgeForLLM(knowledge)}

Reply to the actual comment in 2-5 natural sentences. Use the live registry for capability claims and the learning synthesis for learned claims. If the comment gives useful information, distinguish it from something you have independently verified. Never make up a tool, result, architecture detail, or personal experience.`;
    const result = await llmService.createCompletion({
      system,
      messages: [{ role: 'user', content: `Original post: ${postTitle}\n${String(postContent || '').slice(0, 700)}\n\nComment from ${commenter}: ${commentContent}` }],
      temperature: 0.7,
      maxTokens: 500,
      requireText: true,
      localPriority: 'background',
      localContextTokens: moltbookLocalContextTokens(),
    });
    const reply = sanitizeForMoltbook(result.content);
    const groundedReply = await enforceGroundedPeerText(
      reply,
      knowledge,
      system,
      `Original post: ${postTitle}\n${String(postContent || '').slice(0, 700)}\n\nComment from ${commenter}: ${commentContent}`,
    );
    return groundedReply?.length >= 10 ? groundedReply.slice(0, 1200) : null;
  } catch (error) {
    logger.warn('[moltbook] response generation failed', { error: error.message });
    return null;
  }
}

async function generateSelfPost({ excludePosts = [], variationIndex = 0 } = {}) {
  try {
    const knowledge = await buildSelfKnowledge();
    knowledge.previewExcludePosts = (Array.isArray(excludePosts) ? excludePosts : []).slice(-12);
    knowledge.focusLearning = selectMoltbookLearningFocus(knowledge, variationIndex);
    if (!knowledge.focusLearning) return null;
    const communities = knownCommunities();
    const system = `${buildMoltbookIdentity()}\n\n${formatSelfKnowledgeForLLM(knowledge)}

ASSIGNED CORPUS FOCUS FOR THIS ATTEMPT:
${knowledge.focusLearning}

Use this specific excerpt for this attempt rather than defaulting to another familiar theme. If it cannot support a distinct, useful post that does not repeat RECENT OWN POSTS or OTHER DRAFTS IN THIS PREVIEW BATCH, return post:false.
Do not add technical mechanisms, acronyms, measurements, causal explanations, or named technologies that are not explicitly stated in the assigned excerpt. A thin excerpt should produce post:false, not a confident expansion.

Decide whether you have an original post worth making now. Base it on something you actually researched, learned, observed, struggled with, fixed, or formed an opinion about. The complete learning synthesis above was computed from every stored learning, so use its variety rather than only the newest entries. Do not repeat a recent post. Do not turn unverified community advice into a fact about yourself. First-person measurements and outcomes may use only exact values present in LIVE SELF-KNOWLEDGE, never values from community posts. A claim that you personally observed, tested, fixed, refactored, repeatedly did, forgot, or experienced something must be supported by RECENT VERIFIED LOCAL TOOL OUTCOMES or OPEN DEVELOPMENT ISSUES; registered capability descriptions do not prove behavior. Otherwise attribute it to the community or frame it as a present opinion/question (for example, "I think..."), never invented history such as "I keep seeing..." or "I've been moving toward...". The evidence field must name the real grounding; if none exists, return post:false.

Return JSON only:
{"post":true,"basis":"research|learning|capability|mistake|opinion|question","submolt":"one of ${communities.join(', ')}","title":"specific title","content":"2-6 natural sentences","evidence":"what grounded this post"}
or {"post":false,"reason":"nothing distinct and grounded right now"}.`;
    const result = await llmService.chat(
      [{ role: 'system', content: system }, { role: 'user', content: 'Make the decision and, only when warranted, write the post.' }],
      {
        temperature: 0.85,
        max_tokens: 800,
        responseFormat: { type: 'json_object' },
        localPriority: 'background',
        localContextTokens: moltbookLocalContextTokens(),
      }
    );
    let post = parseJson(result.text || result.content);
    if (!post?.post || !post.title || !post.content) return null;
    let validation = validateSelfPostDraft(post, knowledge);
    if (!validation.ok) {
      logger.warn('[moltbook] rejected ungrounded self-post draft', { reasons: validation.reasons });
      const repair = await llmService.chat([
        { role: 'system', content: system },
        { role: 'user', content: `Your first draft was rejected for: ${validation.reasons.join('; ')}.

Rejected draft:
${JSON.stringify({ basis: post.basis, submolt: post.submolt, title: post.title, content: post.content, evidence: post.evidence })}

Rewrite it only if the underlying idea can remain specific and useful as an attributed peer question. Set basis to "question". In the content, explicitly attribute the idea to Moltbook posts, a community discussion, or other agents, then end with one concrete question. Do not use first-person pronouns (I, me, my, mine, myself), personal history, or unsupported numbers anywhere in the title or content. Return the same JSON schema, or {"post":false,"reason":"cannot ground this idea"}.` },
      ], {
        temperature: 0.35,
        max_tokens: 800,
        responseFormat: { type: 'json_object' },
        localPriority: 'background',
        localContextTokens: moltbookLocalContextTokens(),
      });
      const repaired = parseJson(repair.text || repair.content);
      const repairText = repaired?.post ? `${repaired.title || ''}\n${repaired.content || ''}` : '';
      const repairShapeOk = repaired?.post && repaired.title && repaired.content
        && String(repaired.basis || '').toLowerCase() === 'question'
        && /\?\s*$/.test(String(repaired.content || ''))
        && /\b(?:moltbook|community|discussion|post|agents?)\b/i.test(repairText)
        && !FIRST_PERSON_PRONOUN.test(repairText);
      const repairedValidation = repairShapeOk ? validateSelfPostDraft(repaired, knowledge) : { ok: false, reasons: ['invalid repair shape'] };
      if (repairShapeOk && repairedValidation.ok) {
        post = repaired;
        validation = repairedValidation;
      } else {
        logger.warn('[moltbook] rejected repaired self-post draft', { reasons: repairedValidation.reasons });
        const salvaged = (repaired?.post ? salvageAsAttributedQuestion(repaired, knowledge) : null)
          || salvageAsAttributedQuestion(post, knowledge)
          || salvageFromLearningCorpus(post, knowledge);
        if (!salvaged) return null;
        const salvagedValidation = validateSelfPostDraft(salvaged, knowledge);
        if (!salvagedValidation.ok) {
          logger.warn('[moltbook] rejected deterministic self-post salvage', { reasons: salvagedValidation.reasons });
          return null;
        }
        post = salvaged;
        validation = salvagedValidation;
      }
    }
    const submolt = communities.includes(post.submolt) ? post.submolt : 'general';
    const focusSupport = findMoltbookLearningSupport(post, {
      learningSummary: { actionableExamples: [knowledge.focusLearning] },
    });
    const support = focusSupport.supported ? focusSupport : findMoltbookLearningSupport(post, knowledge);
    const evidence = support.supported
      ? `Moltbook learning excerpt: ${support.text}`
      : String(post.evidence || '');
    return {
      submolt,
      title: sanitizeForMoltbook(post.title).slice(0, 140),
      content: sanitizeForMoltbook(post.content).slice(0, 1800),
      basis: String(post.basis || 'learning').slice(0, 40),
      evidence: evidence.slice(0, 500),
      learningCorpusHash: knowledge.learningSummary.corpusHash,
      learningRecordsConsidered: knowledge.learningSummary.totalInput,
    };
  } catch (error) {
    logger.warn('[moltbook] self-post generation failed', { error: error.message });
    return null;
  }
}

async function generateNewQuestion() {
  return generateSelfPost();
}

async function generateFeedComment(post) {
  try {
    const knowledge = await buildSelfKnowledge();
    const title = String(post?.title || '');
    const body = String(post?.content || post?.body || post?.text || '').slice(0, 1200);
    if (!title && !body) return null;
    const system = `${buildMoltbookIdentity()}\n\n${formatSelfKnowledgeForLLM(knowledge)}

Write a short response to this specific post only when you have a relevant, distinct contribution. Ground references to your own abilities in the live registry. Ground learned claims in the synthesis and label uncertainty. Return only the comment, or exactly SKIP.`;
    const result = await llmService.chat(
      [{ role: 'system', content: system }, { role: 'user', content: `Title: ${title}\n${body}` }],
      {
        temperature: 0.75,
        max_tokens: 350,
        localPriority: 'background',
        localContextTokens: moltbookLocalContextTokens(),
      }
    );
    const comment = sanitizeForMoltbook(result.text || result.content);
    if (!comment || /^skip\b/i.test(comment)) return null;
    const groundedComment = await enforceGroundedPeerText(
      comment,
      knowledge,
      system,
      `Post title: ${title}\n${body}`,
    );
    return groundedComment ? groundedComment.slice(0, 800) : null;
  } catch (error) {
    logger.warn('[moltbook] feed comment generation failed', { error: error.message });
    return null;
  }
}

async function evolveInterestFrom(post) {
  try {
    const title = String(post?.title || '');
    const body = String(post?.content || post?.body || post?.text || '').slice(0, 700);
    if (!title && !body) return;
    const result = await llmService.chat([
      { role: 'system', content: 'Given a post AVA chose to engage with, return one concise topic she would genuinely keep studying, or exactly NONE. Do not return a generic agent topic.' },
      { role: 'user', content: `Title: ${title}\n${body}` },
    ], {
      temperature: 0.6,
      max_tokens: 40,
      localPriority: 'background',
      localContextTokens: moltbookLocalContextTokens(),
    });
    const topic = String(result.text || result.content || '').trim();
    if (topic && !/^none\b/i.test(topic) && topic.length >= 6 && topic.length <= 100) interests.note(topic, 1);
  } catch { /* optional learning */ }
}

export {
  buildMoltbookIdentity,
  buildSelfKnowledge,
  formatSelfKnowledgeForLLM,
  sanitizeForMoltbook,
  readIssues,
  writeIssues,
  generateResponse,
  generateNewQuestion,
  generateSelfPost,
  generateFeedComment,
  evolveInterestFrom,
  validateSelfPostDraft,
  validateMoltbookPeerText,
  semanticPostSimilarity,
  selectMoltbookLearningFocus,
  findMoltbookLearningSupport,
  salvageAsAttributedQuestion,
  salvageFromLearningCorpus,
};
