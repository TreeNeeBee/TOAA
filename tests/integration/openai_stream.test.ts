import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIClient } from '../../src/llm/openai.js';

describe('OpenAI-compatible streaming', () => {
  it('streams SSE chunks and allows local endpoints without api_key', async () => {
    let sawStream = false;
    let sawAuthorization = false;
    const server = createServer((req, res) => {
      sawAuthorization = typeof req.headers.authorization === 'string';
      let body = '';
      req.on('data', (b) => (body += b.toString()));
      req.on('end', () => {
        const obj = JSON.parse(body) as { stream?: boolean };
        sawStream = obj.stream === true;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo ' } }] })}\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mlx' } }] })}\r\n\r\n`);
        res.write('data: [DONE]\r\n\r\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
      });
      const chunks: string[] = [];
      const out = await client.chat([{ role: 'user', content: 'hi' }], {
        onToken: (c) => chunks.push(c),
      });
      expect(out).toBe('hello mlx');
      expect(chunks).toEqual(['hel', 'lo ', 'mlx']);
      expect(sawStream).toBe(true);
      expect(sawAuthorization).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('rejects a provider protocol error embedded in streamed choice content', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const providerError = JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'tool_choice is not supported for this model',
        },
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: providerError } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        providerName: 'openrouter',
        apiKey: 'dummy',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'provider-model',
        requestTimeoutMs: 5000,
      });
      await expect(client.chat([{ role: 'user', content: 'json please' }], {
        responseFormat: 'json',
        onToken: () => {},
      })).rejects.toThrow(
        /invalid_request_error: tool_choice is not supported for this model/u,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps non-streaming OpenAI-compatible responses working', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (b) => (body += b.toString()));
      req.on('end', () => {
        const obj = JSON.parse(body) as { stream?: boolean };
        expect(obj.stream).toBe(false);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'plain response' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
      });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('plain response');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('supplies an Undici dispatcher so connect_timeout_ms controls connection establishment', async () => {
    const originalFetch = globalThis.fetch;
    let dispatcher: unknown;
    globalThis.fetch = vi.fn(async (_url, init) => {
      dispatcher = (init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const client = new OpenAIClient({
        apiKey: 'dummy',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        connectTimeoutMs: 45000,
      });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
      expect(dispatcher).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('wraps OpenAI-compatible HTTP failures with provider diagnostics and redacted details', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(
      '{"error":{"message":"missing auth Bearer very-secret-token"}}',
      { status: 401, statusText: 'Unauthorized' },
    ));
    try {
      const client = new OpenAIClient({
        providerName: 'openrouter_free',
        apiKey: '',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        requestTimeoutMs: 5000,
      });
      let message = '';
      try {
        await client.chat([{ role: 'user', content: 'hi' }]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/OpenAI-compatible provider request failed/u);
      expect(message).toContain('provider=openrouter_free');
      expect(message).toContain('model=openrouter/free');
      expect(message).toContain('base_url=https://openrouter.ai/api/v1');
      expect(message).toContain('status=401 Unauthorized');
      expect(message).toContain('OPENROUTER_API_KEY');
      expect(message).toContain('Bearer [REDACTED]');
      expect(message).not.toContain('very-secret-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps local no-auth OpenAI-compatible failure hints distinct from cloud API key failures', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED 127.0.0.1') });
    });
    try {
      const client = new OpenAIClient({
        providerName: 'local_openai',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'local-model',
        requestTimeoutMs: 5000,
      });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        /local\/no-auth servers|base_url|local server is running/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('can request json_schema response format for OpenAI-compatible providers', async () => {
    let responseFormat: unknown;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (b) => (body += b.toString()));
      req.on('end', () => {
        const obj = JSON.parse(body) as { response_format?: unknown };
        responseFormat = obj.response_format;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'json-schema-model',
        jsonResponseFormat: 'json_schema',
        requestTimeoutMs: 5000,
      });
      await expect(
        client.chat([{ role: 'user', content: 'json please' }], { responseFormat: 'json' }),
      ).resolves.toBe('{"ok":true}');
      expect(responseFormat).toMatchObject({
        type: 'json_schema',
        json_schema: {
          name: 'xcompiler_json_response',
          schema: { type: 'object', additionalProperties: true },
        },
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts a stalled stream via idle timeout (mlx-server hang scenario)', async () => {
    // Server sends one chunk then never sends another and never closes — simulates
    // an mlx-server that hangs mid-stream. Without an idle watchdog this would block
    // until the 10-min wall clock.
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
      open = res; // keep the socket open, never end
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 0, // disable wall clock; only idle should fire
        streamIdleTimeoutMs: 150,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/idle/);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(120);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('labels idle timeout before the first streamed token', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      open = res;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'slow-first-token-model',
        requestTimeoutMs: 0,
        streamFirstTokenTimeoutMs: 150,
        streamIdleTimeoutMs: 50,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/idle before first token/u);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('uses a shorter post-token idle timeout than the first-token timeout', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
      }, 100);
      open = res;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'slow-first-token-then-stalled-model',
        requestTimeoutMs: 0,
        streamFirstTokenTimeoutMs: 500,
        streamIdleTimeoutMs: 80,
      });
      const startedAt = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/stream idle for 80ms/u);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not stop a productive stream at the pre-token request timeout', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let index = 0;
      const timer = setInterval(() => {
        index++;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: String(index) } }] })}\n\n`);
        if (index === 5) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 50);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'slow-productive-model',
        requestTimeoutMs: 100,
        streamFirstTokenTimeoutMs: 500,
        streamIdleTimeoutMs: 100,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).resolves.toBe('12345');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not reset idle timeout on empty OpenAI-compatible stream chunks', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    let interval: NodeJS.Timeout | null = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            if (interval) clearInterval(interval);
            controller.error(signal.reason ?? new Error('aborted'));
          });
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`),
          );
          interval = setInterval(() => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`));
          }, 40);
        },
        cancel() {
          if (interval) clearInterval(interval);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'mlx-model',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 150,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/idle/);
    } finally {
      if (interval) clearInterval(interval);
      globalThis.fetch = originalFetch;
    }
  });

  it('stops on finish_reason even when provider never sends [DONE]', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      open = res; // keep socket open to simulate providers that omit [DONE]
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 5_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).resolves.toBe('hello world');
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('stops early when streamed JSON is already complete but provider keeps connection open', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"thoughts":"plan",' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"actions":[],' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"done":true}' } }] })}\n\n`);
      open = res; // no [DONE], no finish_reason
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 5_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], {
          onToken: () => {},
          streamStopWhen: (text) => {
            try {
              const parsed = JSON.parse(text) as { actions?: unknown; done?: unknown };
              return Array.isArray(parsed.actions) && typeof parsed.done === 'boolean';
            } catch {
              return false;
            }
          },
        }),
      ).resolves.toBe('{"thoughts":"plan","actions":[],"done":true}');
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not wait for reader.cancel() to resolve after detecting completion', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          ),
        );
      },
      cancel,
    });
    globalThis.fetch = vi.fn(async () => new Response(body));
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'mlx-model',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 5_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).resolves.toBe('hello');
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(cancel).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not abort valid long JSON output just because it exceeds maxOutputChars', async () => {
    const payload = Array.from({ length: 350 }, (_, i) => `item-${i}`).join(',');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"thoughts":"' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '","actions":[],"done":true}' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 1000,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { responseFormat: 'json', onToken: () => {} }),
      ).resolves.toContain('item-349');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts repeated streamed output as a token loop', async () => {
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(200) } }] })}\n\n`);
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 1000,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/token loop/);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts repeated OpenAI-compatible token loops before output limit', async () => {
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '0' } }] })}\n\n`);
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/token loop/);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts repeated OpenAI-compatible long text phrase loops', async () => {
    let stop = false;
    const repeated =
      'The classifier should produce one technology item, but the failing test reports two items, ' +
      'so the same implementation hypothesis is being repeated instead of producing a patch. ';
    let tickCount = 0;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        const variant = `Next I will inspect candidate ${tickCount++} and then apply the smallest code change. `;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: repeated + variant } }] })}\n\n`);
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'looping-model',
        requestTimeoutMs: 5_000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      const chunks: string[] = [];
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: (chunk) => chunks.push(chunk) }),
      ).rejects.toThrow(/repeated text loop/u);
      expect(chunks.join('').length).toBeLessThan(20_000);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts degenerate non-JSON prefixes in JSON streaming mode', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `2${'0'.repeat(180)}` } }] })}\n\n`);
      open = res;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5_000,
        streamIdleTimeoutMs: 5_000,
        maxOutputChars: 0,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], {
          responseFormat: 'json',
          onToken: () => {},
        }),
      ).rejects.toThrow(/degenerate non-JSON prefix/);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts long prose prefixes in JSON streaming mode before output cap', async () => {
    let stop = false;
    const phrase = "I'll proceed. I'll generate. I'll output. ";
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: phrase } }] })}\n\n`);
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5_000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], {
          responseFormat: 'json',
          onToken: () => {},
        }),
      ).rejects.toThrow(/degenerate non-JSON prefix/);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not treat ordinary indentation as an OpenAI-compatible token loop', async () => {
    const prefix = Array.from({ length: 120 }, (_, i) => `module ${i}: architecture text\n`).join('');
    const content = `${prefix}                `;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).resolves.toBe(content);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/**
 * A reasoning model streams its thinking on `delta.reasoning` and its answer on `delta.content`.
 *
 * Counting only `content` made every reasoning chunk invisible: `streamedContentChars` stayed 0
 * while hundreds of chunks arrived, the first-token watchdog fired on a fully active stream, and
 * the error told the operator to raise a timeout that could never be reached. Two live runs of the
 * dbc2excel project died this way — 300s per streaming attempt, 900s per non-stream retry.
 */
describe('reasoning-model streams', () => {
  const reasoningServer = (opts: { reasoningChunks: number; then?: string }) => createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const tick = setInterval(() => {
      if (sent < opts.reasoningChunks) {
        sent += 1;
        // Exactly what OpenRouter sends: empty content beside the reasoning text.
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning: 'thinking ' } }] })}\n\n`);
        return;
      }
      clearInterval(tick);
      if (opts.then) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: opts.then } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    }, 20);
  });

  const clientFor = async (server: ReturnType<typeof createServer>, firstTokenTimeoutMs: number) => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return new OpenAIClient({
      apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'reasoner',
      requestTimeoutMs: 10_000,
      streamFirstTokenTimeoutMs: firstTokenTimeoutMs,
      streamIdleTimeoutMs: 10_000,
    });
  };

  it('stays alive while only reasoning arrives, then returns the content', async () => {
    // Ten chunks at 20ms apart outlast a 60ms first-token budget: only a watchdog that reasoning
    // resets can survive to see the answer.
    const server = reasoningServer({ reasoningChunks: 10, then: '{"ok":true}' });
    const client = await clientFor(server, 60);
    try {
      const tokens: string[] = [];
      const out = await client.chat([{ role: 'user', content: 'hi' }], { onToken: (c) => tokens.push(c) });
      expect(out).toBe('{"ok":true}');
      // Thinking is not output: it must not reach the caller or the parsed result.
      expect(tokens).toEqual(['{"ok":true}']);
      expect(out).not.toContain('thinking');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('names reasoning-without-content as its own fault, not as an idle stream', async () => {
    // Never produces content, so the run must still end — and say something the operator can act on.
    const server = reasoningServer({ reasoningChunks: 10_000 });
    const client = await clientFor(server, 200);
    try {
      // Streaming, because that is the path a reasoning model stalls on. The message must name the
      // reasoning, not the timer: raising the timeout is the one action that cannot help here.
      await expect(client.chat([{ role: 'user', content: 'hi' }], { onToken: () => undefined }))
        .rejects.toThrow(/sent \d+ reasoning chars but no content/u);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20_000);
});

/**
 * Two faults produce one message: a dead network and a model still thinking both surface as a
 * timeout, and they need opposite responses. Two live dbc2excel runs died 15 minutes apart with
 * `request timed out after 900000ms`, and nothing in the failure said which one it was.
 *
 * The diagnosis never ends the request — the timeouts own that. It exists so the failure can name
 * what an operator should do next.
 */
describe('stall diagnosis', () => {
  it('asks the caller to explain total silence, and does not end the request', async () => {
    const stalls: Array<{ silentForMs: number; provider?: string }> = [];
    let release: (() => void) | undefined;
    const server = createServer((_req, res) => {
      release = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'late but fine' } }] }));
      };
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'slow',
        requestTimeoutMs: 10_000,
        stallDiagnosisAfterMs: 80,
      });
      const out = await client.chat([{ role: 'user', content: 'hi' }], {
        onStall: async (info) => {
          stalls.push(info);
          // Answering late must not matter: the diagnosis is not something the request waits on.
          release?.();
          return 'endpoint reachable from a new connection';
        },
      });
      // The request completed. A diagnosis is not a failure.
      expect(out).toBe('late but fine');
      expect(stalls).toHaveLength(1);
      expect(stalls[0]!.silentForMs).toBe(80);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20_000);

  it('carries the diagnosis into the failure, so the reason and the evidence arrive together', async () => {
    const server = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'silent',
        requestTimeoutMs: 400,
        stallDiagnosisAfterMs: 80,
      });
      await expect(client.chat([{ role: 'user', content: 'hi' }], {
        onStall: async () => 'every check passed; the endpoint answered a new connection',
      })).rejects.toThrow(/answered a new connection/u);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20_000);

  // Bytes, not tokens: a stream that is sending reasoning or SSE comments is not silent, so the
  // diagnosis must not fire on it. Firing there would call doctor on a perfectly healthy stream.
  it('does not fire while the peer is sending anything at all', async () => {
    let stalled = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const tick = setInterval(() => {
        n += 1;
        if (n > 12) {
          clearInterval(tick);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(': keepalive\n\n');
      }, 20);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'chatty',
        requestTimeoutMs: 10_000, streamFirstTokenTimeoutMs: 5_000, streamIdleTimeoutMs: 5_000,
        stallDiagnosisAfterMs: 100,
      });
      const out = await client.chat([{ role: 'user', content: 'hi' }], {
        onToken: () => undefined,
        onStall: async () => { stalled = true; return 'should not happen'; },
      });
      expect(out).toBe('done');
      expect(stalled).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20_000);

  it('discards a late diagnosis after bytes arrive and diagnoses only once per request', async () => {
    let response: import('node:http').ServerResponse | undefined;
    let diagnoses = 0;
    const server = createServer((_req, res) => {
      response = res;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'late-diagnosis',
        requestTimeoutMs: 2_000, streamFirstTokenTimeoutMs: 350, streamIdleTimeoutMs: 350,
        stallDiagnosisAfterMs: 60,
      });
      let failure: Error | undefined;
      try {
        await client.chat([{ role: 'user', content: 'hi' }], {
          onToken: () => undefined,
          onStall: async () => {
            diagnoses += 1;
            response?.writeHead(200, { 'content-type': 'text/event-stream' });
            response?.write(': provider is alive\n\n');
            await new Promise((resolve) => setTimeout(resolve, 100));
            return 'stale diagnosis that completed after provider bytes';
          },
        });
      } catch (error) {
        failure = error as Error;
      }
      expect(failure).toBeDefined();
      expect(failure?.message).not.toContain('stale diagnosis');
      expect(diagnoses).toBe(1);
    } finally {
      response?.end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20_000);
});

/**
 * What a stream delivered, carried as a value rather than as a sentence.
 *
 * The router decides whether a non-stream retry is worth one attempt, and it used to recover that
 * from English: `stream idle before first token` had to be excluded before `stream idle` was
 * accepted, so the entire policy rested on one sentence being a prefix of the other. Both sentences
 * were rewritten this week — for reasoning models and for the headers timeout — and nothing would
 * have failed.
 */
describe('stream progress travels structurally', () => {
  const failureOf = async (server: ReturnType<typeof createServer>, cfg: Record<string, unknown> = {}) => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const client = new OpenAIClient({
      apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'probe',
      requestTimeoutMs: 900, streamFirstTokenTimeoutMs: 250, streamIdleTimeoutMs: 250,
      streamHeadersTimeoutMs: 0, ...cfg,
    });
    try {
      await client.chat([{ role: 'user', content: 'hi' }], { onToken: () => undefined });
      return undefined;
    } catch (err) {
      return err as { failure?: { streamProgress?: string } };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  };

  it('reports no-bytes when the peer sent nothing', async () => {
    const err = await failureOf(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
    }));
    expect(err?.failure?.streamProgress).toBe('no-bytes');
  });

  it('reports reasoning-only when the peer was thinking and never answered', async () => {
    const err = await failureOf(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const tick = setInterval(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning: 'think ' } }] })}\n\n`);
      }, 20);
      res.on('close', () => clearInterval(tick));
    }));
    expect(err?.failure?.streamProgress).toBe('reasoning-only');
  });

  it('reports content-started when the answer had begun', async () => {
    const err = await failureOf(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
      // then goes quiet, so the idle watchdog ends it
    }));
    expect(err?.failure?.streamProgress).toBe('content-started');
  });
});
