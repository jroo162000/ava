// gen-selfmod-baseline.mjs — record the KNOWN-failing tests for the self-mod sandbox gate
// (services/selfModSandbox.js). The gate only blocks NEW failures relative to this baseline,
// so the documented pre-existing red tests never block an unrelated change.
//
// Rerun after intentionally changing test expectations:
//   cd ava-server && node scripts/gen-selfmod-baseline.mjs
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

const serverDir = process.cwd();
const tmpOut = path.join(serverDir, 'selfmod-jest-baseline-run.json');

await new Promise((resolve) => {
  execFile(process.execPath,
    ['--experimental-vm-modules', path.join('node_modules', 'jest', 'bin', 'jest.js'),
      '--json', `--outputFile=${tmpOut}`, '--silent'],
    { cwd: serverDir, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 300000 },
    () => resolve()); // non-zero exit = failing tests; the JSON file is what matters
});

const j = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
const failed = [];
const suites = {};   // #19: suite basename -> tests that ran, for the suite-load gate
for (const tr of (j.testResults || [])) {
  const suite = path.basename(tr.name || tr.testFilePath || 'unknown');
  const asserts = tr.assertionResults || [];
  suites[suite] = asserts.length;
  for (const ar of asserts) {
    if (ar.status === 'failed') failed.push(ar.fullName || ar.title || 'unknown test');
  }
}
fs.mkdirSync(path.join(serverDir, 'data'), { recursive: true });
fs.writeFileSync(path.join(serverDir, 'data', 'selfmod-test-baseline.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'known pre-existing failures; the selfmod sandbox gate only blocks NEW failures and suite-load regressions',
  totalTests: j.numTotalTests | 0,
  failed,
  suites,
}, null, 2));
try { fs.unlinkSync(tmpOut); } catch { /* best effort */ }
console.log(`selfmod test baseline recorded: ${failed.length} known failures of ${j.numTotalTests} tests across ${Object.keys(suites).length} suites`);
