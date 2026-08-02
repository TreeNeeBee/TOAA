import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaClient } from '../src/llm/ollama.js';

describe('OllamaClient streaming', () => {
  it('forwards the configured thinking flag to Ollama', async () => {
    let requestBody: { think?: boolean } | undefined;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        requestBody = JSON.parse(body) as { think?: boolean };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        think: false,
      });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
      expect(requestBody?.think).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aggregates NDJSON chunks and invokes onToken for each piece', async () => {
    // Mock ollama server that streams NDJSON when stream=true
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (b) => (body += b.toString()));
      req.on('end', () => {
        const obj = JSON.parse(body) as { stream?: boolean };
        if (obj.stream === true) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'hel' } }) + '\n');
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'lo ' } }) + '\n');
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'world' }, done: true }) + '\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: 'hello world' } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
      });

      const chunks: string[] = [];
      const out = await client.chat([{ role: 'user', content: 'hi' }], {
        onToken: (c) => chunks.push(c),
      });
      expect(out).toBe('hello world');
      expect(chunks).toEqual(['hel', 'lo ', 'world']);

      // Without onToken: non-streaming path still works
      const out2 = await client.chat([{ role: 'user', content: 'hi' }]);
      expect(out2).toBe('hello world');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts streaming when token loop is detected', async () => {
    // Server that streams a tiny repeating chunk forever (simulates token loop)
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        // 60-char chunk; after ~9 ticks (>4*120=480 chars) detector fires
        res.write(
          JSON.stringify({
            message: { role: 'assistant', content: 'abcdefghij'.repeat(6) },
          }) + '\n',
        );
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0, // 仅靠 detectLoop 触发
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/token loop/);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('stops on done=true even when provider keeps the NDJSON connection open', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'hello ' } }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'world' }, done: true }) + '\n');
      open = res; // no res.end()
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
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

  it('stops early when streamed JSON is already complete but provider keeps streaming connection open', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '{"requirementDigest":"x",' } }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: '"globalPrompt":"","dependencies":[],' } }) + '\n');
      const steps = [
        ['S001', 'REQUIREMENT_ANALYSIS', 'Planner', ['docs/01-requirement-analysis.md']],
        ['S002', 'HIGH_LEVEL_DESIGN', 'Architect', ['docs/02-high-level-design.md']],
        ['S003', 'DETAILED_DESIGN', 'Architect', ['docs/03-detailed-design.md']],
        ['S004', 'CODE', 'Coder', ['src/main.py']],
        ['S005', 'UNIT_TEST', 'Tester', ['docs/05-unit-test.md']],
        ['S006', 'INTEGRATION_TEST', 'Tester', ['docs/06-integration-test.md']],
        ['S007', 'MODULE_TEST', 'Tester', ['docs/07-module-test.md']],
        ['S008', 'FUNCTIONAL_TEST', 'Tester', ['docs/08-functional-test.md']],
      ].map(([id, phase, role, outputs], index) => ({
        id,
        title: String(phase),
        description: 'd',
        systemPrompt: 'p',
        phase,
        role,
        tools: [],
        inputs: [],
        outputs,
        dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
        acceptance: 'a',
        maxAttempts: 3,
      }));
      res.write(JSON.stringify({ message: { role: 'assistant', content: `"steps":${JSON.stringify(steps)}}` } }) + '\n');
      open = res; // no done=true, no end
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 5_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], {
          onToken: () => {},
          responseFormat: 'json',
          validate: (text) => {
            const parsed = JSON.parse(text) as { requirementDigest?: unknown; steps?: unknown[] };
            if (typeof parsed.requirementDigest !== 'string' || !Array.isArray(parsed.steps) || parsed.steps.length < 8) {
              throw new Error('incomplete planner json');
            }
          },
        }),
      ).resolves.toContain('"requirementDigest":"x"');
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not abort valid long output just because it exceeds maxOutputChars', async () => {
    const payload = Array.from({ length: 350 }, (_, i) => `item-${i}`).join(',');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '{"thoughts":"' } }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: payload } }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: '","actions":[],"done":true}' }, done: true }) + '\n');
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 1000,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).resolves.toContain('item-349');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts repeated streaming output as a token loop', async () => {
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'x'.repeat(200) } }) + '\n');
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 1000,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], {
          onToken: () => {},
        }),
      ).rejects.toThrow(/token loop/);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('times out while waiting for response headers', async () => {
    const server = createServer((_req, _res) => {
      // Accept the request but never send response headers. Watchdogs must cover
      // this phase as well as an already-started response body.
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 100,
        streamIdleTimeoutMs: 1_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/wall-clock 100ms/);
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does NOT abort on legitimate repetitive content (e.g. python regex columns)', async () => {
    // 模拟 LLM 写一段含 ~3KB Python 正则的 JSON 输出。重复的 `\\s+(\\d+)` 单元 12 字符，
    // 远小于 detectLoop 的 200-char 窗口，不应触发。
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const regex = '\\\\s+(\\\\d+)'.repeat(200); // ~2400 chars 重复
      const body = `{"action":"write_file","content":"pattern = r'${regex}'"}`;
      res.write(JSON.stringify({ message: { role: 'assistant', content: body } }) + '\n');
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      const out = await client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} });
      expect(out.length).toBeGreaterThan(2000);
      expect(out).toContain('write_file');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('idle timeout resets while a healthy slow stream is producing data', async () => {
    // 服务器每 80ms 推一段，总耗时约 720ms；关闭总 wall-clock，仅验证每个
    // chunk 都会刷新 120ms idle deadline。
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let n = 0;
      const tick = () => {
        if (res.writableEnded) return;
        n++;
        res.write(JSON.stringify({ message: { role: 'assistant', content: `c${n} ` } }) + '\n');
        if (n >= 9) {
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'end' }, done: true }) + '\n');
          res.end();
          return;
        }
        setTimeout(tick, 80);
      };
      setTimeout(tick, 80);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 120,
        maxOutputChars: 0,
      });
      const out = await client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} });
      expect(out).toContain('c1');
      expect(out).toContain('c9');
      expect(out).toContain('end');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('fixed wall-clock stops a runaway stream even while data keeps arriving', async () => {
    // 服务器每 50ms 推一段且永不停。总 wall-clock 不能因收到数据而滑动延长。
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let n = 0;
      const tick = () => {
        if (stop || res.writableEnded) return;
        n++;
        res.write(JSON.stringify({ message: { role: 'assistant', content: `tok${n} ` } }) + '\n');
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 120,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/wall-clock 120ms/);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(800);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
