import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import memoryService from '../src/services/memory.js';
import { buildConsolidationPlan, saveConsolidationPlan } from '../src/services/skillStore.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(serverDir, 'data');
const reflectionPath = path.join(dataDir, 'self-reflections.jsonl');
const apply = process.argv.includes('--apply');
const thresholdArg = process.argv.find(arg => arg.startsWith('--skill-threshold='));
const threshold = thresholdArg ? Number(thresholdArg.split('=')[1]) : undefined;
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

function reflectionPlan() {
  if (!fs.existsSync(reflectionPath)) return { total: 0, misplaced: 0, retained: 0 };
  const lines = fs.readFileSync(reflectionPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const records = lines.map(line => ({ line, value: JSON.parse(line) }));
  const misplaced = records.filter(record => /^moltbook-/i.test(String(record.value?.source || '')));
  const retained = records.filter(record => !/^moltbook-/i.test(String(record.value?.source || '')));
  return { total: records.length, misplaced: misplaced.length, retained: retained.length, misplacedRecords: misplaced, retainedRecords: retained };
}

function applyReflectionPlan(plan) {
  if (!plan.misplaced) return null;
  const archiveDir = path.join(dataDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `moltbook-social-output-${timestamp}.jsonl`);

  if (plan.misplaced === plan.total) {
    fs.renameSync(reflectionPath, archivePath);
    fs.writeFileSync(reflectionPath, '', 'utf8');
    return archivePath;
  }

  fs.writeFileSync(archivePath, `${plan.misplacedRecords.map(record => record.line).join('\n')}\n`, 'utf8');
  const temporary = `${reflectionPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, plan.retainedRecords.length
    ? `${plan.retainedRecords.map(record => record.line).join('\n')}\n`
    : '', 'utf8');
  fs.renameSync(temporary, reflectionPath);
  return archivePath;
}

await memoryService.ready;
const memory = await memoryService.compactDuplicates({ dryRun: !apply });
const reflections = reflectionPlan();
const skills = buildConsolidationPlan({ threshold });

let reflectionArchive = null;
let skillManifest = null;
if (apply) {
  reflectionArchive = applyReflectionPlan(reflections);
  skillManifest = saveConsolidationPlan(skills);
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  memory,
  reflections: {
    total: reflections.total,
    misplaced: reflections.misplaced,
    retained: reflections.retained,
    archivePath: reflectionArchive,
  },
  skills: {
    total: skills.totalSkills,
    canonical: skills.canonicalSkills,
    aliases: skills.aliasCount,
    threshold: skills.threshold,
    groups: skills.groups,
    manifestPath: skillManifest,
  },
}, null, 2));
