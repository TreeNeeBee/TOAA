import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Workspace } from '../../src/workspace/workspace.js';
import { httpFetchTool } from '../../src/tools/net.js';
import type { ToolContext } from '../../src/tools/types.js';

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-net-'));
  ws = new Workspace(tmp);
  ctx = {
    ws,
    sandbox: undefined as never,
    allowedWrites: ['data/', 'fixtures/sample.bin'],
    stepId: 'S001',
  };
  server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world', method: req.method }));
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('A'.repeat(10_000));
      return;
    }
    if (req.url === '/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(Buffer.concat(chunks).toString('utf8'));
      });
      return;
    }
    if (req.url === '/binary') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('http_fetch tool', () => {
  it('rejects non-http(s) URLs', async () => {
    const r = await httpFetchTool.run({ url: 'file:///etc/passwd' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/http:\/\/ or https:\/\//);
  });

  it('GETs JSON and returns body inline', async () => {
    const r = await httpFetchTool.run({ url: `${baseUrl}/json` }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.status).toBe(200);
    expect(r.data?.contentType).toMatch(/application\/json/);
    expect(JSON.parse(r.data!.bodyText!)).toEqual({ hello: 'world', method: 'GET' });
  });

  it('truncates long bodies at maxBytes', async () => {
    const r = await httpFetchTool.run({ url: `${baseUrl}/big`, maxBytes: 100 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(true);
    expect(r.data?.totalBytes).toBe(10_000);
    expect(r.data?.bodyText?.length).toBe(100);
  });

  it('POSTs body and reads echo response', async () => {
    const r = await httpFetchTool.run(
      { url: `${baseUrl}/echo`, method: 'POST', body: 'hello' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.data?.bodyText).toBe('hello');
  });

  it('saves binary response to workspace path inside allowedWrites', async () => {
    const r = await httpFetchTool.run(
      { url: `${baseUrl}/binary`, saveAs: 'fixtures/sample.bin' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.data?.savedTo).toBe('fixtures/sample.bin');
    const buf = await fs.readFile(path.join(tmp, 'fixtures/sample.bin'));
    expect(buf.length).toBe(5);
    expect(buf[0]).toBe(0x00);
    expect(buf[4]).toBe(0xfe);
  });

  it('refuses saveAs outside allowedWrites', async () => {
    const r = await httpFetchTool.run(
      { url: `${baseUrl}/json`, saveAs: 'secrets/leak.json' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/allowedWrites/);
  });

  it('returns ok=false but data.status for non-2xx responses', async () => {
    const r = await httpFetchTool.run({ url: `${baseUrl}/missing` }, ctx);
    expect(r.ok).toBe(false);
    expect(r.data?.status).toBe(404);
    expect(r.data?.bodyText).toBe('not found');
  });
});
