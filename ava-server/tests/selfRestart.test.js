import path from 'path';
import { activateAppliedChanges, activationPlan } from '../src/services/selfRestart.js';
import avaPaths from '../src/utils/paths.js';

const target = relative => path.join(avaPaths.repoRoot(), relative);

describe('self-mod activation planning', () => {
  test('uses client hot module replacement for frontend source', () => {
    expect(activationPlan(target('ava-client/src/MinimalAVA.jsx')).mode).toBe('frontend_hmr');
  });

  test('hot-applies frontend changes without scheduling a server restart', async () => {
    const activation = await activateAppliedChanges({ files: [target('ava-client/src/MinimalAVA.jsx')] });

    expect(activation).toMatchObject({ mode: 'hot', hotApplied: true, scheduled: false });
  });

  test('recycles only the Python worker for worker-owned modules', () => {
    expect(activationPlan(target('ava-integration/ava_self_awareness.py')).mode).toBe('python_worker_restart');
  });

  test('keeps a rolling server refresh for loaded Node modules', () => {
    expect(activationPlan(target('ava-server/src/services/agentLoop.js')).mode).toBe('server_restart');
  });

  test('does not pretend the voice runner can hot-load startup configuration', () => {
    expect(activationPlan(target('ava-integration/ava_voice_config.json')).mode).toBe('voice_restart_required');
  });
});
