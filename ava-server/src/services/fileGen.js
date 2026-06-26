// Shared file generator — handles ALL file types via the file path.
//  - text formats (txt/md/csv/json/html/xml/yaml/rtf/...) : written directly in Node (+append)
//  - pdf  : pure-Node minimal PDF writer (no dependencies)
//  - docx/xlsx/pptx : delegated to ava_filegen.py (python-docx / openpyxl / python-pptx)
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import logger from '../utils/logger.js';

const TEXT_FORMATS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm',
  'xml', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'js', 'ts', 'py',
  'sh', 'bat', 'css', 'rtf',
]);
const RICH_FORMATS = new Set(['docx', 'xlsx', 'pptx']);

function pythonExe() {
  return process.env.AVA_PYTHON || 'python';
}

function integrationDir() {
  const home = os.homedir();
  return process.env.AVA_INTEGRATION_DIR || path.join(home, 'ava', 'ava-integration');
}

// In sandbox/training mode, the "home" is the fake device folder so default-dir writes
// land in the sandbox instead of the user's real Downloads.
function homeBase() {
  if (process.env.AVA_SANDBOX === '1') return path.join(integrationDir(), 'sandbox', 'device');
  return os.homedir();
}

function resolveTarget(args) {
  const home = homeBase();
  let target = args.file_path || args.path || args.filepath || '';
  if (!target) {
    const fmt = String(args.format || 'txt').toLowerCase();
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const fname = args.filename || `ava_${ts}.${fmt}`;
    const baseDir = (args.dir === 'documents') ? path.join(home, 'Documents') : path.join(home, 'Downloads');
    target = path.isAbsolute(fname) ? fname : path.join(baseDir, fname);
  }
  if (!path.isAbsolute(target)) target = path.join(home, 'Downloads', target);
  return path.resolve(target);
}

function writeSimplePdf(full, content) {
  const lines = String(content || '').split(/\r?\n/);
  const header = Buffer.from('%PDF-1.4\n', 'utf8');
  const objs = [];
  const addObj = (s) => objs.push(Buffer.from(s, 'utf8'));
  addObj('1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n');
  addObj('2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n');
  addObj('3 0 obj\n<</Type /Page /Parent 2 0 R /Resources <</Font <</F1 4 0 R>>>> /MediaBox [0 0 612 792] /Contents 5 0 R>>\nendobj\n');
  addObj('4 0 obj\n<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>\nendobj\n');
  let cs = 'BT\n/F1 12 Tf\n14 TL\n72 720 Td\n';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    if (i > 0) cs += '0 -14 Td\n';
    cs += `(${line}) Tj\n`;
  }
  cs += 'ET\n';
  const csBuf = Buffer.from(cs, 'utf8');
  const stream = Buffer.concat([
    Buffer.from('5 0 obj\n<</Length ' + csBuf.length + '>>\nstream\n', 'utf8'),
    csBuf,
    Buffer.from('\nendstream\nendobj\n', 'utf8'),
  ]);
  const body = Buffer.concat([...objs, stream]);
  const offsets = [];
  let pos = header.length;
  for (const b of [...objs, stream]) { offsets.push(pos); pos += b.length; }
  const xrefStart = pos;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const off of offsets) { xref += (String(off).padStart(10, '0') + ' 00000 n \n'); }
  const trailer = 'trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n' + xrefStart + '\n%%EOF';
  const pdf = Buffer.concat([header, body, Buffer.from(xref, 'utf8'), Buffer.from(trailer, 'utf8')]);
  fs.writeFileSync(full, pdf);
  return fs.existsSync(full);
}

export function generateFile(args, { dryRun = false } = {}) {
  const home = homeBase();
  const content = String(args.content ?? args.text ?? '');
  let target;
  try { target = resolveTarget(args); } catch (e) { return { ok: false, result: { status: 'error', message: e.message } }; }
  if (!target.startsWith(path.resolve(home))) {
    return { ok: false, result: { status: 'error', message: `path not allowed (must be under ${home})` } };
  }
  let ext = path.extname(target).replace('.', '').toLowerCase();
  if (!ext) { ext = String(args.format || 'txt').toLowerCase(); target = target + '.' + ext; }
  const append = args.mode === 'append' || args.append === true || args.append === 'true';

  if (dryRun) return { ok: true, result: { status: 'dry-run', file_path: target, message: `Would ${append ? 'append to' : 'create'} ${target}` } };

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (RICH_FORMATS.has(ext)) {
      const helper = path.join(integrationDir(), 'ava_filegen.py');
      if (!fs.existsSync(helper)) return { ok: false, result: { status: 'error', file_path: target, message: 'document generator helper missing' } };
      try {
        const out = execFileSync(pythonExe(), [helper, target, ext], { input: content, encoding: 'utf8', timeout: 45000 });
        let parsed = {};
        try { parsed = JSON.parse(String(out).trim().split('\n').pop()); } catch { /* ignore */ }
        const ok = !!parsed.ok && fs.existsSync(target);
        return { ok, result: { status: ok ? 'ok' : 'error', file_path: target, bytes: parsed.size || 0, message: ok ? `Created ${target}` : (parsed.error || `${ext} generation failed`) } };
      } catch (e) {
        return { ok: false, result: { status: 'error', file_path: target, message: `${ext} generation failed: ${String(e.message || e).slice(0, 160)}` } };
      }
    }

    if (ext === 'pdf') {
      const ok = writeSimplePdf(target, content);
      return { ok, result: { status: ok ? 'ok' : 'error', file_path: target, message: ok ? `Created ${target}` : 'pdf write failed' } };
    }

    // text-ish (known text formats, or any other extension): write/append directly
    if (append && fs.existsSync(target)) {
      const prev = fs.readFileSync(target, 'utf8');
      const sep = (prev.length && !prev.endsWith('\n')) ? '\n' : '';
      fs.appendFileSync(target, sep + content, 'utf8');
    } else {
      fs.writeFileSync(target, content, 'utf8');
    }
    const exists = fs.existsSync(target);
    return { ok: exists, result: { status: exists ? 'ok' : 'error', file_path: target, mode: append ? 'append' : 'write', bytes: Buffer.byteLength(content, 'utf8'), message: exists ? `${append ? 'Appended to' : 'Created'} ${target}` : 'write failed' } };
  } catch (e) {
    return { ok: false, result: { status: 'error', file_path: target, message: e.message } };
  }
}

export default { generateFile };
