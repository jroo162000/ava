const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const serverEntry = process.argv[2];
const delayMs = Math.max(1000, Number(process.argv[3] || 2500));

function log(line) {
  try {
    const serverRoot = path.resolve(path.dirname(serverEntry || ''), '..');
    const logPath = path.join(serverRoot, 'data', 'server-restarts.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {}
}

setTimeout(() => {
  try {
    if (!serverEntry || !fs.existsSync(serverEntry)) {
      log(`restart skipped: missing server entry ${serverEntry || ''}`);
      process.exit(1);
    }
    const serverRoot = path.resolve(path.dirname(serverEntry), '..');
    const child = spawn(process.execPath, [serverEntry], {
      cwd: serverRoot,
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
    log(`started server pid=${child.pid} entry=${serverEntry}`);
    process.exit(0);
  } catch (e) {
    log(`restart failed: ${e.message}`);
    process.exit(1);
  }
}, delayMs);
