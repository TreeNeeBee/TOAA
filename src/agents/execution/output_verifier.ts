import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Step } from '../../core/plan.js';
import type { ToolContext } from '../../tools/types.js';
import { isPathPattern, matchesPathPattern } from '../../tools/types.js';

export interface OutputVerificationInput {
  step: Pick<Step, 'outputs'>;
  ctx: Pick<ToolContext, 'ws'>;
}

export async function verifyOutputs(
  input: OutputVerificationInput,
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const output of input.step.outputs) {
    if (output.endsWith('/')) continue;
    if (isPathPattern(output)) {
      if (!(await hasOutputMatching(input, output))) missing.push(output);
      continue;
    }
    if (!(await input.ctx.ws.exists(output)) || !(await hasSubstantiveOutputContent(input, output))) {
      missing.push(output);
    }
  }
  return { ok: missing.length === 0, missing };
}

async function hasOutputMatching(input: OutputVerificationInput, pattern: string): Promise<boolean> {
  const parts = pattern.split('/').slice(0, -1);
  const fixedParts: string[] = [];
  for (const part of parts) {
    if (/[*?]/u.test(part)) break;
    fixedParts.push(part);
  }
  const prefix = fixedParts.join('/');
  const root = input.ctx.ws.abs(prefix);
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath ?? root, entry.name);
    const relative = path.relative(input.ctx.ws.root, absolute).split(path.sep).join('/');
    if (matchesPathPattern(relative, pattern) && await hasSubstantiveOutputContent(input, relative)) {
      return true;
    }
  }
  return false;
}

async function hasSubstantiveOutputContent(
  input: OutputVerificationInput,
  output: string,
): Promise<boolean> {
  if (output.endsWith('/__init__.py') || output.endsWith('/.gitkeep')) return true;
  const stat = await fs.stat(input.ctx.ws.abs(output)).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) return false;
  if (!isTextOutput(output)) return true;
  const content = await fs.readFile(input.ctx.ws.abs(output), 'utf8').catch(() => '');
  return content.trim().length > 0;
}

function isTextOutput(output: string): boolean {
  return /(?:^|\/)(?:README|LICENSE)(?:\.[A-Za-z0-9]+)?$/iu.test(output) ||
    /\.(?:cjs|css|csv|hbs|html?|ini|json|jsx?|md|mjs|py|toml|tsx?|txt|xml|ya?ml)$/iu.test(output);
}
