import { isContentRejectionExhausted } from '../../llm/errors.js';

export class PlannerContractViolation extends Error {
  readonly plannerContractViolation = true;

  constructor(message: string) {
    super(message);
    this.name = 'PlannerContractViolation';
  }
}

export function formatPlannerValidationFeedback(error: unknown): string {
  if (!error) return '';
  const message = errorMessage(error).slice(0, 1800);
  return [
    '',
    '',
    '上一次输出未通过 XCompiler 计划契约校验。请根据以下错误修正后重新输出完整、严格 JSON，禁止解释或 Markdown：',
    `校验错误：${message}`,
    '修正要求：',
    '- 保留已确认的 PhasePlan 约束；只生成当前 current phase 的内容。',
    '- architectureModules 必须满足 sourcePaths/testPaths 和 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 可追踪性；不要为凑数量拆散内聚模块。',
    '- architectureModules.testPaths 是 HIGH_LEVEL_DESIGN 创建、MODULE_TEST 消费的模块契约测试，不能同时出现在 CODE 的单元测试输出中。',
    '- 若一个 CODE 宏 Step 覆盖多个模块，必须在该 CODE Step 的 subTasks 中逐一列出对应模块。',
    '- 每个 output 文件在一次 V 流程中只能由一个 Step 产出；其它 Step 需要它就写进 inputs，不要重复声明为 outputs。',
    '- Step inputs/outputs 必须是精确文件路径，禁止使用 src/**/*.ts、tests/** 等 glob 或目录选择器；需要多个文件时逐项列出上游 Step 的具体 outputs。',
    '- 不要删除标准 V 模型 8 个宏 Step。',
  ].join('\n');
}

const PLANNER_CONTRACT_MESSAGE =
  /^Planner (?:architecture|phase|PhasePlan|JSON|draft|complexityAssessment|implementationPhases|iteration)/u;

export function isPlannerStructuredValidationError(error: unknown): boolean {
  // FallbackClient validates each candidate before accepting it. Once every candidate is rejected,
  // it preserves that fact as structured failure metadata; do not infer transport from the
  // aggregate message or depend on every parser/contract error sharing one text prefix.
  if (isContentRejectionExhausted(error)) return true;
  if (isPlannerTransportFailure(errorMessage(error))) return false;
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (isPlannerContractViolation(current)) return true;
    if (PLANNER_CONTRACT_MESSAGE.test(errorMessage(current))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlannerContractViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { plannerContractViolation?: unknown }).plannerContractViolation === true;
}

function isPlannerTransportFailure(message: string): boolean {
  const text = message.toLowerCase();
  return ['fetch failed', 'timed out', 'timeout', 'connection', 'econnrefused', 'econnreset',
    'socket', 'terminated', 'server closed'].some((signal) => text.includes(signal));
}
