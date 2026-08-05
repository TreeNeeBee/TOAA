import type {
  ClarifyOption,
  ClarifyQuestion,
  PlannerInput,
} from '../../agents/planner.js';
import { isIncrementalIntent } from '../../core/incremental.js';
import type { Language, PlanIntent } from '../../core/plan.js';
import { t } from '../../i18n/index.js';

export function formatClarificationQuestion(question: ClarifyQuestion): string {
  const choiceRange = formatClarificationChoiceRange(question.options);
  const lines = [
    `${question.id} [${question.category}] ${question.question}`,
    `  ↳ ${question.why}`,
  ];
  for (const option of question.options) lines.push(`  ${option.label}. ${option.answer}`);
  lines.push(`  ${t().compile.clarifyChoiceHint(choiceRange)}`);
  return lines.join('\n');
}

export function resolveClarificationAnswer(question: ClarifyQuestion, rawAnswer: string): string {
  const answer = rawAnswer.trim();
  const label = answer.toUpperCase();
  if (/^[A-E]$/u.test(label)) {
    const option = question.options.find((candidate) => candidate.label === label);
    if (option) return `${option.label}. ${option.answer}`;
  }
  return answer;
}

export interface CompileLanguageResolutionInput {
  rawRequirement: string;
  clarifications?: PlannerInput['clarifications'];
  userAddenda?: string;
  intent?: PlanIntent;
  baseline?: { language?: Language; languageSource?: string; summary?: string };
}

export interface CompileLanguageResolution {
  language: Language;
  source: 'baseline' | 'topic' | 'clarification' | 'default';
  ambiguous: boolean;
}

export function resolveCompileLanguage(
  configuredLanguage: Language,
  intent: PlanIntent,
  baseline: { language?: Language },
): Language;
export function resolveCompileLanguage(input: CompileLanguageResolutionInput): CompileLanguageResolution;
export function resolveCompileLanguage(
  inputOrConfigured: CompileLanguageResolutionInput | Language,
  intent?: PlanIntent,
  baseline?: { language?: Language },
): CompileLanguageResolution | Language {
  if (typeof inputOrConfigured === 'string') {
    return isIncrementalIntent(intent ?? 'greenfield')
      ? baseline?.language ?? inputOrConfigured
      : inputOrConfigured;
  }
  const input = inputOrConfigured;
  if (isIncrementalIntent(input.intent ?? 'greenfield') && input.baseline?.language) {
    return { language: input.baseline.language, source: 'baseline', ambiguous: false };
  }
  const topicInferred = inferCompileLanguageFromText(input.rawRequirement);
  if (topicInferred) return { language: topicInferred, source: 'topic', ambiguous: false };
  const clarifiedInferred = inferCompileLanguageFromText([
    formatLanguageClarificationText(input.clarifications ?? []),
    input.userAddenda ?? '',
  ].join('\n'));
  if (clarifiedInferred) {
    return { language: clarifiedInferred, source: 'clarification', ambiguous: false };
  }
  return { language: 'python', source: 'default', ambiguous: true };
}

export function inferCompileLanguageFromText(text: string): Language | undefined {
  const normalized = text
    .toLowerCase()
    .replace(/[，。；：、（）【】]/gu, ' ')
    .replace(/\s+/gu, ' ');
  const pythonStrong =
    /\bpython\b/u.test(normalized) ||
    /python\s*脚本/u.test(normalized) ||
    /\.py\b/u.test(normalized) ||
    /\bpytest\b/u.test(normalized) ||
    /\bpip\b/u.test(normalized);
  const typescriptStrong =
    /\btypescript\b/u.test(normalized) ||
    /\btype\s*script\b/u.test(normalized) ||
    /(^|[^a-z0-9])ts\s*(程序|工程|项目|脚本|语言|实现)/u.test(normalized) ||
    /\.tsx?\b/u.test(normalized) ||
    /\btsx\b/u.test(normalized);
  if (pythonStrong && !typescriptStrong) return 'python';
  if (typescriptStrong && !pythonStrong) return 'typescript';
  const pythonWeak =
    /\bopenpyxl\b/u.test(normalized) ||
    /\bpandas\b/u.test(normalized) ||
    /\bfastapi\b/u.test(normalized) ||
    /\bflask\b/u.test(normalized);
  const typescriptWeak =
    /\bnode(?:\.js)?\b/u.test(normalized) ||
    /\bnpm\b/u.test(normalized) ||
    /\bvitest\b/u.test(normalized) ||
    /\bpackage\.json\b/u.test(normalized) ||
    /\bjavascript\b/u.test(normalized) ||
    /\bjs\s*(程序|工程|项目|脚本|语言|实现)\b/u.test(normalized);
  if ((pythonStrong || pythonWeak) && !(typescriptStrong || typescriptWeak)) return 'python';
  if ((typescriptStrong || typescriptWeak) && !(pythonStrong || pythonWeak)) return 'typescript';
  return undefined;
}

function formatClarificationChoiceRange(options: ClarifyOption[]): string {
  if (options.length === 0) return 'A-E';
  const first = options[0]?.label ?? 'A';
  const last = options[options.length - 1]?.label ?? first;
  return first === last ? first : `${first}-${last}`;
}

function formatLanguageClarificationText(input: PlannerInput['clarifications']): string {
  return input.map((item) => [
    item.question,
    item.answer,
    item.why ?? '',
    ...(item.options ?? []).map((option) => option.answer),
  ].join('\n')).join('\n\n');
}
