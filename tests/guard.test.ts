import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { writeFileTool, appendFileTool, readFileTool } from '../src/tools/fs.js';
import { EditGuard, resolveEditGuardMaxLines } from '../src/tools/guard.js';
import type { ToolContext } from '../src/tools/types.js';

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-guard-'));
  ws = new Workspace(tmp);
  ctx = {
    ws,
    sandbox: undefined as never,
    allowedWrites: ['src/'],
    stepId: 'S010',
  };
});

describe('EditGuard', () => {
  it('passes through non-write tools unchanged', async () => {
    const g = new EditGuard({ ws, stepId: 'S010', maxLines: 10 });
    const wrapped = g.wrap(readFileTool);
    expect(wrapped).toBe(readFileTool);
  });

  it('writes edits-*.jsonl audit and counts lines', async () => {
    const g = new EditGuard({ ws, stepId: 'S010', maxLines: 100 });
    const wrapped = g.wrap(writeFileTool);
    const r = await wrapped.run({ path: 'src/a.py', content: 'a\nb\nc\n' }, ctx);
    expect(r.ok).toBe(true);
    expect(g.totalLines).toBeGreaterThan(0);
    const log = await ws.readFile(`logs/edits-S010.jsonl`);
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].tool).toBe('write_file');
    expect(lines[0].ok).toBe(true);
  });

  it('guards append_file writes as audited line-counted edits', async () => {
    const g = new EditGuard({ ws, stepId: 'S010', maxLines: 100 });
    const wrappedWrite = g.wrap(writeFileTool);
    const wrappedAppend = g.wrap(appendFileTool);
    await wrappedWrite.run({ path: 'src/a.py', content: 'a\n' }, ctx);
    const r = await wrappedAppend.run({ path: 'src/a.py', content: 'b\nc\n' }, ctx);
    expect(r.ok).toBe(true);
    expect(g.totalLines).toBe(5);
    const log = await ws.readFile(`logs/edits-S010.jsonl`);
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((x) => x.tool)).toEqual(['write_file', 'append_file']);
    expect(lines[1].approxLines).toBe(3);
  });

  it('rejects write once line cap exceeded', async () => {
    const g = new EditGuard({ ws, stepId: 'S010', maxLines: 3 });
    const wrapped = g.wrap(writeFileTool);
    const big = 'x\n'.repeat(10);
    const r1 = await wrapped.run({ path: 'src/a.py', content: big }, ctx);
    expect(r1.ok).toBe(true);
    const r2 = await wrapped.run({ path: 'src/b.py', content: 'y\n' }, ctx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/max .* lines per step exceeded/);
  });

  it('keeps explicit numeric caps strict', async () => {
    expect(resolveEditGuardMaxLines(12, { phase: 'CODE', debug: true, tools: ['write_file'] })).toBe(12);
  });

  it('auto-scales line budget from step context', async () => {
    const g = new EditGuard({
      ws,
      stepId: 'S010',
      maxLines: 'auto',
      budgetContext: {
        phase: 'MODULE_TEST',
        role: 'Tester',
        tools: ['write_file', 'replace_in_file'],
        outputs: ['tests/test_weather.py'],
        allowedWrites: ['tests/'],
        contextChars: 5333,
      },
    });
    const wrapped = g.wrap(writeFileTool);
    const manyShortLines = 'x\n'.repeat(457);
    const r1 = await wrapped.run({ path: 'src/a.py', content: manyShortLines }, ctx);
    expect(r1.ok).toBe(true);
    const r2 = await wrapped.run({ path: 'src/b.py', content: 'y\n' }, ctx);
    expect(r2.ok).toBe(true);
  });
});
