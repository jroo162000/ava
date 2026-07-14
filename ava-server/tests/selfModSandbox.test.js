import { isSafeLiveOverlayPath } from '../src/services/selfModSandbox.js';

describe('self-mod sandbox live source mirror', () => {
  test('includes untracked source and test dependencies used by the live server', () => {
    expect(isSafeLiveOverlayPath('ava-server/src/services/capabilityRegistry.js')).toBe(true);
    expect(isSafeLiveOverlayPath('ava-server/src/services/localLlmQueue.js')).toBe(true);
    expect(isSafeLiveOverlayPath('ava-server/tests/eventLedger.test.js')).toBe(true);
  });

  test('excludes secrets, runtime state, dependencies, generated output, and traversal', () => {
    const excluded = [
      'ava-integration/.env',
      'ava-server/data/workflows.json',
      'ava-server/logs/runtime.log',
      'ava-server/node_modules/pkg/index.js',
      'ava-server/backups/old.js',
      'ava-server/coverage/report.js',
      'ava-integration/memory/skills/private.py',
      '../outside.js',
    ];
    for (const file of excluded) expect(isSafeLiveOverlayPath(file)).toBe(false);
  });
});
