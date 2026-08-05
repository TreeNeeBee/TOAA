import { parsePlannerJson } from './json.js';

export const CLARIFICATION_CATEGORIES = [
  'functionality',
  'data',
  'acceptance',
  'boundary',
  'quality',
  'extensibility',
] as const;
export type ClarificationCategory = (typeof CLARIFICATION_CATEGORIES)[number];

export const CLARIFICATION_OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export type ClarificationOptionLabel = (typeof CLARIFICATION_OPTION_LABELS)[number];

export interface ClarifyOption {
  label: ClarificationOptionLabel;
  answer: string;
}

export interface ClarifyQuestion {
  id: string;
  category: ClarificationCategory;
  question: string;
  why: string;
  options: ClarifyOption[];
}

interface RawClarifyQuestion {
  id?: unknown;
  category?: unknown;
  question?: unknown;
  why?: unknown;
  options?: unknown;
}

export function parseClarifyJson(text: string): ClarifyQuestion[] {
  const raw = coerceClarifyArray(parsePlannerJson(text));
  const seenQuestions = new Set<string>();
  const seenIds = new Set<string>();
  const questions: ClarifyQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    if (!question) continue;
    const dedupKey = normalizeText(question);
    if (seenQuestions.has(dedupKey)) continue;
    seenQuestions.add(dedupKey);
    const candidateId = typeof item.id === 'string' && /^Q\d+$/iu.test(item.id.trim())
      ? item.id.trim().toUpperCase()
      : `Q${index + 1}`;
    let id = candidateId;
    let fallbackNumber = index + 1;
    while (seenIds.has(id)) id = `Q${++fallbackNumber}`;
    seenIds.add(id);
    questions.push({
      id,
      category: parseClarificationCategory(item.category) ?? 'functionality',
      question,
      why: typeof item.why === 'string' ? item.why.trim() : '',
      options: parseClarifyOptions(item.options),
    });
  }
  return questions;
}

export function validateClarifyJson(
  text: string,
  complex: boolean,
  options: {
    projectShapeAmbiguous?: boolean;
    externalApiRequired?: boolean;
    languageAmbiguous?: boolean;
  } = {},
): ClarifyQuestion[] {
  const raw = coerceClarifyArray(parsePlannerJson(text));
  if (raw.length === 0) {
    throw new Error('clarify returned no questions; interactive intake requires a multi-dimensional question set');
  }
  for (const [index, question] of raw.entries()) {
    if (typeof question.question !== 'string' || question.question.trim().length < 6) {
      throw new Error(`clarify question ${index + 1} is missing or too short`);
    }
    if (!parseClarificationCategory(question.category)) {
      throw new Error(`clarify question ${index + 1} is missing a valid category`);
    }
    if (typeof question.why !== 'string' || question.why.trim().length < 4) {
      throw new Error(`clarify question ${index + 1} is missing a concise why field`);
    }
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const parsedOptions = parseClarifyOptions(question.options);
    if (rawOptions.length < 2 || rawOptions.length > 5 || parsedOptions.length !== rawOptions.length) {
      throw new Error(`clarify question ${index + 1} must include 2-5 prioritized answer options`);
    }
  }
  const parsed = parseClarifyJson(text);
  if (parsed.length !== raw.length) {
    throw new Error(`clarify contains duplicate or empty questions (${raw.length} raw, ${parsed.length} unique)`);
  }
  const minQuestions = complex ? 8 : 7;
  if (parsed.length < minQuestions || parsed.length > 10) {
    throw new Error(`clarify expected ${minQuestions}-10 unique questions, got ${parsed.length}`);
  }
  const count = (category: ClarificationCategory): number =>
    parsed.filter((question) => question.category === category).length;
  const functionalCount = count('functionality') + count('data') + count('acceptance');
  const minFunctional = complex ? 5 : 4;
  if (functionalCount < minFunctional) {
    throw new Error(`clarify requires at least ${minFunctional} function-focused questions, got ${functionalCount}`);
  }
  for (const required of ['boundary', 'quality', 'extensibility'] as const) {
    if (count(required) === 0) throw new Error(`clarify missing required ${required} question`);
  }
  if (options.projectShapeAmbiguous && !parsed.some(isProjectShapeClarification)) {
    throw new Error('clarify missing required project shape question: ask whether this should be an API library, runnable application, or mixed deliverable');
  }
  if (options.externalApiRequired && !parsed.some(isExternalApiCredentialClarification)) {
    throw new Error('clarify missing required external API credential question: ask whether the user has an API/key/token; if not, default to open no-key APIs');
  }
  if (options.languageAmbiguous && !parsed.some(isDevelopmentLanguageClarification)) {
    throw new Error('clarify missing required development language question: ask whether the project should use Python or TypeScript/Node.js, with Python as the default option');
  }
  return parsed;
}

export function hasExternalApiOrUrlRequirement(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(external|third[- ]party|provider|remote|public|open)\s+(api|url|endpoint|service)\b/u.test(lower) ||
    /\b(fetch|request|call|consume|access|query)\s+(?:an?\s+)?(?:external|third[- ]party|remote|public|open)\s+(api|url|endpoint|service)\b/u.test(lower) ||
    /\bhttps?:\/\//iu.test(text) ||
    /(?:外部|第三方|公开|开放|远程|联网|网络).{0,12}(?:api|接口|url|地址|服务|数据源)/iu.test(text) ||
    /(?:天气|节假日|假日|地图|汇率|股票|新闻|物流).{0,18}(?:api|接口|查询|获取|请求|调用|数据)/iu.test(text) ||
    /(?:获取|查询|请求|调用).{0,18}(?:天气|节假日|假日|地图|汇率|股票|新闻|物流).{0,18}(?:数据|接口|api)?/iu.test(text)
  );
}

function coerceClarifyArray(data: unknown): RawClarifyQuestion[] {
  if (Array.isArray(data)) return data as RawClarifyQuestion[];
  if (data && typeof data === 'object') {
    const object = data as Record<string, unknown>;
    if (Array.isArray(object.questions)) return object.questions as RawClarifyQuestion[];
    if (Array.isArray(object.items)) return object.items as RawClarifyQuestion[];
    if (typeof object.question === 'string') return [object as RawClarifyQuestion];
  }
  return [];
}

const CATEGORY_ALIASES: Record<string, ClarificationCategory> = {
  functionality: 'functionality', functional: 'functionality', function: 'functionality', feature: 'functionality',
  data: 'data', input: 'data', output: 'data', 'input-output': 'data',
  acceptance: 'acceptance', correctness: 'acceptance', verification: 'acceptance',
  boundary: 'boundary', scope: 'boundary', edge: 'boundary',
  quality: 'quality', performance: 'quality', reliability: 'quality', security: 'quality',
  extensibility: 'extensibility', scalability: 'extensibility', evolution: 'extensibility', extension: 'extensibility',
};

function parseClarificationCategory(value: unknown): ClarificationCategory | undefined {
  return CATEGORY_ALIASES[typeof value === 'string' ? value.trim().toLowerCase() : ''];
}

function parseClarifyOptions(value: unknown): ClarifyOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: ClarifyOption[] = [];
  for (const item of value) {
    const answer = stripOptionLabel(extractOptionAnswer(item)).trim();
    if (!answer || seen.has(normalizeText(answer))) continue;
    seen.add(normalizeText(answer));
    const label = CLARIFICATION_OPTION_LABELS[options.length];
    if (!label) break;
    options.push({ label, answer });
  }
  return options;
}

function extractOptionAnswer(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const object = item as Record<string, unknown>;
  for (const key of ['answer', 'text', 'value', 'setting', 'title', 'label']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key];
  }
  return '';
}

function stripOptionLabel(value: string): string {
  return value.replace(/^\s*[A-Ea-e]\s*[).\]、:：-]\s*/u, '');
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s?？。.!！,，;；:：]+/gu, '');
}

function questionText(question: ClarifyQuestion): string {
  return `${question.question}\n${question.why}\n${question.options.map((option) => option.answer).join('\n')}`.toLowerCase();
}

function isProjectShapeClarification(question: ClarifyQuestion): boolean {
  const text = questionText(question);
  return /api[- ]?library|public api|reusable api|client library|sdk|package|library|runnable app|application|cli|service|mixed/u.test(text) ||
    /api\s*(库|客户端|能力)|公共\s*api|可复用接口|库项目|软件包|开发包|可运行|应用|命令行|服务|混合/u.test(text);
}

function isExternalApiCredentialClarification(question: ClarifyQuestion): boolean {
  const text = questionText(question);
  const asksCredential = /\b(api key|apikey|token|credential|secret|auth|authorization|provider key)\b/u.test(text) ||
    /(?:api\s*)?(?:key|token)|密钥|令牌|凭证|鉴权|授权/u.test(text);
  const noKeyFallback = /\b(no[- ]?key|without key|no token|free public|open api|public api|no authentication)\b/u.test(text) ||
    /免\s*(?:key|token|密钥|鉴权)|无需\s*(?:key|token|密钥|鉴权)|公开接口|开放接口|免费接口/u.test(text);
  const externalContext = /\b(api|url|endpoint|provider|external|third[- ]party|fetch|request)\b/u.test(text) ||
    /外部|第三方|接口|数据源|天气|节假日|联网/u.test(text);
  return externalContext && asksCredential && noKeyFallback;
}

function isDevelopmentLanguageClarification(question: ClarifyQuestion): boolean {
  const text = questionText(question);
  const python = /\bpython\b/u.test(text) || /python\s*脚本|python\s*项目/u.test(text);
  const typescript = /\btypescript\b|\btype\s*script\b|\bnode(?:\.js)?\b/u.test(text) ||
    /type\s*script|ts\s*(程序|工程|项目|脚本|语言|实现)|typescript\s*项目/u.test(text);
  const asksLanguage = /\b(language|runtime|implementation stack|programming language)\b/u.test(text) ||
    /开发语言|编程语言|实现语言|运行时|技术栈/u.test(text);
  return asksLanguage && python && typescript;
}
