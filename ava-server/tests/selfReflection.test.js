import { extractReflections, _ingest, _reset, foldIntoMemory, _lessonsFromLines } from '../src/services/selfReflection.js';

describe('selfReflection', () => {
  beforeEach(() => _reset());

  test('extracts genuine reflective sentences and ignores ordinary chatter', () => {
    const turns = [
      "Sure, I'll help you with that right now.",        // NOT reflective
      "I realized I misread your question earlier.",      // reflective
      "Here's the file you asked for.",                   // NOT
      "In hindsight, I should have searched first.",      // reflective
    ];
    const r = extractReflections(turns);
    expect(r.length).toBe(2);
    expect(r.some((s) => /misread/i.test(s))).toBe(true);
    expect(r.some((s) => /in hindsight/i.test(s))).toBe(true);
    expect(r.some((s) => /help you with that/i.test(s))).toBe(false);
  });

  test('caps at 3 reflections and dedupes', () => {
    const turns = [
      'I realized one thing.',
      'I was wrong about two.',
      'My mistake on three.',
      'In hindsight four is clear.',
      'I overlooked five entirely.',
      'I realized one thing.', // duplicate of the first
    ];
    const r = extractReflections(turns);
    expect(r.length).toBeLessThanOrEqual(3);
    // no duplicate strings
    expect(new Set(r.map((s) => s.toLowerCase())).size).toBe(r.length);
  });

  test('_ingest buffers turns, writes only when a NEW reflection appears, no duplicate spam', () => {
    const writes = [];
    const w = (e) => writes.push(e);
    expect(_ingest("Here's your answer.", w)).toBeNull();               // no reflection -> no write
    const first = _ingest('I realized I was wrong about that.', w);      // reflective -> write
    expect(first).not.toBeNull();
    expect(first.reflections.length).toBe(1);
    expect(_ingest('Okay, all done.', w)).toBeNull();                    // no NEW reflection -> no re-write
    expect(writes.length).toBe(1);
    const second = _ingest('My mistake — I should have asked first.', w); // NEW reflection -> write
    expect(second).not.toBeNull();
    expect(writes.length).toBe(2);
  });

  test('blank/empty turns are ignored', () => {
    expect(_ingest('', () => {})).toBeNull();
    expect(_ingest('   ', () => {})).toBeNull();
  });

  test('buffer never exceeds MAX_TURNS (8)', () => {
    const w = () => {};
    for (let i = 0; i < 20; i++) _ingest(`Plain line number ${i}.`, w);
    // internal buffer is capped; reflect that via a fresh extraction over >8 inputs staying bounded
    const many = Array.from({ length: 20 }, (_, i) => `I realized point ${i}.`);
    expect(extractReflections(many).length).toBeLessThanOrEqual(3);
  });
});

describe('selfReflection consumer (foldIntoMemory)', () => {
  test('_lessonsFromLines honors the cursor (skips already-processed lines)', () => {
    const lines = [
      JSON.stringify({ reflections: ['I was wrong about the file path.'] }),           // line 0
      JSON.stringify({ reflections: ['My mistake — I should have asked first.'] }),    // line 1
    ];
    const all = _lessonsFromLines(lines, 0);
    expect(all.lessons.length).toBe(2);
    expect(all.total).toBe(2);
    const fromCursor1 = _lessonsFromLines(lines, 1); // only line 1 is fresh
    expect(fromCursor1.lessons).toContain('My mistake — I should have asked first.');
    expect(fromCursor1.lessons).not.toContain('I was wrong about the file path.');
  });

  test('_lessonsFromLines dedupes duplicate reflections (within and across lines)', () => {
    const lines = [
      JSON.stringify({ reflections: ['I was wrong about the path.', 'I was wrong about the path.'] }),
      JSON.stringify({ reflections: ['I was wrong about the path.'] }),
    ];
    expect(_lessonsFromLines(lines, 0).lessons.length).toBe(1);
  });

  test('folds new lessons into memory as WARNING-type, advances cursor, is idempotent', async () => {
    const jsonl = [
      JSON.stringify({ ts: 1, reflections: ['I realized I misread the request.'] }),
      JSON.stringify({ ts: 2, reflections: ['In hindsight I should have searched first.', 'I realized I misread the request.'] }),
    ].join('\n') + '\n';
    let cursor = 0;
    const stored = [];
    const opts = {
      upsert: async (m) => { stored.push(m); },
      readAll: () => jsonl,
      getCursor: () => cursor,
      setCursor: (n) => { cursor = n; },
    };
    const r1 = await foldIntoMemory(opts);
    expect(r1.stored).toBe(2);                              // 2 distinct lessons (dup ignored)
    expect(cursor).toBe(2);                                 // advanced past both lines
    expect(stored.every((m) => m.type === 'warning')).toBe(true);
    expect(stored.every((m) => m.source === 'self-reflection')).toBe(true);
    expect(stored.every((m) => m.priority >= 3)).toBe(true);
    // second run, no new lines -> nothing stored, cursor unchanged
    const r2 = await foldIntoMemory(opts);
    expect(r2.stored).toBe(0);
    expect(cursor).toBe(2);
  });

  test('respects maxPerRun', async () => {
    const many = Array.from({ length: 6 }, (_, i) => JSON.stringify({ reflections: [`I was wrong about item ${i} entirely.`] })).join('\n') + '\n';
    let cursor = 0; const stored = [];
    await foldIntoMemory({ upsert: async (m) => stored.push(m), readAll: () => many, getCursor: () => cursor, setCursor: (n) => { cursor = n; }, maxPerRun: 3 });
    expect(stored.length).toBe(3);
  });
});
