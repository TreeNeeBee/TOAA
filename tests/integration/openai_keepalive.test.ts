import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAI_TCP_KEEPALIVE_MS,
  openAIConnectOptions,
} from '../../src/llm/openai.js';

/**
 * A network that disappears mid-request leaves nothing to detect.
 *
 * No RST, no FIN — the socket black-holes and the request expires on our own clock, reported as a
 * timeout. Two live dbc2excel runs died that way, and `timed out after 900000ms` cannot tell an
 * operator whether the network was gone or the model was merely slow. Kernel probes can: a peer's
 * kernel answers them while its model is still thinking, so an unanswered probe means the path is
 * gone rather than that the answer is slow.
 */
describe('TCP keepalive', () => {
  it('arms kernel probes by default, because a black-holed socket is what nobody configures for', () => {
    const options = openAIConnectOptions({});
    expect(options.keepAlive).toBe(true);
    expect(options.keepAliveInitialDelay).toBe(DEFAULT_OPENAI_TCP_KEEPALIVE_MS);
  });

  it('uses the configured delay', () => {
    expect(openAIConnectOptions({ tcpKeepAliveMs: 15_000 }).keepAliveInitialDelay).toBe(15_000);
  });

  // A middlebox that drops probed connections needs a way out, and the configured value must be what
  // decides — not a default nobody chose.
  it('leaves probes off when configured to zero', () => {
    const options = openAIConnectOptions({ tcpKeepAliveMs: 0 });
    expect(options.keepAlive).toBeUndefined();
    expect(options.keepAliveInitialDelay).toBeUndefined();
  });

  /**
   * Guards the dependency, not our code: undici binds `net.connect` at import time, so only a fresh
   * process with the patch installed first can see what actually reaches the socket. Without this, an
   * undici upgrade could accept these options and drop them, leaving every check above green and
   * every black-holed request unchanged.
   */
  it('is passed through to the socket by the installed undici', () => {
    const script = `
      const net = require('node:net');
      const original = net.connect;
      const seen = [];
      net.connect = (...args) => { if (args[0] && typeof args[0] === 'object') seen.push(args[0]); return original(...args); };
      const { Agent, request } = require('undici');
      const agent = new Agent({ connect: { timeout: 200, keepAlive: true, keepAliveInitialDelay: 12345 } });
      request('http://127.0.0.1:9/', { method: 'POST', body: '{}', dispatcher: agent })
        .catch(() => undefined)
        .finally(() => {
          const hit = seen.find((o) => 'keepAlive' in o) ?? {};
          console.log(JSON.stringify({ keepAlive: hit.keepAlive, delay: hit.keepAliveInitialDelay }));
        });
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(out.trim())).toEqual({ keepAlive: true, delay: 12345 });
  }, 30_000);
});

/**
 * Headers and the first token answer different questions.
 *
 * A streaming server writes its headers at once and only then begins thinking, so silence before the
 * headers is the connection and silence after them is the model. Both used to share the first-token
 * budget, which gave a dead endpoint the same five minutes as a model composing an answer — and the
 * failure could not say which had happened.
 *
 * Streaming only, and asserted as such: a non-stream response withholds its headers until the whole
 * answer exists, so the same clock there would kill every legitimate long generation.
 */
describe('stream response-header timeout', () => {
  it('gives up on a streaming request whose headers never arrive, long before the first-token budget', async () => {
    const { OpenAIClient } = await import('../../src/llm/openai.js');
    const { createServer } = await import('node:http');
    const server = createServer(() => { /* accepts the request, never writes a response */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      const client = new OpenAIClient({
        apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'dead',
        // The first-token and wall budgets are deliberately far larger: with no headers clock, this
        // test would wait on them instead of failing fast.
        streamFirstTokenTimeoutMs: 60_000,
        requestTimeoutMs: 60_000,
        streamHeadersTimeoutMs: 250,
      });
      const started = Date.now();
      await expect(client.chat([{ role: 'user', content: 'hi' }], { onToken: () => undefined }))
        .rejects.toThrow(/no response headers for 250ms/u);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it('does not apply to a non-stream request, whose headers wait for the whole answer', async () => {
    const { OpenAIClient } = await import('../../src/llm/openai.js');
    const { createServer } = await import('node:http');
    // Answers later than the streaming headers budget would ever allow.
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'slow but complete' } }] }));
      }, 600);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      const client = new OpenAIClient({
        apiKey: '', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'slow',
        requestTimeoutMs: 20_000,
        streamHeadersTimeoutMs: 250,
      });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('slow but complete');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});
