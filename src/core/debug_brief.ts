import type { Phase } from './plan.js';
import { isLoopbackNetworkFailureLine } from './network_api_gate.js';

export type DebugFailureCategory = 'test_failure' | 'syntax_error' | 'import_error' | 'dependency_error' |
  'network_api_failure' | 'missing_output' | 'tool_loop' | 'permission_denied' | 'llm_provider' | 'exception' | 'unknown';

export interface DebugBrief {
  version: 1;
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
}

const MAX_EVIDENCE = 8;
const MAX_EVIDENCE_LINE = 260;
const MAX_TOOL_FAILURES = 6;
const MAX_FAILED_TESTS = 8;
const MAX_FILES = 10;

export function buildDebugBrief(input: DebugBriefInput): DebugBrief {
  const reason = oneLine(input.reason ?? '');
  const raw = `${reason}\n${input.failureLog ?? ''}`.trim();
  const sections = splitFailureSections(raw);
  const rootSignals = extractSignals(sections.root || raw);
  const latestSignals = sections.latest ? extractSignals(sections.latest) : undefined;
  const chosen = choosePrimarySignals(rootSignals, latestSignals);
  const category = chosen.category;
  const primaryError = chosen.primaryError || reason || 'Unknown failure';
  const failedTests = dedup([...(rootSignals.failedTests ?? []), ...(latestSignals?.failedTests ?? [])]).slice(0, MAX_FAILED_TESTS);
  const files = dedup([...(rootSignals.files ?? []), ...(latestSignals?.files ?? [])]).slice(0, MAX_FILES);
  const toolFailures = dedup([...(rootSignals.toolFailures ?? []), ...(latestSignals?.toolFailures ?? [])]).slice(0, MAX_TOOL_FAILURES);
  const statusCodes = dedup([...(rootSignals.statusCodes ?? []), ...(latestSignals?.statusCodes ?? [])]).slice(0, 6);
  const evidence = selectEvidenceLines(raw, category, primaryError, failedTests, files, toolFailures);
  return {
    version: 1,
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

  // Assertion/test identities are root-cause evidence. Provider retry messages and
  // URLs commonly appear later in accumulated logs and must not replace them.
  if (
    failedTests.length > 0 ||
    /assertionerror|expected[^\n]{0,120}(?:to be|to equal|got)|did not raise/u.test(lower)
  ) {
    return 'test_failure';
  }

  if (hasConcreteNetworkFailure(lower)) return 'network_api_failure';

  if (
    /pytest exit=\s*[1-9]|tests? exit=\s*[1-9]|test gate|测试门禁|vitest|assertionerror|failed tests?|test failures?|(?:unit|integration|module|functional|gate) regression failed/u.test(lower)
  ) {
    return 'test_failure';
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

function hasConcreteNetworkFailure(lower: string): boolean {
  return lower.split(/\r?\n/u).some((line) => {
    if (isLoopbackNetworkFailureLine(line)) return false;
    if (/^network api failure detected(?:\.|$)/u.test(line.trim())) return false;
    return /http_fetch[^\n]*(?:失败|failed|error|http\s*(?:401|403|404|408|409|410|422|429|5\d\d)|timed out|timeout)/u.test(line) ||
      /(?:fetch|axios|http request|network request)[^\n]*(?:econnrefused|econnreset|enotfound|etimedout|socket hang up|失败|failed|timed out|timeout)/u.test(line) ||
      /\bhttp\s*(?:status\s*)?(?:401|403|404|408|409|410|422|429|5\d\d)\b/u.test(line);
  });
}

function findPrimaryError(
  text: string,
  lines: string[],
  category: DebugFailureCategory,
  failedTests: string[],
  toolFailures: string[],
): string {
  if (failedTests.length > 0 && category === 'test_failure') return `failed test: ${failedTests[0]}`;
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
      return `This is provider/context infrastructure, not a project code bug. Reduce prompt/debug context or fix provider config before retrying.`;
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

function extractFailedTests(text: string): string[] {
  const patterns = [
    /\bFAILED\s+([^\s]+(?:\.py|\.ts|\.tsx|\.js|\.jsx)(?:::[^\s]+)?)/gu,
    /([^\s]+(?:\.py|\.ts|\.tsx|\.js|\.jsx)::[A-Za-z0-9_:[\].-]+)/gu,
    /(?:^|\n)\s*(?:FAIL|❯)\s+([^\n]+?(?:\.py|\.ts|\.tsx|\.js|\.jsx)\s+>\s+[^\n]+)/gu,
    /[×x]\s+([^\n]+?>\s+[^\n]+)/gu,
  ];
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = oneLine(match[1] ?? '');
      if (value) out.push(value);
    }
  }
  return dedup(out);
}

function extractFiles(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b((?:src|tests?|docs)\/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx|json|md|dbc|csv|xlsx?))/gu,
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
    .filter((line) => /\b(?:run_tests|run_program|write_file|replace_in_file|apply_patch|append_file|http_fetch|add_dependency|read_file)\b/u.test(line))
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

function dedup<T>(items: T[]): T[] {
  return [...new Set(items.filter((item) => String(item ?? '').length > 0))];
}
