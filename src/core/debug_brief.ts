import { createHash } from 'node:crypto';

import type { Phase } from './plan.js';
import { isLoopbackNetworkFailureLine } from './network_api_gate.js';

export type DebugFailureCategory = 'test_failure' | 'syntax_error' | 'import_error' | 'dependency_error' |
  'network_api_failure' | 'missing_output' | 'tool_loop' | 'permission_denied' | 'llm_provider' | 'exception' | 'unknown';

export interface DebugBrief {
  version: 2;
  category: DebugFailureCategory;
  summary: string;
  primaryError: string;
  debugDemand: string;
  failedTests: string[];
  files: string[];
  toolFailures: string[];
  statusCodes: string[];
  evidence: string[];
  omittedEvidenceLines: number;
}

export interface DebugBriefInput {
  reason?: string;
  failureLog?: string;
  phase?: Phase;
  targetPhase?: Phase;
  typedFailure?: {
    category: 'llm-provider' | 'tool' | 'test' | 'quality' | 'contract' | 'internal';
    code: string;
    statusCode?: number;
  };
}

const MAX_EVIDENCE = 8;
const MAX_EVIDENCE_LINE = 260;
const MAX_TOOL_FAILURES = 6;

/**
 * The tools whose failures identify a failure. Declared once because `extractToolFailures` selects
 * the lines and `toolFailureIdentity` names them: two lists would drift, and a tool missing from
 * the second silently collapses to `tool:` for every failure it produces.
 */
const TOOL_NAME_PATTERN =
  /\b(run_tests|run_program|write_file|replace_in_file|apply_patch|append_file|http_fetch|add_dependency|read_file)\b/u;
const MAX_FAILED_TESTS = 8;
const MAX_FILES = 10;

export function buildDebugBrief(input: DebugBriefInput): DebugBrief {
  const reason = oneLine(input.reason ?? '');
  const raw = `${reason}\n${input.failureLog ?? ''}`.trim();
  const sections = splitFailureSections(raw);
  const rootSignals = extractSignals(sections.root || raw);
  const latestSignals = sections.latest ? extractSignals(sections.latest) : undefined;
  const chosen = choosePrimarySignals(rootSignals, latestSignals);
  const category = input.typedFailure
    ? typedFailureCategory(input.typedFailure)
    : chosen.category;
  const primaryError = chosen.primaryError || reason || 'Unknown failure';
  const failedTests = dedup([...(rootSignals.failedTests ?? []), ...(latestSignals?.failedTests ?? [])]).slice(0, MAX_FAILED_TESTS);
  const files = dedup([...(rootSignals.files ?? []), ...(latestSignals?.files ?? [])]).slice(0, MAX_FILES);
  const toolFailures = dedup([...(rootSignals.toolFailures ?? []), ...(latestSignals?.toolFailures ?? [])]).slice(0, MAX_TOOL_FAILURES);
  const statusCodes = dedup([
    ...(input.typedFailure?.statusCode ? [String(input.typedFailure.statusCode)] : []),
    ...(rootSignals.statusCodes ?? []),
    ...(latestSignals?.statusCodes ?? []),
  ]).slice(0, 6);
  const evidence = selectEvidenceLines(raw, category, primaryError, failedTests, files, toolFailures);
  return {
    version: 2,
    category,
    summary: buildSummary({ category, reason, primaryError, failedTests, files, phase: input.phase, targetPhase: input.targetPhase }),
    primaryError,
    debugDemand: buildDebugDemand(category, input.targetPhase ?? input.phase, statusCodes),
    failedTests,
    files,
    toolFailures,
    statusCodes,
    evidence: evidence.lines,
    omittedEvidenceLines: evidence.omitted,
  };
}

function typedFailureCategory(failure: NonNullable<DebugBriefInput['typedFailure']>): DebugFailureCategory {
  if (failure.category === 'llm-provider') return 'llm_provider';
  if (failure.category === 'test') return 'test_failure';
  if (failure.code.includes('permission')) return 'permission_denied';
  if (failure.code.includes('missing_output')) return 'missing_output';
  if (failure.code.includes('dependency')) return 'dependency_error';
  if (failure.code.includes('network') || failure.code.includes('http')) return 'network_api_failure';
  if (failure.code.includes('loop')) return 'tool_loop';
  return 'exception';
}

export function renderDebugBriefForPrompt(brief: DebugBrief): string {
  const lines = [
    '## debug brief',
    `- category: ${brief.category}`,
    `- summary: ${brief.summary}`,
    `- primaryError: ${brief.primaryError}`,
    `- debugDemand: ${brief.debugDemand}`,
  ];
  if (brief.failedTests.length > 0) lines.push(`- failedTests: ${brief.failedTests.join(', ')}`);
  if (brief.files.length > 0) lines.push(`- likelyFiles: ${brief.files.join(', ')}`);
  if (brief.toolFailures.length > 0) lines.push(`- toolFailures: ${brief.toolFailures.join(' | ')}`);
  if (brief.statusCodes.length > 0) lines.push(`- httpStatus: ${brief.statusCodes.join(', ')}`);
  if (brief.evidence.length > 0) {
    lines.push('- keyEvidence:');
    for (const line of brief.evidence) lines.push(`  - ${line}`);
  }
  if (brief.omittedEvidenceLines > 0) {
    lines.push(`- omittedEvidenceLines: ${brief.omittedEvidenceLines}`);
  }
  return lines.join('\n');
}

export function compactFailureEvidence(input: DebugBriefInput & { maxChars?: number; maxLines?: number }): string {
  const maxChars = input.maxChars ?? 2400;
  const maxLines = input.maxLines ?? 50;
  const reason = shouldSuppressReasonInEvidence(input.reason, input.failureLog)
    ? ''
    : (input.reason ?? '');
  const raw = `${reason}\n${input.failureLog ?? ''}`.trim();
  if (!raw) return '';
  const brief = buildDebugBrief({ ...input, reason });
  const important = selectEvidenceLines(
    raw,
    brief.category,
    brief.primaryError,
    brief.failedTests,
    brief.files,
    brief.toolFailures,
    Math.min(MAX_EVIDENCE + 4, 12),
  ).lines;
  const tail = raw
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-Math.max(10, Math.floor(maxLines / 2)))
    .map((line) => truncateLine(line, 320));
  const lines = dedup([...important, ...tail]).slice(-maxLines);
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;
  const head = joined.slice(0, Math.floor(maxChars * 0.45));
  const tailText = joined.slice(-Math.floor(maxChars * 0.45));
  return `${head}\n... [debug evidence truncated ${joined.length - head.length - tailText.length} chars]\n${tailText}`;
}

interface ExtractedSignals {
  category: DebugFailureCategory;
  primaryError: string;
  failedTests: string[];
  files: string[];
  toolFailures: string[];
  statusCodes: string[];
}

function splitFailureSections(text: string): { root: string; latest?: string } {
  const marker = /\n##\s+latest Debugger attempt failure\b/u.exec(text);
  if (!marker) return { root: text };
  return {
    root: text.slice(0, marker.index).trim(),
    latest: text.slice(marker.index + 1).trim(),
  };
}

function choosePrimarySignals(root: ExtractedSignals, latest?: ExtractedSignals): ExtractedSignals {
  if (!latest) return root;
  if (isProcessNoise(latest.category) && !isProcessNoise(root.category)) return root;
  if (latest.category !== 'unknown') return latest;
  return root.category !== 'unknown' ? root : latest;
}

function extractSignals(text: string): ExtractedSignals {
  const lines = normalizedLines(text);
  const failedTests = extractFailedTests(text);
  const files = extractFiles(text);
  const toolFailures = extractToolFailures(lines);
  const statusCodes = extractStatusCodes(text);
  const category = classify(text, lines, failedTests, toolFailures);
  return {
    category,
    primaryError: findPrimaryError(text, lines, category, failedTests, toolFailures),
    failedTests,
    files,
    toolFailures,
    statusCodes,
  };
}

function classify(
  text: string,
  lines: string[],
  failedTests: string[],
  toolFailures: string[],
): DebugFailureCategory {
  const lower = text.toLowerCase();
  if (
    /write\/progress actions did not reduce missing outputs|missing (?:required )?outputs?\s*[:：]/u.test(lower)
  ) {
    return 'missing_output';
  }
  if (/permission denied/u.test(lower)) return 'permission_denied';
  if (/modulenotfounderror|importerror/u.test(lower)) return 'import_error';
  if (/could not find a version|no matching distribution|pip install|add_dependency/u.test(lower)) return 'dependency_error';
  if (/syntaxerror|indentationerror|taberror/u.test(lower)) return 'syntax_error';
  if (/outputs? (?:still )?missing|missing (?:required )?outputs?|outputs? \S*缺失|仍缺失/u.test(lower)) return 'missing_output';
  // A runner that cannot find the test file is reporting unwritten work, not a failing test. Both
  // runners say so in their own words — pytest exits 4 with `file or directory not found`, vitest
  // reports `No test files found` — and both used to fall through to the `pytest exit=[1-9]` catch
  // below, which answers with "fix the root implementation defect… do not rewrite fixtures". That
  // sends the one repair that cannot apply: the implementation was fine and the files did not exist.
  // A live dbc3 CODE Step burned ten rounds on it while owing five declared outputs.
  // pytest exit=4 is the usage error itself, and the explanatory line is often trimmed out of a
  // truncated log, so the exit code has to count on its own — 39 real failures across three runs
  // carried the code without the sentence and were classified as ordinary test failures.
  if (
    /file or directory not found|no test files found|includes no test files|pytest exit=\s*4\b/u.test(lower)
  ) {
    return 'missing_output';
  }

  // Assertion/test identities are root-cause evidence. Provider retry messages and
  // URLs commonly appear later in accumulated logs and must not replace them.
  if (
    failedTests.length > 0 ||
    /assertionerror|expected[^\n]{0,120}(?:to be|to equal|got)|did not raise/u.test(lower)
  ) {
    return 'test_failure';
  }

  if (hasExplicitLLMProviderFailure(lower)) return 'llm_provider';

  if (hasConcreteNetworkFailure(lower)) return 'network_api_failure';

  if (
    /pytest exit=\s*[1-9]|tests? exit=\s*[1-9]|test gate|测试门禁|vitest|assertionerror|failed tests?|test failures?|(?:unit|integration|module|functional|gate) regression failed/u.test(lower)
  ) {
    return 'test_failure';
  }
  if (
    /\berror ts\d{4}\b/u.test(lower) ||
    /\b(?:tsc|compileall)\b[^\n]*(?:exit\s*=\s*[1-9]|failed|失败)/u.test(lower)
  ) {
    return 'exception';
  }
  if (/openai|ollama|openrouter|llm provider|provider_call_failed|all llm providers failed|prefill_memory_exceeded|context window|token limit|prompt too long/u.test(lower)) {
    return 'llm_provider';
  }
  if (/repeated read-only\/probe actions|read-only recovery mode|low-quality debugger response/u.test(lower)) {
    return 'tool_loop';
  }
  if (toolFailures.length > 0) return 'exception';
  if (lines.some((line) => /error|exception|traceback|failed/i.test(line))) return 'exception';
  return 'unknown';
}

function hasExplicitLLMProviderFailure(lower: string): boolean {
  // The availability probe names a role and a configured provider, and its failure text is a bare
  // `fetch failed` — which `hasConcreteNetworkFailure` below claims first. That sent our own outage
  // to `network_api_failure`, whose demand tells the *generated project* to switch to a public
  // no-key API and verify the integration: a rewrite of working code to repair something that was
  // never broken. Live runs produced this text while no project request had been made at all.
  if (/\b\w+ availability check failed for\b/u.test(lower)) return true;
  if (/reasoning chars but no content|stream sent no response headers/u.test(lower)) return true;
  // Anchored to the whole message on purpose. A bare `TypeError: fetch failed` with nothing else is
  // undici reporting our own request; the same words inside a longer log usually belong to a request
  // the generated project made, and claiming those would suppress a real project defect.
  if (/^\s*typeerror:\s*fetch failed\s*$/u.test(lower)) return true;
  // `OpenAI HTTP <code>` is the prefix our own client puts on a provider response. A rate limit or a
  // capability rejection carrying it is the provider's, whatever status code it wraps — the project
  // never produces this shape, and reading it as the project's API sends the one repair that cannot
  // apply: switching an endpoint the project does not call.
  if (/openai http\s*\d{3}/u.test(lower)) return true;
  return /all llm providers failed|openai-compatible provider request failed|provider_call_failed|llm provider|prefill_memory_exceeded|context window|token limit|prompt too long|openai stream (?:wall-clock|idle)|provider=\S+[^\n]*model=\S+[^\n]*base_url=/u.test(lower);
}

function hasConcreteNetworkFailure(lower: string): boolean {
  return lower.split(/\r?\n/u).some((line) => {
    if (isLoopbackNetworkFailureLine(line)) return false;
    if (/^network api failure detected(?:\.|$)/u.test(line.trim())) return false;
    return /http_fetch[^\n]*(?:失败|failed|error|http\s*(?:401|403|404|408|409|410|422|429|5\d\d)|timed out|timeout)/u.test(line) ||
      /(?:fetch|axios|http request|network request)[^\n]*(?:econnrefused|econnreset|enotfound|etimedout|socket hang up|失败|failed|timed out|timeout)/u.test(line) ||
      /\bhttp\s*(?:status\s*)?(?:401|403|404|408|409|410|422|429|5\d\d)\b/u.test(line);
  });
}

/**
 * The reason the runner printed beside the failing case, when it printed one.
 *
 * `primaryError` is a structured field, so it survives when the evidence block is trimmed to fit the
 * context budget — and the reason is the half that says what to fix. Returning the case name alone
 * hands the model the question without the symptom: a live Debugger received
 * `failed test: ...::test_writes_signal_data` for 26 attempts while `assert None == ''` sat only in
 * the compact-evidence block, which the budget dropped every time. It knew which test failed and
 * never learned why, so it kept re-applying the fix named in the Ticket that opened the loop.
 */
function failureReasonFor(testId: string, text: string): string | undefined {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const summary = new RegExp(`FAILED[ \\t]+${escaped}[ \\t]*[-—][ \\t]*([^\\n]+)`, 'u').exec(text);
  const reason = oneLine(summary?.[1] ?? '');
  return reason.length > 0 ? reason : undefined;
}

function findPrimaryError(
  text: string,
  lines: string[],
  category: DebugFailureCategory,
  failedTests: string[],
  toolFailures: string[],
): string {
  if (failedTests.length > 0 && category === 'test_failure') {
    const reason = failureReasonFor(failedTests[0]!, text);
    return reason ? `failed test: ${failedTests[0]}: ${reason}` : `failed test: ${failedTests[0]}`;
  }
  const compilerError = text.match(/[^\n]*\berror TS\d{4}:[^\n]+/u)?.[0];
  if (compilerError) return oneLine(compilerError);
  if (toolFailures.length > 0 && (category === 'tool_loop' || category === 'exception')) return toolFailures[0]!;
  const categoryPatterns: Partial<Record<DebugFailureCategory, RegExp[]>> = {
    test_failure: [
      /(?:AssertionError|TypeError|Error):[^\n]+/u,
      /\bFAIL(?:ED)?\s+[^\n]+/u,
      /\b(?:pytest|vitest)[^\n]*(?:exit|failed|FAIL)[^\n]*/iu,
      /Test timed out[^\n]*/iu,
    ],
    network_api_failure: [
      /\bHTTP\s+(?:401|403|404|408|409|410|422|429|5\d\d)[^\n]*/iu,
      /Network API failure detected[^\n]*/iu,
    ],
    missing_output: [
      /missing (?:required )?outputs?[^\n]*/iu,
      /outputs?[^\n]*(?:missing|缺失|仍缺失)[^\n]*/iu,
    ],
    tool_loop: [/repeated read-only\/probe actions[^\n]*/iu],
  };
  const genericPatterns: RegExp[] = [
    /[^\n]*\berror TS\d{4}:[^\n]+/u,
    /(?:SyntaxError|IndentationError|TabError|ModuleNotFoundError|ImportError|AssertionError|TypeError|ValueError|FileNotFoundError|AttributeError|RuntimeError):[^\n]+/u,
    /\bFAILED\s+[^\n]+/u,
    /\b(?:pytest|vitest)[^\n]*(?:exit|failed|FAIL)[^\n]*/iu,
    /missing (?:required )?outputs?[^\n]*/iu,
    /outputs?[^\n]*(?:missing|缺失|仍缺失)[^\n]*/iu,
    /repeated read-only\/probe actions[^\n]*/iu,
  ];
  for (const pattern of [...(categoryPatterns[category] ?? []), ...genericPatterns]) {
    const match = text.match(pattern)?.[0];
    if (match) return oneLine(match);
  }
  const lastMeaningful = [...lines].reverse().find((line) => /error|exception|failed|exit=\s*[1-9]|缺失/i.test(line));
  return oneLine(lastMeaningful ?? lines.at(-1) ?? 'Unknown failure');
}

function buildSummary(args: {
  category: DebugFailureCategory;
  reason: string;
  primaryError: string;
  failedTests: string[];
  files: string[];
  phase?: Phase;
  targetPhase?: Phase;
}): string {
  const scope = args.targetPhase || args.phase ? ` in ${args.targetPhase ?? args.phase}` : '';
  if (args.failedTests.length > 0) return `${args.category}${scope}: ${args.failedTests[0]} failed`;
  if (args.files.length > 0) return `${args.category}${scope}: ${args.primaryError} (${args.files[0]})`;
  return `${args.category}${scope}: ${args.primaryError || args.reason || 'failure'}`;
}

function buildDebugDemand(category: DebugFailureCategory, phase?: Phase, statusCodes: string[] = []): string {
  const phaseHint = phase ? ` for ${phase}` : '';
  switch (category) {
    case 'test_failure':
      return `Fix the root implementation/contract defect${phaseHint}, then run the smallest relevant test command before done=true. Do not rewrite fixtures unless evidence says the fixture is missing or malformed.`;
    case 'syntax_error':
      return `Read the referenced file, patch the syntax/indentation at the failing location, then run tests.`;
    case 'import_error':
      return `Resolve the real import/module path or dependency. Do not add fake fallback modules or swallow ImportError in production code.`;
    case 'dependency_error':
      return `Replace hallucinated dependency names with real package names and update the manifest via add_dependency.`;
    case 'network_api_failure':
      return networkDemand(statusCodes);
    case 'missing_output':
      return `Create or repair the declared output files. Do not mark done=true until verify outputs passes.`;
    case 'tool_loop':
      return `Stop repeating read-only/probe actions. Use the current evidence to make a patch/write/dependency change or run a concrete verification command.`;
    case 'permission_denied':
      return `Treat the denied operation as a real blocker unless an allowed alternative exists; do not bypass the permission gate.`;
    case 'llm_provider':
      return `This is LLM provider/context infrastructure, not a project code bug. Restore provider connectivity/configuration or reduce context as indicated, then retry the current Step without modifying generated project code.`;
    case 'exception':
      return `Localize the exception to a file or tool call, make the smallest allowed repair, then verify.`;
    case 'unknown':
      return `Read the most relevant files and produce a concrete diagnosis before making a minimal allowed repair.`;
  }
}

function networkDemand(statusCodes: string[]): string {
  if (statusCodes.some((code) => code === '401' || code === '403')) {
    return 'The API is unauthorized/forbidden. If no user key/token is available, switch to a public no-key API and verify the real integration.';
  }
  if (statusCodes.some((code) => code === '404' || code === '410')) {
    return 'The API URL/resource is unavailable. Stop retrying the same URL; switch to a maintained endpoint and verify response shape.';
  }
  if (statusCodes.includes('429')) {
    return 'The API is rate-limited. Switch to a suitable fallback API or implement explicit retry/cache behaviour and tests.';
  }
  if (statusCodes.some((code) => /^5/u.test(code))) {
    return 'The API server failed. Use a stable fallback endpoint or fail closed with a clear user-visible error path.';
  }
  return 'Locate the failing URL/status/body, patch the real API integration, and verify with run_program plus tests. Do not hide the API failure.';
}

function isProcessNoise(category: DebugFailureCategory): boolean {
  return ['tool_loop', 'llm_provider', 'permission_denied', 'exception'].includes(category);
}

function shouldSuppressReasonInEvidence(reason?: string, failureLog?: string): boolean {
  if (!reason || !failureLog?.trim()) return false;
  const lowerReason = reason.toLowerCase();
  const lowerLog = failureLog.toLowerCase();
  const hasRootSignal =
    /pytest exit=\s*[1-9]|tests? exit=\s*[1-9]|test gate|测试门禁|failed\s+(?:tests?|src)\/|assertionerror|syntaxerror|modulenotfounderror|importerror|network api failure|http\s+(?:401|403|404|408|409|410|422|429|5\d\d)|outputs?.*(?:missing|缺失|仍缺失)/u.test(lowerLog);
  if (!hasRootSignal) return false;
  return /script exhausted|completed phase debug finished without|repeated read-only\/probe actions|read-only recovery mode|low-quality debugger response|openai http (?:400|401|403|408|409|429|5\d\d)|rate limit exceeded|free-models-per-day|stream (?:wall-clock|idle)|request timed out|provider_call_failed|all llm providers failed/u.test(lowerReason);
}

/**
 * Whether a line reports a test failing, as opposed to merely naming a test.
 *
 * The bare-id pattern below matches a test id wherever it appears, and `pytest -v` prints the id
 * followed by the case's own stdout on the same line:
 *
 *   tests/a.py::TestB::test_c Successfully wrote 1 signals to /tmp/...
 *
 * The outcome word is not on that line at all, so excluding lines that say PASSED cannot work —
 * program output is arbitrary, and a negative filter can only remove the shapes it anticipated.
 * Requiring a positive failure marker is the rule that holds. A live Ticket harvested five passing
 * cases through this gap; they entered the failure signature, made an otherwise identical failure
 * look new, and cost the recurrence guard four extra attempts before it fired.
 *
 * A line consisting of nothing but the id is kept: that is how summary sections list failures.
 */
const FAILURE_MARKER = /\b(?:FAILED|ERROR|FAIL)\b|[×✗]/u;
const TEST_ID_ALONE = /^[^\s]+(?:\.py|\.ts|\.tsx|\.js|\.jsx)::[A-Za-z0-9_:[\].-]+$/u;

function namesFailingTest(line: string): boolean {
  return FAILURE_MARKER.test(line) || TEST_ID_ALONE.test(line.trim());
}

function extractFailedTests(text: string): string[] {
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    const line = oneLine(value ?? '');
    if (line) out.push(line);
  };
  // `[ \t]` rather than `\s`: `pytest -v` ends a line with the outcome and starts the next with the
  // following case's id, so `\s` lets FAILED bind across the newline to a test that passed.
  for (const match of text.matchAll(/\bFAILED[ \t]+([^\s]+(?:\.py|\.ts|\.tsx|\.js|\.jsx)(?:::[^\s]+)?)/gu)) {
    push(match[1]);
  }
  // Bare ids only from lines that report a failure; see FAILURE_MARKER.
  for (const line of text.split(/\r?\n/u)) {
    if (!namesFailingTest(line)) continue;
    for (const match of line.matchAll(/([^\s]+(?:\.py|\.ts|\.tsx|\.js|\.jsx)::[A-Za-z0-9_:[\].-]+)/gu)) {
      push(match[1]);
    }
  }
  for (const pattern of [
    /(?:^|\n)\s*(?:FAIL|❯)\s+([^\n]+?(?:\.py|\.ts|\.tsx|\.js|\.jsx)\s+>\s+[^\n]+)/gu,
    /[×x]\s+([^\n]+?>\s+[^\n]+)/gu,
  ]) {
    for (const match of text.matchAll(pattern)) push(match[1]);
  }
  return dedup(out);
}

function extractFiles(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    // Any extension, not a list of them. The precision here comes from the `src|tests|docs` prefix,
    // which is XCompiler's own layout; the suffix only has to look like a file. The list this
    // replaces had drifted to `dbc` and `xlsx` — formats from one past project — which is the shape
    // of the problem: every project whose data format is absent loses file extraction entirely, and
    // `files` feeds both the brief the Debugger reads and the fingerprints the wiki ranks on.
    /\b((?:src|tests?|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})\b/gu,
    /File\s+["']([^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const file = normalizePath(match[1] ?? '');
      if (file && !file.includes('node_modules/')) out.push(file);
    }
  }
  return dedup(out);
}

function extractToolFailures(lines: string[]): string[] {
  return lines
    .filter((line) => /(?:\b(?:FAIL|failed|denied|exit=[1-9]|Error:)|失败)/iu.test(line))
    .filter((line) => TOOL_NAME_PATTERN.test(line))
    .map((line) => oneLine(line))
    .slice(0, MAX_TOOL_FAILURES);
}

function extractStatusCodes(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bHTTP\s*(?:status\s*)?(401|403|404|408|409|410|422|429|5\d\d)\b/giu,
    /\bstatus(?:\s*code)?\s*[=:]?\s*(401|403|404|408|409|410|422|429|5\d\d)\b/giu,
    /\b(?:api|request|fetch|接口|请求)\b[^\n]{0,80}\b(401|403|404|408|409|410|422|429|5\d\d)\b/giu,
    /\b(401|403|404|408|409|410|422|429|5\d\d)\b[^\n]{0,80}\b(?:api|request|fetch|接口|请求)\b/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) out.push(match[1]!);
  }
  return dedup(out);
}

function selectEvidenceLines(
  text: string,
  category: DebugFailureCategory,
  primaryError: string,
  failedTests: string[],
  files: string[],
  toolFailures: string[],
  maxEvidence = MAX_EVIDENCE,
): { lines: string[]; omitted: number } {
  const lines = normalizedLines(text);
  const needles = [
    primaryError,
    ...failedTests,
    ...files,
    ...toolFailures,
    category === 'network_api_failure' ? 'http' : '',
    category === 'missing_output' ? 'missing' : '',
    category === 'tool_loop' ? 'read-only' : '',
  ]
    .map((item) => item.toLowerCase())
    .filter(Boolean);
  const selected: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      needles.some((needle) => lower.includes(needle.slice(0, 80))) ||
      /\b(?:FAILED|Traceback|Error|Exception|AssertionError|SyntaxError|ModuleNotFoundError|pytest exit=|HTTP\s*[45]\d\d|outputs?.*missing)\b/iu.test(line) ||
      /失败/u.test(line)
    ) {
      selected.push(truncateLine(line, MAX_EVIDENCE_LINE));
    }
  }
  const compact = dedup(selected).slice(0, maxEvidence);
  return { lines: compact, omitted: Math.max(0, selected.length - compact.length) };
}

function normalizedLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^##\s+历史\s+DEBUG/u.test(line))
    .filter((line) => !/^##\s+修复建议/u.test(line))
    .filter((line) => !/^prior suggestions:/iu.test(line));
}

function oneLine(text: string): string {
  return truncateLine(text.replace(/\s+/gu, ' ').trim(), MAX_EVIDENCE_LINE);
}

function truncateLine(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 24))}... [truncated ${text.length - max + 24} chars]`;
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^.*?((?:src|tests?|docs)\/)/u, '$1');
}

/**
 * Stable identity of a failure, for the recurrence guard that decides whether corrective work is
 * converging.
 *
 * The inputs deliberately exclude how the attempt happened to invoke its tools. A `toolFailures`
 * line carries the whole command — `run_tests: pytest exit=1 args=tests/a.py tests/b.py -v` — so an
 * attempt that swaps `-v` for `--tb=short`, or makes five tool calls where the last one made two,
 * hashes differently for the identical failure. The guard reads that as "evidence is still
 * changing" and grants another extension, which is the one outcome it exists to prevent: a live
 * Ticket reached twelve attempts on ten consecutive identical pytest results (2 failed / 35 passed,
 * the same two cases) because nine recorded failures produced seven distinct signatures.
 *
 * What survives is what a person would name when asked which failure this is — the category, the
 * structured code, which tests failed, and which tool failed how. Never the argv that got there.
 */
export function buildFailureSignature(brief: DebugBrief, structuredCode?: string): string {
  return createHash('sha256').update(JSON.stringify({
    category: brief.category,
    primaryError: withoutRunVaryingTokens(stableErrorText(brief.primaryError, brief.toolFailures)),
    failedTests: [...brief.failedTests].sort(),
    // Failed test selectors already identify a test failure's target. Verbose runners mention files
    // from passing cases too, so adding every extracted file would make the same failed selector
    // acquire a different identity under `-v`. Non-test failures still need files to distinguish,
    // for example, identical write errors against two different targets.
    files: brief.failedTests.length > 0
      ? []
      : dedup(brief.files.map((file) => withoutRunVaryingTokens(normalizePath(file)))).sort(),
    toolFailures: dedup(brief.toolFailures.map(toolFailureIdentity)).sort(),
    structuredCode,
  })).digest('hex');
}

/**
 * Drop the tokens a rerun changes on its own.
 *
 * `primaryError` carries the reason the runner printed, which is what the repair needs to read — and
 * for a filesystem error that reason is a path. pytest re-numbers its temporary directory every run
 * (`pytest-of-ddk/pytest-0`, `pytest-1`, …), so six identical failures produced five distinct
 * signatures on a live Ticket and the recurrence guard never saw a repeat. Object reprs carry an
 * address for the same reason.
 *
 * Only the identity is normalized. The prompt keeps the concrete path, because the concrete path is
 * what a person would look at first.
 */
function withoutRunVaryingTokens(text: string): string {
  return text
    .replace(/\bpytest-\d+\b/gu, 'pytest-<run>')
    .replace(/0x[0-9a-f]{6,}/giu, '0x<addr>');
}

/** Which tool failed, and how — with the arguments that vary between attempts dropped. */
function toolFailureIdentity(line: string): string {
  const tool = TOOL_NAME_PATTERN.exec(line)?.[1] ?? 'tool';
  const exit = /\bexit=(\d+)/u.exec(line)?.[1];
  if (exit !== undefined) return `${tool}:exit=${exit}`;
  if (/\bdenied\b/iu.test(line)) return `${tool}:denied`;
  if (/\btimed?[ _-]?out\b/iu.test(line)) return `${tool}:timeout`;
  return `${tool}:failed`;
}

/**
 * `findPrimaryError` returns a tool-failure line verbatim for the tool_loop and exception
 * categories, which would put the argv back into the signature through a second door.
 */
function stableErrorText(primaryError: string, toolFailures: string[]): string {
  return toolFailures.includes(primaryError) ? toolFailureIdentity(primaryError) : primaryError;
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items.filter((item) => String(item ?? '').length > 0))];
}
