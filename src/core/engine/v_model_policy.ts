import type { Workspace } from '../../workspace/workspace.js';
import type { DebugAttemptEntry } from '../debug_cache.js';
import {
  compactFailureEvidence,
  type DebugBrief,
} from '../debug_brief.js';
import type { LanguageProfile } from '../language.js';
import {
  PHASE_ORDER,
  type Plan,
  type Step,
} from '../plan.js';

export function collectRollbackRepairOutputs(
  order: Step[],
  sourceStep: Step,
  routedTest: Step,
  manifestFile: string,
): string[] {
  const iterationId = sourceStep.iterationId ?? 'P1';
  const sourceOrder = PHASE_ORDER[sourceStep.phase];
  const testOrder = PHASE_ORDER[routedTest.phase];
  const outputs = order
    .filter((step) => (step.iterationId ?? 'P1') === iterationId)
    .filter((step) => {
      const phaseOrder = PHASE_ORDER[step.phase];
      return phaseOrder >= sourceOrder && phaseOrder <= testOrder;
    })
    .flatMap((step) => step.outputs)
    .filter((output) => output !== manifestFile);
  return dedup(outputs);
}

export function codeValidationCommand(
  language: LanguageProfile['id'],
): { cmd: string; args: string[]; display: string } {
  return language === 'typescript'
    ? { cmd: 'npx', args: ['tsc', '--noEmit'], display: 'npx tsc --noEmit' }
    : { cmd: 'python3', args: ['-m', 'compileall', '-q', 'src'], display: 'python3 -m compileall -q src' };
}

export function shouldRunCodeValidation(plan: Plan, current: Step): boolean {
  if (current.phase !== 'CODE') return false;
  const iterationId = current.iterationId ?? 'P1';
  return !plan.steps.some((step) =>
    step.id !== current.id &&
    step.phase === 'CODE' &&
    (step.iterationId ?? 'P1') === iterationId &&
    step.status !== 'DONE',
  );
}

export async function hasCodeValidationPrerequisites(
  workspace: Workspace,
  language: LanguageProfile['id'],
): Promise<boolean> {
  return language === 'python' || workspace.exists('tsconfig.json');
}

export function hasTypeScriptConfigOutput(
  outputs: string[],
  language: LanguageProfile['id'],
): boolean {
  return language === 'typescript' && outputs.includes('tsconfig.json');
}

export function isDesignSourcePhase(phase: Step['phase']): boolean {
  return phase === 'REQUIREMENT_ANALYSIS' ||
    phase === 'HIGH_LEVEL_DESIGN' ||
    phase === 'DETAILED_DESIGN';
}

export function normalizeGitPath(file: string): string {
  return file.replace(/\\/g, '/');
}

export function isRuntimeOnlyChange(file: string, planPath: string): boolean {
  if (file === planPath) return true;
  if (file.startsWith('.xcompiler/')) return true;
  if (file === '.coverage' || file.startsWith('coverage/')) return true;
  if (file === '.pytest_cache' || file.startsWith('.pytest_cache/')) return true;
  if (file.endsWith('.tsbuildinfo')) return true;
  if (file.endsWith('.pyc')) return true;
  return file.split('/').includes('__pycache__');
}

export function isTestFilePath(file: string): boolean {
  const name = file.split('/').pop() ?? file;
  if (file.startsWith('tests/') || file.startsWith('test/')) {
    return /\.(py|[cm]?[jt]sx?)$/.test(name);
  }
  return (
    /^test_.+\.py$/.test(name) ||
    /_test\.py$/.test(name) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)
  );
}

export function hasExecutableTestDeclaration(
  content: string,
  language: Plan['language'],
): boolean {
  if (language === 'typescript') {
    return /\b(?:describe|it|test)\s*(?:\.\w+)?\s*\(/u.test(content);
  }
  return (
    /(?:^|\n)\s*(?:async\s+)?def\s+test_[A-Za-z0-9_]*\s*\(/u.test(content) ||
    /(?:^|\n)\s*class\s+Test[A-Za-z0-9_]*/u.test(content)
  );
}

export function extractFailedTestPaths(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bFAILED\s+((?:tests?|src)\/[^\s:]+?\.(?:py|[cm]?[jt]sx?))(?:\b|::|:)/gu,
    /^((?:tests?|src)\/[^\s:]+?\.(?:py|[cm]?[jt]sx?))\s+.*F/mgu,
    /(?:^|\s)((?:tests?|src)\/[^\s:]+?\.(?:py|[cm]?[jt]sx?))::/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const file = normalizeGitPath(match[1] ?? '');
      if (file && isTestFilePath(file)) found.push(file);
    }
  }
  return dedup(found);
}

export function sandboxBuildFailureReason(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? '';
  return `sandbox dependency install failed: ${firstLine.slice(0, 300)}`;
}

export function isSupersededNetworkBrief(root: DebugBrief, current: DebugBrief): boolean {
  return root.category === 'network_api_failure' && current.category === 'test_failure';
}

export function testRollbackTriageGuidance(brief: DebugBrief): string {
  const failedTests = brief.failedTests.length > 0
    ? ` Failed tests: ${brief.failedTests.join(', ')}.`
    : '';
  return [
    '## V-model test rollback triage',
    'Classify the failure before editing: a bad assertion, mock shape, fixture, test-server lifecycle, or loopback port is a test-artifact defect; a valid assertion exposing wrong product behavior is an implementation/contract defect.',
    'The paired source phase owns its test assets and may repair them during rollback. Right-side validation phases must never rewrite tests. Do not add product APIs solely to satisfy a test that calls a nonexistent helper.',
    `Patch the actual defect, then run the inherited scoped test command before done=true.${failedTests}`,
  ].join('\n');
}

export function renderTestValidationFailure(
  step: Step,
  testArgs: string[],
  result: { exitCode: number; timedOut: boolean; stdout: string; stderr: string },
): string {
  const reason = `${step.phase} current test gate failed for ${step.id}.`;
  const rawOutput = [
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
  ].filter(Boolean).join('\n');
  const evidence = compactFailureEvidence({
    reason,
    failureLog: rawOutput,
    phase: step.phase,
    maxChars: 10_000,
    maxLines: 120,
  });
  return [
    reason,
    `run_tests args=${testArgs.join(' ')} exit=${result.exitCode} timedOut=${result.timedOut}`,
    evidence,
  ].filter(Boolean).join('\n');
}

export function renderIncompleteTestPhaseFailure(
  step: Step,
  missingOutputs: string[],
): string {
  return [
    `${step.phase} ${step.id} has incomplete required outputs.`,
    `missing outputs: ${missingOutputs.join(', ')}`,
    'Repair the missing test-phase artifacts in the current step. Do not change source implementation unless a current test gate reproduces a source failure.',
  ].join('\n');
}

export function inferCachedTestScopeArgs(entry: DebugAttemptEntry): string[] {
  const explicit = (entry.testScopeArgs ?? [])
    .map(normalizeGitPath)
    .filter(isTestFilePath);
  if (explicit.length > 0) return dedup(explicit);

  const text = [
    entry.failureLogTail,
    entry.debugBrief?.toolFailures?.join('\n') ?? '',
    entry.debugBrief?.evidence?.join('\n') ?? '',
  ].filter(Boolean).join('\n');
  const fromRunTestsArgs = extractRunTestsArgs(text);
  if (fromRunTestsArgs.length > 0) return fromRunTestsArgs;

  const failedPaths = extractFailedTestPaths(text);
  if (failedPaths.length > 0) return failedPaths;

  return dedup((entry.debugBrief?.files ?? [])
    .map(normalizeGitPath)
    .filter(isTestFilePath));
}

function extractRunTestsArgs(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\brun_tests[^\n]*\bargs=([^\n]+)/giu)) {
    const raw = match[1] ?? '';
    for (const token of raw.split(/\s+/u)) {
      const cleaned = token.replace(/^["'`]+|["'`,;]+$/gu, '');
      const normalized = normalizeGitPath(cleaned);
      if (isTestFilePath(normalized)) out.push(normalized);
    }
  }
  return dedup(out);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
