import fs from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';

const root = path.resolve(process.cwd());

describe('Integration path resolution', () => {
  it('uses the canonical AVA integration directory instead of the old flat home path', () => {
    const configSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'config.js'), 'utf8');
    const workerSrc = fs.readFileSync(path.join(root, 'src', 'services', 'pythonWorker.js'), 'utf8');
    const toolsSrc = fs.readFileSync(path.join(root, 'src', 'services', 'tools.js'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(root, 'src', 'routes', 'api.js'), 'utf8');

    expect(configSrc).toContain('function resolveIntegrationDir()');
    expect(configSrc).toContain('AVA_INTEGRATION_DIR');
    expect(workerSrc).toContain('config.AVA_INTEGRATION_DIR');
    expect(workerSrc).toContain('list_tools deferred; worker not ready');
    expect(toolsSrc).toContain('cacheWorkerReady');
    expect(toolsSrc).toContain('cacheHasFreshPythonState');
    expect(apiSrc).toContain('config.AVA_INTEGRATION_DIR');
    expect(workerSrc).not.toContain("path.join(home, 'ava-integration', 'ava_python_worker.py')");
  });
});
