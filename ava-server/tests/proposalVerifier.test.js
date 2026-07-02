// proposalVerifier tests — Tier 3 #21a. Fixtures are the REAL failure classes from the
// 2026-07-02 audit + delegated proposal review (invented worker commands, module.exports in
// ESM, methods no service exports, imports of files that don't exist).
import path from 'path';
import { verifyClaims, addedText, describeViolations } from '../src/services/proposalVerifier.js';

// A pretend target inside the real services dir, so relative resolution uses real files.
const TARGET = path.resolve('src', 'services', '__verifier_fixture__.js');

const run = (currentContent, newContent) =>
  verifyClaims({ targetFile: TARGET, currentContent, newContent });

describe('proposalVerifier', () => {
  test('addedText returns only lines not present in the current file', () => {
    const cur = 'a\nb\nc';
    const next = 'a\nb\nc\nd\ne';
    expect(addedText(cur, next)).toBe('d\ne');
  });

  test('flags invented pythonWorker.sendCommand commands (environmentContext case)', () => {
    const r = run('', `
      import pythonWorker from './pythonWorker.js';
      const info = await pythonWorker.sendCommand('window_ops.get_foreground_info', {});
    `);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'worker-command')).toBe(true);
  });

  test('accepts real worker commands', () => {
    const r = run('', `
      import pythonWorker from './pythonWorker.js';
      const tools = await pythonWorker.sendCommand('list_tools', {});
    `);
    expect(r.violations.filter(v => v.kind === 'worker-command')).toHaveLength(0);
  });

  test('flags module.exports and require() in an ES module (memoryHub case)', () => {
    const r = run('', `
      const result = await module.exports.default.deduplicateByVector();
      const { x } = require('./pythonWorker.js');
    `);
    expect(r.ok).toBe(false);
    expect(r.violations.filter(v => v.kind === 'esm').length).toBeGreaterThanOrEqual(2);
  });

  test('flags members that a locally-imported service never mentions (lessonLearner case)', () => {
    const current = `import curatedMemory from './curatedMemory.js';\n`;
    const r = run(current, `
      const prior = await curatedMemory.query('memory', 'rejection lesson', 5);
    `);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'member' && v.detail.includes('query'))).toBe(true);
  });

  test('accepts members the module really has', () => {
    const current = `import memoryHub from './memoryHub.js';\nimport logger from '../utils/logger.js';\n`;
    const r = run(current, `
      const res = await memoryHub.search('hello', 5);
      logger.info('ok');
    `);
    expect(r.violations.filter(v => v.kind === 'member')).toHaveLength(0);
  });

  test('flags relative imports that do not resolve (selfRestart ../llm.js case)', () => {
    const r = run('', `import { default as llmProvider } from '../llm.js';\n`);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'import')).toBe(true);
  });

  test('accepts relative imports that resolve', () => {
    const r = run('', `import llmService from './llm.js';\n`);
    expect(r.violations.filter(v => v.kind === 'import')).toHaveLength(0);
  });

  test('clean addition passes with zero violations', () => {
    const current = `import logger from '../utils/logger.js';\nfunction a() {}\n`;
    const r = run(current, `${current}\nfunction b() { logger.warn('hi'); return 2; }\n`);
    expect(r.ok).toBe(true);
  });

  test('describeViolations names every finding', () => {
    const r = run('', `const x = require('./llm.js');`);
    expect(describeViolations(r)).toMatch(/\[esm\]/);
  });
});
