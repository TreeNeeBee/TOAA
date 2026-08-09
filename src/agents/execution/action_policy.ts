import type { ToolContext, ToolPermissionRequest } from '../../tools/types.js';

export function actionTargetPaths(tool: string, args: unknown): string[] {
  if (!isRecord(args)) return [];
  if (tool === 'read_file' || tool === 'list_dir' || tool === 'write_file' ||
      tool === 'append_file' || tool === 'replace_in_file') {
    if (typeof args.path === 'string') return [normalizeRelPath(args.path)];
    return tool === 'list_dir' ? ['.'] : [];
  }
  if (tool === 'code_search') {
    return typeof args.root === 'string' ? [normalizeRelPath(args.root)] : ['.'];
  }
  if (tool === 'apply_patch' && typeof args.patch === 'string') {
    return extractPatchTargets(args.patch).map(normalizeRelPath);
  }
  if (tool === 'http_fetch' && typeof args.saveAs === 'string') {
    return [normalizeRelPath(args.saveAs)];
  }
  return [];
}

export function normalizeRelPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\/+|\/+$/gu, '');
}

export function buildPermissionRequest(
  tool: string,
  args: unknown,
  stepId: string,
  language: ToolContext['language'],
  stepName?: string,
): ToolPermissionRequest | undefined {
  const values = isRecord(args) ? args : {};
  const target = actionTargetPaths(tool, args).join(', ');
  const runtime = language === 'typescript' ? 'npm' : 'python';
  const stepLabel = stepName?.trim() || stepId;
  if (['write_file', 'append_file', 'replace_in_file', 'apply_patch'].includes(tool)) {
    return permission('file_write', target || '(workspace file)',
      `Step ${stepLabel} requested ${tool} to update project files.`,
      'This operation modifies files in the current workspace.', 'current workspace',
      'The tool call is skipped and the agent must continue with an alternative or fail the step.',
      stepId, tool, stepLabel, redactLargeArgs(args));
  }
  if (tool === 'add_dependency') {
    return permission('config_change', language === 'typescript' ? 'package.json' : 'requirements.txt',
      `Step ${stepLabel} requested dependency manifest changes.`,
      'This can alter project dependencies and may trigger sandbox rebuilds.',
      'current workspace dependency manifest',
      'The dependency change is skipped; later build or test steps may fail and report the missing dependency.',
      stepId, tool, stepLabel, args);
  }
  if (tool === 'install_deps') {
    return permission('install_dependency', Array.isArray(values.packages) ? values.packages.join(', ') : '(packages)',
      `Step ${stepLabel} requested dependency installation.`,
      'This may execute package manager scripts and download code from registries.',
      'current workspace sandbox',
      'Dependency installation is skipped and the task continues with the missing dependency reported.',
      stepId, tool, stepLabel, args);
  }
  if (tool === 'run_tests') {
    return permission('test_command', runtime === 'npm' ? 'npm test' : 'pytest',
      `Step ${stepLabel} requested test execution to validate changes.`,
      'Project test scripts may execute arbitrary local project code.', 'current workspace sandbox',
      'Tests are skipped and the final result must mark verification as incomplete.',
      stepId, tool, stepLabel, args);
  }
  if (tool === 'run_program') {
    const command = `${runtime} ${Array.isArray(values.args) ? values.args.join(' ') : ''}`.trim();
    return permission('shell_command', command, `Step ${stepLabel} requested program execution.`,
      'This executes project code in the configured sandbox.', 'current workspace sandbox',
      'The command is skipped and the agent must use another validation strategy or fail the step.',
      stepId, tool, stepLabel, args);
  }
  if (tool === 'http_fetch') {
    return permission('network_access', typeof values.url === 'string' ? values.url : '(url)',
      `Step ${stepLabel} requested network access.`,
      'This contacts an external HTTP endpoint from the host process.', 'network',
      'The network call is skipped; the agent must use local context or report the missing data.',
      stepId, tool, stepLabel, redactLargeArgs(args));
  }
  return undefined;
}

function permission(
  operationType: ToolPermissionRequest['operationType'],
  target: string,
  reason: string,
  risk: string,
  scope: string,
  denyBehavior: string,
  stepId: string,
  tool: string,
  stepName: string,
  args: unknown,
): ToolPermissionRequest {
  return {
    operationType, target, reason, risk, scope, denyBehavior,
    skippable: true, stepId, tool, metadata: { stepName, args },
  };
}

function extractPatchTargets(patch: string): string[] {
  const targets = new Set<string>();
  for (const line of patch.split('\n')) {
    const match = line.match(/^\*\*\* (?:Update File|Add File|Delete File):\s+(.+)$/u) ??
      line.match(/^\+\+\+\s+b\/(.+)$/u) ?? line.match(/^---\s+a\/(.+)$/u);
    if (match?.[1] && match[1] !== '/dev/null') targets.add(match[1].trim());
  }
  return [...targets];
}

function redactLargeArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return { value: args ?? null };
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    typeof value === 'string' && value.length > 500
      ? `${value.slice(0, 500)}... [truncated ${value.length - 500} chars]`
      : value,
  ]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
