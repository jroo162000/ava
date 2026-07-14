import tools from './src/services/tools.js';
const names = ['get_current_datetime', 'sys_ops', 'system_info', 'sys_info', 'get_system_info', 'datetime', 'time_ops'];
for (const n of names) {
  try {
    const r = await Promise.race([
      tools.executeTool(n, {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))
    ]);
    console.log(n + ' => ' + JSON.stringify(r).slice(0, 240));
  } catch (e) { console.log(n + ' THREW ' + e.message); }
}
process.exit(0);
