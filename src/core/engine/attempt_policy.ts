import type {
  AdvisoryFailureRule,
  ExecutorRunResult,
} from '../../agents/executor.js';
import { compactFailureEvidence } from '../debug_brief.js';

export function designPhaseDebugAdvisoryFailureRules(): AdvisoryFailureRule[] {
  return [
    { pathPrefix: 'src/', errorIncludes: 'write denied:' },
    { pathPrefix: 'src/', errorIncludes: 'append denied:' },
    { pathPrefix: 'src/', errorIncludes: 'not in step writable allowlist' },
    { tool: 'replace_in_file', errorIncludes: 'expected 1 occurrences of find, found 0' },
  ];
}

const REPAIR_MUTATION_TOOLS = new Set([
  'add_dependency',
  'append_file',
  'apply_patch',
  'replace_in_file',
  'write_file',
]);

export function hasSuccessfulRepairMutation(
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>,
): boolean {
  return toolCalls.some((call) => call.ok && REPAIR_MUTATION_TOOLS.has(call.tool));
}

const REPAIR_VERIFICATION_TOOLS = new Set([
  'run_program',
  'run_tests',
]);

export function hasSuccessfulVerificationEvidence(
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>,
): boolean {
  return toolCalls.some((call) => call.ok && REPAIR_VERIFICATION_TOOLS.has(call.tool));
}

export function hasFailedVerificationEvidence(
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>,
): boolean {
  return toolCalls.some((call) => !call.ok && REPAIR_VERIFICATION_TOOLS.has(call.tool));
}

export function shouldRollbackTestPhaseFromToolFailures(
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>,
): boolean {
  let unresolvedTestFailure = false;
  let unresolvedDependencyToolFailure = false;
  for (const call of toolCalls) {
    const detail = `${call.tool} ${call.error ?? call.summary ?? ''}`.toLowerCase();

    if (!call.ok && detail.includes('tool not allowed for this step: add_dependency')) {
      unresolvedDependencyToolFailure = true;
      continue;
    }
    if (!call.ok && isStructuralToolFailure(detail)) return true;
    if (call.ok && call.tool === 'run_tests') {
      unresolvedTestFailure = false;
      unresolvedDependencyToolFailure = false;
      continue;
    }
    if (!call.ok && isTestVerificationFailure(call.tool, detail)) {
      unresolvedTestFailure = true;
    }
  }
  return unresolvedTestFailure || unresolvedDependencyToolFailure;
}

export function compactToolCallFailureDetail(
  call: ExecutorRunResult['toolCalls'][number],
): string {
  const detail = [call.summary, call.error]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join('\n');
  if (!call.ok && call.tool === 'run_tests') {
    return compactFailureEvidence({
      reason: 'run_tests failed',
      failureLog: detail,
      maxChars: 3800,
      maxLines: 60,
    });
  }
  return compactToolCallDetail(detail);
}

export function inferRepairMode(
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>,
): 'patch' | 'rewrite' | 'patch-or-rewrite' | 'verification' {
  const successful = toolCalls.filter((call) => call.ok).map((call) => call.tool);
  const usedPatch = successful.some((tool) => tool === 'apply_patch' || tool === 'replace_in_file');
  const usedRewrite = successful.some((tool) => tool === 'write_file' || tool === 'append_file');
  if (usedPatch && usedRewrite) return 'patch-or-rewrite';
  if (usedPatch) return 'patch';
  if (usedRewrite) return 'rewrite';
  return 'verification';
}

export function parsePatchChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu)) {
    files.push(normalizeGitPath(match[2] ?? match[1] ?? ''));
  }
  return dedup(files.filter(Boolean));
}

function isTestVerificationFailure(tool: string, detail: string): boolean {
  return tool === 'run_tests' || detail.includes('pytest exit=');
}

function isStructuralToolFailure(detail: string): boolean {
  return /(?:write|append) denied: (?:src|tests)\//u.test(detail);
}

function compactToolCallDetail(detail: string): string {
  const normalized = detail.trim();
  if (normalized.length <= 2000) return normalized;
  const head = normalized.slice(0, 800);
  const tail = normalized.slice(-1000);
  return `${head}\n... [truncated ${normalized.length - head.length - tail.length} chars]\n${tail}`;
}

function normalizeGitPath(file: string): string {
  return file.replace(/\\/g, '/');
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
