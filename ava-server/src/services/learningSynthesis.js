// Deterministically condense an arbitrarily large learning corpus so every
// record influences the result without overflowing an LLM context window.
import crypto from 'crypto';

const STOP = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before',
  'being', 'but', 'can', 'could', 'for', 'from', 'have', 'into', 'isn', 'its',
  'just', 'more', 'not', 'of', 'on', 'or', 'our', 'rather', 'should', 'than', 'that', 'the', 'their', 'then',
  'there', 'these', 'they', 'this', 'through', 'to', 'use', 'using', 'was',
  'were', 'what', 'when', 'where', 'which', 'with', 'would', 'you', 'your',
]);

function fieldsOf(item) {
  const title = String(item?.topic || item?.title || '').replace(/\s+/g, ' ').trim();
  const detail = String(item?.insight || item?.summary || item?.content || item?.lesson || '')
    .replace(/\s+/g, ' ').trim();
  return { title, detail, text: `${title} ${detail}`.trim() };
}

function normalized(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function increment(map, key, amount = 1) {
  if (key) map.set(key, (map.get(key) || 0) + amount);
}

function top(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export function synthesizeLearnings(items, options = {}) {
  const corpus = Array.isArray(items) ? items : [];
  const unique = new Map();
  const keywords = new Map();
  const phrases = new Map();
  const sources = new Map();
  const actionable = [];
  const seenParents = new Set();
  const corpusHash = crypto.createHash('sha256');

  for (const item of corpus) {
    const { title, detail, text } = fieldsOf(item);
    if (!text) continue;
    const clean = normalized(text);
    if (!clean) continue;
    corpusHash.update(clean).update('\n');
    if (unique.has(clean)) continue;
    const normalizedTitle = normalized(title);
    const parentKey = String(item?.postId || item?.parentPostId
      || (normalizedTitle ? `title:${normalizedTitle}` : `record:${clean}`));
    const isNewParent = !seenParents.has(parentKey);
    if (isNewParent) seenParents.add(parentKey);

    const exampleText = item?.commentId && detail ? detail : text;
    unique.set(clean, { item, text: exampleText });
    const keywordVotes = new Set();
    const phraseVotes = new Set();
    const segments = [detail];
    if (isNewParent) segments.unshift(title);
    for (const segment of segments.filter(Boolean)) {
      const rawTokens = normalized(segment).split(' ').filter(token => token.length > 2);
      for (const token of rawTokens) {
        if (!STOP.has(token)) keywordVotes.add(token);
      }
      for (let i = 0; i < rawTokens.length - 1; i += 1) {
        if (STOP.has(rawTokens[i]) || STOP.has(rawTokens[i + 1])) continue;
        const phrase = `${rawTokens[i]} ${rawTokens[i + 1]}`;
        if (phrase.length <= 60) phraseVotes.add(phrase);
      }
    }
    for (const token of keywordVotes) increment(keywords, token);
    for (const phrase of phraseVotes) increment(phrases, phrase);
    if (isNewParent) increment(sources, item?.submolt || item?.source || item?.community || 'unknown');
    if (/\b(avoid|failure|fix|improve|lesson|mistake|reliab|retry|verify|evidence|memory|tool|workflow|security|latency|context)\b/i.test(exampleText)) {
      actionable.push(exampleText.slice(0, 320));
    }
  }

  const distinct = [...unique.values()];
  const sampleLimit = Math.max(10, options.sampleLimit || 40);
  const stride = Math.max(1, Math.floor(distinct.length / sampleLimit));
  const sampled = [];
  for (let i = 0; i < distinct.length && sampled.length < sampleLimit; i += stride) sampled.push(distinct[i].text.slice(0, 320));
  const recent = distinct.slice(-Math.max(10, options.recentLimit || 30)).map(x => x.text.slice(0, 320));

  return {
    totalInput: corpus.length,
    uniqueCount: distinct.length,
    duplicateCount: Math.max(0, corpus.length - distinct.length),
    parentCount: seenParents.size,
    corpusHash: corpusHash.digest('hex'),
    themes: top(phrases, options.themeLimit || 50),
    keywords: top(keywords, options.keywordLimit || 40),
    sources: top(sources, options.sourceLimit || 30),
    actionableExamples: [...new Set(actionable)].slice(-Math.max(10, options.actionableLimit || 40)),
    stratifiedExamples: sampled,
    recentExamples: recent,
  };
}

export function formatLearningSynthesis(summary, maxChars = 18000) {
  if (!summary?.totalInput) return 'No community learnings are currently stored.';
  const limit = Math.max(200, Number(maxChars) || 18000);
  const header = [
    `Corpus: ${summary.totalInput} records considered; ${summary.uniqueCount} unique; ${summary.duplicateCount} duplicates; ${summary.parentCount || summary.uniqueCount} parent discussions; hash ${summary.corpusHash}.`,
    `Themes: ${(summary.themes || []).map(x => `${x.name} (${x.count})`).join('; ')}`,
    `Sources: ${(summary.sources || []).map(x => `${x.name} (${x.count})`).join('; ')}`,
  ].join('\n').slice(0, Math.min(3500, Math.max(300, Math.floor(limit * 0.22))));

  const remaining = Math.max(0, limit - header.length - 3);
  const budgets = {
    actionable: Math.floor(remaining * 0.30),
    stratified: Math.floor(remaining * 0.40),
    recent: remaining - Math.floor(remaining * 0.30) - Math.floor(remaining * 0.40),
  };
  const section = (label, items, budget) => {
    if (budget <= 0) return '';
    let text = label.slice(0, budget);
    for (const item of items || []) {
      const line = `\n- ${String(item || '').trim()}`;
      const room = budget - text.length;
      if (room <= 4) break;
      if (line.length <= room) {
        text += line;
      } else {
        text += line.slice(0, room);
        break;
      }
    }
    return text;
  };

  return [
    header,
    section('Actionable examples:', summary.actionableExamples, budgets.actionable),
    section('Stratified examples from across the full corpus:', summary.stratifiedExamples, budgets.stratified),
    section('Most recent examples:', summary.recentExamples, budgets.recent),
  ].filter(Boolean).join('\n').slice(0, limit);
}

export default { synthesizeLearnings, formatLearningSynthesis };
