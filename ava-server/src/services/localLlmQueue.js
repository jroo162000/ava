import http from 'node:http';
import https from 'node:https';

const PRIORITY_RANK = Object.freeze({
  interactive: 0,
  background: 1,
});

function queueError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePriority(priority) {
  return priority === 'background' ? 'background' : 'interactive';
}

export function resolveLocalContextTokens(options = {}, priority = 'interactive', env = process.env) {
  const explicit = parseInt(options.localContextTokens, 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const setting = normalizePriority(priority) === 'background'
    ? env.AVA_LOCAL_BACKGROUND_CONTEXT_TOKENS
    : env.AVA_LOCAL_INTERACTIVE_CONTEXT_TOKENS;
  const configured = parseInt(setting || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 8192;
}

export function normalizeLocalResponseFormat(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined;
  if (responseFormat.type !== 'json_object') return responseFormat;
  return {
    type: 'json_schema',
    json_schema: {
      name: 'ava_json_response',
      strict: false,
      schema: { type: 'object', additionalProperties: true },
    },
  };
}

export function useLocalStreamingTransport(options = {}) {
  return !(Array.isArray(options.tools) && options.tools.length > 0);
}

export function requestLocalSse(url, { headers = {}, body = '', signal } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch (error) {
    return Promise.reject(error);
  }

  const transport = target.protocol === 'https:' ? https : (target.protocol === 'http:' ? http : null);
  if (!transport) return Promise.reject(new Error(`unsupported local LLM protocol: ${target.protocol}`));

  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const requestHeaders = { ...headers };
  if (!Object.keys(requestHeaders).some(name => name.toLowerCase() === 'content-length')) {
    requestHeaders['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStream = null;
    const abortError = () => (
      signal?.reason instanceof Error
        ? signal.reason
        : queueError('local llm request aborted', 'AVA_LOCAL_ABORTED')
    );
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      const error = abortError();
      if (responseStream && !responseStream.destroyed) responseStream.destroy(error);
      request.destroy(error);
    };
    const request = transport.request(target, {
      method: 'POST',
      headers: requestHeaders,
    }, response => {
      settled = true;
      responseStream = response;
      response.once('close', cleanup);
      const status = response.statusCode || 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: response,
        async text() {
          let output = '';
          for await (const chunk of response) output += chunk.toString('utf8');
          return output;
        },
      });
    });

    request.setTimeout(0);
    request.once('error', error => {
      cleanup();
      if (!settled) reject(error);
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end(payload);
  });
}

export class LocalLlmQueue {
  constructor() {
    this.pending = [];
    this.active = null;
    this.sequence = 0;
  }

  run(task, { priority = 'interactive', timeoutMs = 90000, label = 'local completion' } = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('local queue task must be a function'));

    const normalizedPriority = normalizePriority(priority);
    const normalizedTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.floor(Number(timeoutMs))
      : 90000;

    return new Promise((resolve, reject) => {
      const item = {
        task,
        priority: normalizedPriority,
        timeoutMs: normalizedTimeout,
        label,
        sequence: this.sequence++,
        resolve,
        reject,
      };
      this.pending.push(item);
      this.pending.sort((a, b) => (
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        || a.sequence - b.sequence
      ));

      if (normalizedPriority === 'interactive' && this.active?.priority === 'background') {
        this.active.controller.abort(queueError(
          'local llm preempted by interactive request',
          'AVA_LOCAL_PREEMPTED',
        ));
      }
      this._drain();
    });
  }

  status() {
    return {
      active: this.active ? {
        priority: this.active.priority,
        label: this.active.label,
        startedAt: this.active.startedAt,
      } : null,
      pending: this.pending.map(item => ({ priority: item.priority, label: item.label })),
    };
  }

  _drain() {
    if (this.active || !this.pending.length) return;

    const item = this.pending.shift();
    const controller = new AbortController();
    this.active = {
      ...item,
      controller,
      startedAt: Date.now(),
    };

    const timer = setTimeout(() => {
      controller.abort(queueError('local llm timeout', 'AVA_LOCAL_TIMEOUT'));
    }, item.timeoutMs);
    timer.unref?.();

    Promise.resolve()
      .then(() => item.task(controller.signal))
      .then(item.resolve, error => {
        const reason = controller.signal.aborted ? controller.signal.reason : null;
        item.reject(reason instanceof Error ? reason : error);
      })
      .finally(() => {
        clearTimeout(timer);
        this.active = null;
        this._drain();
      });
  }
}

export default LocalLlmQueue;
