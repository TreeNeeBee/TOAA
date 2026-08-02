import {
  compactFailureEvidence,
} from '../../core/debug_brief.js';
import type { LanguageProfile } from '../../core/language.js';
import {
  type Plan,
  type Step,
} from '../../core/plan.js';

export function hasTypeScriptConfigOutput(
  outputs: string[],
  language: LanguageProfile['id'],
): boolean {
  return language === 'typescript' && outputs.includes('tsconfig.json');
}

export function normalizeGitPath(file: string): string {
  return file.replace(/\\/g, '/');
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
