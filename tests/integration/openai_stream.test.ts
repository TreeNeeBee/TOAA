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
