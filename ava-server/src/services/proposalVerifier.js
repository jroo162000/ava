// proposalVerifier — Tier 3 #21a: deterministic API-claims checks for self-mod proposals.
//
// AVA's proposals have one dominant failure mode (dozens of rejections in the pending store,
// plus the 2026-07-02 audit): they reference plausible-sounding APIs that DO NOT EXIST —
// invented pythonWorker commands, methods no service exports, CommonJS idioms inside ESM,
// imports of files that aren't there. LLM reviewers miss these routinely; a grep does not.
//
// This module checks only the ADDED text of a proposal and flags CONFIDENT violations:
//   1. pythonWorker.sendCommand('<cmd>') where <cmd> is not a real worker command
//      (the worker's dispatch is a fixed `cmd == "..."` chain in ava_python_worker.py)
//   2. module.exports / require() in an ES module (everything under ava-server/src)
//   3. X.member(...) where X is a locally-imported service whose source never mentions
//      `member` (definition, export, property, or assignment)
//   4. a relative import that does not resolve to an existing file
//
// Design rules: fail-OPEN on infrastructure problems (unreadable files → skip that check),
// fail-CLOSED only on confident violations, and always name the exact claim so the rejection
// reason teaches her lesson loop something actionable.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import avaPaths from '../utils/paths.js';

const _moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Member names that legitimately appear on almost anything — never flag these.
const COMMON_MEMBERS = new Set([
  'then', 'catch', 'finally', 'call', 'apply', 'bind', 'toString', 'valueOf',
  'hasOwnProperty', 'constructor', 'length', 'name', 'default',
  'map', 'filter', 'forEach', 'reduce', 'push', 'pop', 'slice', 'splice', 'join',
  'includes', 'indexOf', 'find', 'findIndex', 'some', 'every', 'keys', 'values', 'entries',
  'get', 'set', 'has', 'add', 'delete', 'clear', 'trim', 'split', 'replace', 'match',
  'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'concat', 'sort', 'reverse',
]);

function stripComments(src) {
  // good enough for claim extraction: drop line comments and block comments
  return String(src || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// The worker's real command set, parsed from its dispatch chain. Cached per process.
let _workerCommands = null;
function workerCommands() {
  if (_workerCommands) return _workerCommands;
  // integrationDir() falls back to ~/ava/ava-integration, which is wrong on machines where the
  // repo lives elsewhere (this one) — so also try relative to THIS module (src/services -> repo).
  const candidates = [
    path.join(avaPaths.integrationDir(), 'ava_python_worker.py'),
    path.resolve(_moduleDir, '..', '..', '..', 'ava-integration', 'ava_python_worker.py'),
  ];
  for (const p of candidates) {
    try {
      const src = fs.readFileSync(p, 'utf8');
      const cmds = new Set();
      for (const m of src.matchAll(/cmd\s*==\s*["']([a-zA-Z0-9_.-]+)["']/g)) cmds.add(m[1]);
      if (cmds.size) { _workerCommands = cmds; return _workerCommands; }
    } catch { /* try the next candidate */ }
  }
  _workerCommands = null;
  return _workerCommands;
}

// Added lines = lines present in the proposed content but not in the current file.
export function addedText(currentContent, newContent) {
  const cur = new Set(String(currentContent || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean));
  return String(newContent || '').split(/\r?\n/)
    .filter(l => l.trim() && !cur.has(l.trim()))
    .join('\n');
}

// Collect local default-imports from BOTH the current file and the added text:
//   import X from './y.js'   /   import X, {...} from './y.js'   /   import * as X from './y.js'
function localImports(sources, targetDir) {
  const map = new Map(); // identifier -> absolute module path (if resolvable)
  for (const src of sources) {
    for (const m of stripComments(src).matchAll(/import\s+(?:\*\s+as\s+(\w+)|(\w+))\s*(?:,\s*\{[^}]*\})?\s*from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const ident = m[1] || m[2];
      const rel = m[3];
      if (!ident) continue;
      const base = path.resolve(targetDir, rel);
      for (const cand of [base, base + '.js', base + '.mjs', path.join(base, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { map.set(ident, cand); break; }
      }
      if (!map.has(ident)) map.set(ident, null); // imported but unresolvable — flagged separately
    }
  }
  return map;
}

/**
 * verifyClaims({ targetFile, currentContent, newContent })
 * -> { ok, checked: n, violations: [{ kind, detail }] }
 */
export function verifyClaims({ targetFile, currentContent, newContent }) {
  const violations = [];
  let checked = 0;
  try {
    const added = stripComments(addedText(currentContent, newContent));
    if (!added.trim()) return { ok: true, checked: 0, violations: [] };
    const targetDir = path.dirname(path.resolve(targetFile));
    const isServerEsm = /[\\/]ava-server[\\/]/.test(path.resolve(targetFile)) && /\.(mjs|js)$/i.test(targetFile);

    // 1) invented worker commands
    const cmds = workerCommands();
    if (cmds) {
      for (const m of added.matchAll(/pythonWorker\s*\.\s*sendCommand\(\s*['"`]([^'"`]+)['"`]/g)) {
        checked++;
        if (!cmds.has(m[1])) {
          violations.push({
            kind: 'worker-command',
            detail: `pythonWorker.sendCommand('${m[1]}') — not a worker command; the dispatch is a fixed set (${[...cmds].slice(0, 8).join(', ')}…). For tool actions use executeTool(tool, { action }).`,
          });
        }
      }
    }

    // 2) CommonJS idioms inside ESM
    if (isServerEsm) {
      if (/\bmodule\.exports\b/.test(added)) {
        checked++;
        violations.push({ kind: 'esm', detail: 'module.exports used — undefined in an ES module (ReferenceError at runtime); use export / a local reference instead.' });
      }
      if (/(^|[^.\w])require\s*\(/.test(added)) {
        checked++;
        violations.push({ kind: 'esm', detail: 'require() used — not defined in an ES module; use import (or createRequire only with justification).' });
      }
    }

    // 3) members claimed on locally-imported services that never mention them
    const imports = localImports([String(currentContent || ''), String(newContent || '')], targetDir);
    const moduleSrcCache = new Map();
    for (const m of added.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const [, ident, member] = m;
      if (!imports.has(ident) || COMMON_MEMBERS.has(member)) continue;
      const modPath = imports.get(ident);
      if (!modPath) continue; // unresolvable import is reported by check 4 semantics below
      checked++;
      let src = moduleSrcCache.get(modPath);
      if (src === undefined) {
        try { src = fs.readFileSync(modPath, 'utf8'); } catch { src = null; }
        moduleSrcCache.set(modPath, src);
      }
      if (src && !new RegExp(`\\b${member}\\b`).test(src)) {
        violations.push({
          kind: 'member',
          detail: `${ident}.${member}() — '${member}' appears nowhere in ${path.basename(modPath)}; grep the module for the definition before calling it.`,
        });
      }
    }

    // 4) relative imports (in the ADDED text) that don't resolve
    for (const m of added.matchAll(/import\s+[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      checked++;
      const base = path.resolve(targetDir, m[1]);
      const okPath = [base, base + '.js', base + '.mjs', path.join(base, 'index.js')]
        .some(c => { try { return fs.existsSync(c) && fs.statSync(c).isFile(); } catch { return false; } });
      if (!okPath) {
        violations.push({ kind: 'import', detail: `import '${m[1]}' does not resolve from ${path.basename(targetDir)}/ — the file does not exist (this exact class crashed selfRestart.js).` });
      }
    }

    // de-duplicate identical findings
    const seen = new Set();
    const unique = violations.filter(v => { const k = v.kind + '|' + v.detail; if (seen.has(k)) return false; seen.add(k); return true; });
    return { ok: unique.length === 0, checked, violations: unique };
  } catch (e) {
    // infrastructure problem — fail OPEN, the sandbox's other gates still apply
    return { ok: true, checked, violations: [], error: e.message };
  }
}

export function describeViolations(v) {
  return (v && v.violations && v.violations.length)
    ? v.violations.map(x => `[${x.kind}] ${x.detail}`).join(' ')
    : '';
}

export default { verifyClaims, addedText, describeViolations };
