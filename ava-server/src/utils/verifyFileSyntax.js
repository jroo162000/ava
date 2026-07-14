// verifyFileSyntax.js — confirm an applied/edited source file actually PARSES (JS via `node --check`,
// Python via py_compile, JSON via parse). Self-mods must never be reported "applied/done" — or
// restarted into — when they left broken, unloadable code on disk. Returns {ok} or {ok:false,error}.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import avaPaths from './paths.js';

export function verifyFileSyntax(file) {
  return new Promise((resolve) => {
    try {
      if (!file || !fs.existsSync(file)) return resolve({ ok: true, skipped: true });
      const ext = path.extname(String(file)).toLowerCase();
      // Pull the meaningful error line (the SyntaxError), not node's "Node.js vXX" version footer.
      const pickErr = (s) => {
        const lines = String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
        return (lines.find(l => /error|invalid|unexpected/i.test(l)) || lines[lines.length - 1] || 'syntax check failed').slice(0, 220);
      };
      if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
        execFile(process.execPath, ['--check', file], { timeout: 10000, windowsHide: true }, (err, _so, se) => {
          resolve(err ? { ok: false, error: pickErr(se || err.message) } : { ok: true });
        });
      } else if (ext === '.py') {
        const venvPy = path.join(avaPaths.integrationDir(), '.venv', 'Scripts', 'python.exe');
        const py = fs.existsSync(venvPy) ? venvPy : (process.env.AVA_PYTHON || 'python');
        execFile(py, ['-m', 'py_compile', file], { timeout: 12000, windowsHide: true }, (err, _so, se) => {
          resolve(err ? { ok: false, error: pickErr(se || err.message) } : { ok: true });
        });
      } else if (ext === '.json') {
        try { JSON.parse(fs.readFileSync(file, 'utf8')); resolve({ ok: true }); }
        catch (e) { resolve({ ok: false, error: String(e.message).slice(0, 220) }); }
      } else {
        resolve({ ok: true, skipped: true });
      }
    } catch (e) { resolve({ ok: true, skipped: true }); }
  });
}

export default { verifyFileSyntax };
