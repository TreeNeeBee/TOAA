import type { Step } from '../../core/plan.js';
import type { Tool, ToolContext, ToolResult } from '../../tools/types.js';
import type { LLMAction } from './turn_parser.js';

export interface NormalizedActions {
  actions: LLMAction[];
  invalid: Array<{ index: number; raw: unknown; result: ToolResult & { tool: string } }>;
}

export function normalizeActions(raw: unknown, toolMap?: Map<string, Tool>): NormalizedActions {
  if (raw === undefined || raw === null) return { actions: [], invalid: [] };
  if (!Array.isArray(raw)) {
    return {
      actions: [],
      invalid: [{
        index: -1,
        raw,
        result: {
          tool: 'invalid_action',
          ok: false,
          error: 'invalid actions field: expected an array of tool calls',
        },
      }],
    };
  }
  const actions: LLMAction[] = [];
  const invalid: NormalizedActions['invalid'] = [];
  raw.forEach((item, index) => {
    if (!isPlainRecord(item)) {
      invalid.push({
        index,
        raw: item,
        result: { tool: 'invalid_action', ok: false, error: `invalid action at index ${index}: expected object` },
      });
      return;
    }
    if (typeof item.tool !== 'string' || item.tool.trim().length === 0) {
      invalid.push({
        index,
        raw: item,
        result: { tool: 'invalid_action', ok: false, error: `invalid action at index ${index}: missing string tool` },
      });
      return;
    }
    const normalizedArgs = normalizeActionArgs(item.tool, item.args);
    if (!normalizedArgs.ok) {
      invalid.push({
        index,
        raw: item,
        result: { tool: item.tool, ok: false, error: `invalid action at index ${index}: ${normalizedArgs.error}` },
      });
      return;
    }
    const selectedTool = toolMap?.get(item.tool);
    const schemaError = selectedTool
      ? validateToolArgsAgainstSchema(selectedTool, normalizedArgs.args)
      : undefined;
    if (schemaError) {
      invalid.push({
        index,
        raw: item,
        result: { tool: item.tool, ok: false, error: schemaError },
      });
      return;
    }
    actions.push({ tool: item.tool, args: normalizedArgs.args });
  });
  return { actions, invalid };
}

export function describeToolForStep(tool: Tool, context: ToolContext, step: Step): string {
  const details = [tool.description];
  const inputs = compactPathCandidates(step.inputs);
  const outputs = compactPathCandidates(step.outputs);
  const writable = compactPathCandidates(context.allowedWrites);

  if (tool.name === 'read_file') {
    details.push(
      'args.path is required: use one concrete workspace-relative file path; never omit it. ' +
      `Step path hints: inputs=[${inputs}], outputs=[${outputs}]. ` +
      `Current read window: ${context.readChunkBytes ?? '(runtime default)'}B; when truncated, continue with args.offset=nextOffset.`,
    );
  } else if (tool.name === 'write_file' || tool.name === 'append_file' || tool.name === 'replace_in_file') {
    details.push(
      'args.path is required and must be a concrete workspace-relative path allowed by this Step. ' +
      `Path candidates: outputs=[${outputs}], writable=[${writable}].`,
    );
    if (tool.name === 'replace_in_file') {
      details.push('The target must already exist; use read_file on that exact path before replacing when current bytes are uncertain.');
    }
  } else if (tool.name === 'apply_patch') {
    details.push(
      'Every target in the unified diff +++ header must be workspace-relative and allowed by this Step. ' +
      `Path candidates: outputs=[${outputs}], writable=[${writable}].`,
    );
  } else if (tool.name === 'list_dir') {
    details.push('args.path is optional; when present, use a concrete workspace-relative directory path.');
  } else if (tool.name === 'code_search') {
    details.push('args.root is optional; when present, use a concrete workspace-relative directory path.');
  } else if (tool.name === 'http_fetch') {
    details.push(
      `args.saveAs is optional; when present, it must be a concrete workspace-relative path in writable=[${writable}].`,
    );
  } else if (tool.name === 'run_program' || tool.name === 'run_tests') {
    details.push('args.cwd is optional; when present, it must be a concrete workspace-relative directory path.');
  }
  if ((tool.name === 'write_file' || tool.name === 'append_file') && context.writeChunkBytes) {
    details.push(`Current Step content chunk limit: ${context.writeChunkBytes}B.`);
  }
  return details.join(' ');
}

export async function safeRunTool(tool: Tool, args: unknown, context: ToolContext): Promise<ToolResult> {
  try {
    return await tool.run(args as never, context);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function validateToolArgsAgainstSchema(tool: Tool, args: Record<string, unknown>): string | undefined {
  for (const [key, rawDescriptor] of Object.entries(tool.argsSchema)) {
    if (typeof rawDescriptor !== 'string') continue;
    const token = rawDescriptor.trim().split(/\s+/, 1)[0] ?? '';
    const optional = token.endsWith('?');
    const expectedType = optional ? token.slice(0, -1) : token;
    const value = args[key];
    if (value === undefined || value === null) {
      if (optional) continue;
      return formatToolArgError(tool, key, expectedType);
    }
    if (expectedType === 'string' && typeof value !== 'string') return formatToolArgError(tool, key, expectedType);
    if (expectedType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return formatToolArgError(tool, key, expectedType);
    }
    if (expectedType === 'boolean' && typeof value !== 'boolean') return formatToolArgError(tool, key, expectedType);
    if (expectedType === 'string[]' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
      return formatToolArgError(tool, key, expectedType);
    }
    if (expectedType.startsWith('Record<') && !isPlainRecord(value)) {
      return formatToolArgError(tool, key, expectedType);
    }
    if (key === 'path' && typeof value === 'string' && value.trim().length === 0) {
      return formatToolArgError(tool, key, expectedType);
    }
  }
  return undefined;
}

function formatToolArgError(tool: Tool, key: string, expectedType: string): string {
  const expected = JSON.stringify(tool.argsSchema);
  if (key === 'path' && expectedType === 'string') {
    return `invalid ${tool.name} args: path must be a non-empty string; expected args=${expected}`;
  }
  const label = expectedType === 'string[]'
    ? 'a string array'
    : expectedType.startsWith('Record<')
      ? 'an object'
      : `a ${expectedType || 'valid'} value`;
  return `invalid ${tool.name} args: ${key} must be ${label}; expected args=${expected}`;
}

function normalizeActionArgs(
  tool: string,
  rawArgs: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (isPlainRecord(rawArgs)) return { ok: true, args: rawArgs };
  if (rawArgs === undefined || rawArgs === null) return { ok: true, args: {} };
  if (typeof rawArgs === 'string') {
    const key = STRING_ARG_TOOL_KEYS[tool];
    if (key) return { ok: true, args: { [key]: rawArgs } };
  }
  if (Array.isArray(rawArgs)) {
    if (tool === 'run_tests' || tool === 'run_program') {
      const args = rawArgs.filter((item): item is string => typeof item === 'string');
      if (args.length === rawArgs.length) return { ok: true, args: { args } };
    }
    const key = STRING_ARG_TOOL_KEYS[tool];
    if (key && typeof rawArgs[0] === 'string') {
      const output: Record<string, unknown> = { [key]: rawArgs[0] };
      if (tool === 'read_file' && typeof rawArgs[1] === 'number') output.maxBytes = rawArgs[1];
      return { ok: true, args: output };
    }
  }
  return { ok: false, error: 'args must be an object' };
}

const STRING_ARG_TOOL_KEYS: Record<string, string> = {
  apply_patch: 'patch',
  code_search: 'query',
  http_fetch: 'url',
  list_dir: 'path',
  read_file: 'path',
};

function compactPathCandidates(paths: string[], limit = 10): string {
  if (paths.length === 0) return '(none declared)';
  const visible = paths.slice(0, limit);
  const omitted = paths.length - visible.length;
  return `${visible.join(', ')}${omitted > 0 ? `, ... (+${omitted})` : ''}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
