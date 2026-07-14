import {
  answerFromSuccessfulTool,
  fallbackToolAnswer,
  toolResultEvidence,
} from '../src/services/toolResultAnswer.js';

describe('tool result answers', () => {
  test('turns structured read results into evidence for synthesis', () => {
    const result = { status: 'ok', results: [{ title: 'Weather', snippet: '72 F and clear', url: 'https://example.test' }] };

    expect(toolResultEvidence(result)).toContain('72 F and clear');
  });

  test('uses synthesized output instead of collapsing a structured success to Done', async () => {
    const answer = await answerFromSuccessfulTool({
      tool: 'self_diagnostics',
      result: { status: 'ok', components: { voice: 'ready' } },
      synthesize: async () => 'My voice component is ready.',
    });

    expect(answer).toBe('My voice component is ready.');
    expect(answer).not.toBe('Done.');
  });

  test('states when a tool returned no details', () => {
    expect(fallbackToolAnswer('read_event_log', { status: 'ok', result: null }))
      .toBe('I completed read_event_log, but it did not return any details to report.');
  });

  test('redacts credentials and binary payloads before synthesis', () => {
    const evidence = toolResultEvidence({ status: 'ok', api_token: 'private', image_base64: 'large', value: 42 });

    expect(evidence).not.toContain('private');
    expect(evidence).not.toContain('large');
    expect(evidence).toContain('42');
  });
});
