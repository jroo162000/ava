import tools from './src/services/tools.js';
import pythonWorker from './src/services/pythonWorker.js';
// Wait for the python worker to actually be ready before judging tool availability.
for (let i = 0; i < 30; i++) { try { if (pythonWorker.isReady && pythonWorker.isReady()) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }
await new Promise(r => setTimeout(r, 2000));
console.log('workerReady=' + (pythonWorker.isReady ? pythonWorker.isReady() : '?'));
for (const n of ['get_current_datetime', 'sys_ops']) {
  try { const r = await tools.executeTool(n, {}); console.log(n + ' => ' + JSON.stringify(r).slice(0, 200)); }
  catch (e) { console.log(n + ' THREW ' + e.message); }
}
process.exit(0);
