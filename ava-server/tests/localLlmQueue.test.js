import http from 'node:http';
import {
  LocalLlmQueue,
  normalizeLocalResponseFormat,
  requestLocalSse,
  resolveLocalContextTokens,
  useLocalStreamingTransport,
} from '../src/services/localLlmQueue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('LocalLlmQueue', () => {
  it('runs local generations one at a time', async () => {
    const queue = new LocalLlmQueue();
    const gate = deferred();
    const started = [];

    const first = queue.run(async () => {
      started.push('first');
      await gate.promise;
      return 'one';
    }, { priority: 'background', timeoutMs: 1000 });
    const second = queue.run(async () => {
      started.push('second');
      return 'two';
    }, { priority: 'background', timeoutMs: 1000 });

    await nextTurn();
    expect(started).toEqual(['first']);
    gate.resolve();

    await expect(first).resolves.toBe('one');
    await expect(second).resolves.toBe('two');
    expect(started).toEqual(['first', 'second']);
  });

  it('aborts background work when an interactive request arrives', async () => {
    const queue = new LocalLlmQueue();
    let backgroundSignal;

    const background = queue.run(signal => new Promise((resolve, reject) => {
      backgroundSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { priority: 'background', timeoutMs: 1000 });
    await nextTurn();

    const interactive = queue.run(async () => 'heard you', {
      priority: 'interactive',
      timeoutMs: 1000,
    });

    await expect(background).rejects.toMatchObject({
      message: 'local llm preempted by interactive request',
      code: 'AVA_LOCAL_PREEMPTED',
    });
    expect(backgroundSignal.aborted).toBe(true);
    await expect(interactive).resolves.toBe('heard you');
  });

  it('aborts the underlying task on timeout and continues the queue', async () => {
    const queue = new LocalLlmQueue();
    let timedOutSignal;
    const timedOut = queue.run(signal => new Promise((resolve, reject) => {
      timedOutSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { priority: 'background', timeoutMs: 20 });
    const next = queue.run(async () => 'next', { priority: 'background', timeoutMs: 1000 });

    await expect(timedOut).rejects.toMatchObject({
      message: 'local llm timeout',
      code: 'AVA_LOCAL_TIMEOUT',
    });
    expect(timedOutSignal.aborted).toBe(true);
    await expect(next).resolves.toBe('next');
  });
});

describe('local fallback context budgets', () => {
  it('bounds unlabeled interactive and background work by default', () => {
    expect(resolveLocalContextTokens({}, 'interactive', {})).toBe(8192);
    expect(resolveLocalContextTokens({}, 'background', {})).toBe(8192);
  });

  it('honors configured and per-call context budgets', () => {
    const env = {
      AVA_LOCAL_INTERACTIVE_CONTEXT_TOKENS: '7168',
      AVA_LOCAL_BACKGROUND_CONTEXT_TOKENS: '9216',
    };
    expect(resolveLocalContextTokens({}, 'interactive', env)).toBe(7168);
    expect(resolveLocalContextTokens({}, 'background', env)).toBe(9216);
    expect(resolveLocalContextTokens({ localContextTokens: 10240 }, 'background', env)).toBe(10240);
  });
});

describe('LM Studio response format compatibility', () => {
  it('converts OpenAI json_object mode to LM Studio json_schema mode', () => {
    expect(normalizeLocalResponseFormat({ type: 'json_object' })).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'ava_json_response',
        strict: false,
        schema: { type: 'object', additionalProperties: true },
      },
    });
  });

  it('preserves supported response formats and an absent format', () => {
    const schema = { type: 'json_schema', json_schema: { name: 'specific', schema: { type: 'object' } } };
    expect(normalizeLocalResponseFormat(schema)).toBe(schema);
    expect(normalizeLocalResponseFormat(undefined)).toBeUndefined();
  });
});

describe('local completion transport', () => {
  it('streams tool-free completions so long prompt processing receives headers immediately', () => {
    expect(useLocalStreamingTransport({})).toBe(true);
    expect(useLocalStreamingTransport({ tools: [] })).toBe(true);
  });

  it('keeps native tool calls on the non-streaming parser', () => {
    expect(useLocalStreamingTransport({ tools: [{ type: 'function' }] })).toBe(false);
  });
});

describe('native local SSE request', () => {
  let server;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    server = null;
  });

  async function listen(handler) {
    server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  }

  it('receives headers before a delayed SSE body without a fetch body timer', async () => {
    let bodySent = false;
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      setTimeout(() => {
        bodySent = true;
        response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      }, 30);
    });

    const response = await requestLocalSse(url, {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.ok).toBe(true);
    expect(bodySent).toBe(false);

    let raw = '';
    for await (const chunk of response.body) raw += chunk.toString('utf8');
    expect(raw).toContain('"content":"ok"');
    expect(raw).toContain('[DONE]');
  });

  it('destroys an in-flight native request when the queue signal aborts', async () => {
    const url = await listen(() => {});
    const controller = new AbortController();
    const pending = requestLocalSse(url, { body: '{}', signal: controller.signal });
    await nextTurn();
    controller.abort(new Error('stop local request'));
    await expect(pending).rejects.toThrow('stop local request');
  });
});
