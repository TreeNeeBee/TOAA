import {
  PHASES,
  REQUIRED_V_MODEL_PHASES,
  V_MODEL_SOURCE_TO_TEST_PHASE,
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type ArchitectureModule,
  type Language,
  type ProjectType,
  type Step,
  type StepSubtask,
} from '../core/plan.js';
import {
  DOC_NAMES,
  PHASE_DOC,
  deliveryDocsForIteration,
  phaseDocForIteration,
  testPlanDocForIteration,
} from '../core/docs.js';
import { architectureImplementationPaths, pathCoveredByOutputs } from '../core/architecture.js';
import { getLanguageProfile } from '../core/language.js';
import { isExecutableTestPath } from '../core/test_assets.js';
import {
  isLoopbackNetworkFailureLine,
  isTestAssertionDiagnosticLine,
} from '../core/network_api_gate.js';

/**
 * 统一的 LLM 输出校准层（"calibration"）。
 *
 * 设计目标：把所有"LLM 经常写歪、必须在落盘前修正"的清洗逻辑集中到本文件，
 * 便于扩展、测试与审计；上层 agents（Planner/Architect/...）只负责调用，
 * 不再各自维护正则与映射表。
 *
 * 当前覆盖：
 *  - calibratePythonRequirements: 幻觉 PyPI 包名重写 / bullet 清洗 / 强制依赖
 *  - calibrateDocPaths:           V 模型阶段验收文档路径规范化 / 自动补齐 / 禁止项剔除
 *  - calibrateVModelDependencies: V 模型宏 Step 相邻阶段依赖补齐
 *  - calibrateStepIds:            Step id → S### 形式（同步 dependsOn）
 *  - calibrateStepShape:          补齐 schema 必填项（role/acceptance/systemPrompt/title/description）
 *  - calibrateArchitectureStepMappings:
 *                                   将 architectureModules 映射到 HIGH_LEVEL_DESIGN / CODE / MODULE_TEST 宏 Step
 *  - calibrateLanguageStepOwnership:
 *                                   归位语言级 manifest / test assets，确保左侧阶段拥有测试
 */

// =============================================================================
// 1. Python pip 依赖
// =============================================================================

/**
 * 已知 LLM 幻觉包名 → 真实 PyPI 包映射。
 *  - JSON Schema：`jsonschema` 而不是 `json-schema` / `pyjsonschema`
 *  - YAML：`PyYAML`，LLM 常写 `pyyaml`（pip 大小写不敏感，故无需重写，仅作示例不列入）
 *  - HTTP：`requests` 是规范名，`python-requests` / `pyrequests` 不存在
 *  - sklearn 真实包名是 `scikit-learn`
 *  - cv2 真实包名是 `opencv-python`
 *  - PIL 真实包名是 `pillow`
 *  - serial 真实包名是 `pyserial`
 *  - bs4 真实包名是 `beautifulsoup4`
 */
export const HALLUCINATED_PACKAGE_MAP: Record<string, string> = {
  // 常见错误别名 → import 名 vs PyPI 名错配
  sklearn: 'scikit-learn',
  cv2: 'opencv-python',
  pil: 'pillow',
  serial: 'pyserial',
  bs4: 'beautifulsoup4',
  yaml: 'PyYAML',

  // 网络
  'python-requests': 'requests',
  pyrequests: 'requests',

  // JSON Schema
  'json-schema': 'jsonschema',
  pyjsonschema: 'jsonschema',

  // 加密
  pycrypto: 'pycryptodome', // pycrypto 已废弃 / 不安全
};

/** 强制保证存在的依赖（按出现顺序追加，不会覆盖已有版本约束）。 */
const REQUIRED_PACKAGES = ['pytest'];

/**
 * 清洗 Plan 顶层 Python `dependencies`：
 *  - 去掉 markdown 列表前缀 / 引号 / 空行 / 注释行；
 *  - 把 LLM 常见幻觉包名重写为真实 pip 包；
 *  - **剥离所有版本约束**：LLM 经常臆造不存在的版本号（如 `pandas==1.5.*`
 *    在某些时间窗失效），导致 `pip install` 直接 ERROR。
 *    生成型项目对版本可重现性需求弱，统一不锁版本，让 pip 解析到任意可用版本即可；
 *    需要锁版本时由用户手动编辑 `requirements.txt`。
 *  - 去重（保持出现顺序）；
 *  - 强制保证 REQUIRED_PACKAGES 在列。
 */
export function calibratePythonRequirements(reqs: string[] | undefined | null): string[] {
  const cleaned = (reqs ?? [])
    .map((s) => String(s ?? '').replace(/^\s*[-*]\s+/, '').replace(/^["']|["']$/g, '').trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));
  const remapped = cleaned.map((line) => {
    const m = line.match(/^([A-Za-z0-9._-]+)(.*)$/);
    if (!m) return line;
    const name = m[1]!.toLowerCase();
    const real = HALLUCINATED_PACKAGE_MAP[name] ?? m[1]!;
    // 丢弃 ==/>=/<=/~=/!=/</> 等所有 PEP 440 版本约束
    return real;
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of remapped) {
    const key = packageKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  for (const required of REQUIRED_PACKAGES) {
    const key = required.toLowerCase();
    if (!seen.has(key)) {
      out.push(required);
      seen.add(key);
    }
  }
  return out;
}

/** 取包名（不含版本约束）作为去重键。 */
function packageKey(line: string): string {
  const m = line.match(/^([A-Za-z0-9._-]+)/);
  return (m ? m[1]! : line).toLowerCase();
}

// =============================================================================
// 2. V 模型阶段文档路径
// =============================================================================

/** LLM 常用的旧文档名 → 规范化命名。 */
export const DOC_PATH_ALIASES: Record<string, string> = {
  'docs/01-requirement.md': DOC_NAMES.requirementAnalysis,
  'docs/requirements.md': DOC_NAMES.requirementAnalysis,
  'docs/requirement.md': DOC_NAMES.requirementAnalysis,
  'docs/srs.md': DOC_NAMES.requirementAnalysis,
  'docs/02-architecture.md': DOC_NAMES.highLevelDesign,
  'docs/architecture.md': DOC_NAMES.highLevelDesign,
  'docs/arch.md': DOC_NAMES.highLevelDesign,
  'docs/03-tasks.md': DOC_NAMES.detailedDesign,
  'docs/tasks.md': DOC_NAMES.detailedDesign,
  'docs/task.md': DOC_NAMES.detailedDesign,
  'docs/design.md': DOC_NAMES.detailedDesign,
  'docs/04-refactor.md': DOC_NAMES.functionalTest,
  'docs/refactor.md': DOC_NAMES.functionalTest,
  'docs/05-delivery.md': DOC_NAMES.functionalTest,
  'docs/delivery.md': DOC_NAMES.functionalTest,
  'docs/deliverables.md': DOC_NAMES.functionalTest,
  'docs/unit-test.md': DOC_NAMES.unitTest,
  'docs/integration-test.md': DOC_NAMES.integrationTest,
  'docs/module-test.md': DOC_NAMES.moduleTest,
  'docs/functional-test.md': DOC_NAMES.functionalTest,
  'docs/unit-test-plan.md': DOC_NAMES.unitTestPlan,
  'docs/unit_test_plan.md': DOC_NAMES.unitTestPlan,
  'docs/tests/unit_test_plan.md': DOC_NAMES.unitTestPlan,
  'docs/integration-test-plan.md': DOC_NAMES.integrationTestPlan,
  'docs/integration_test_plan.md': DOC_NAMES.integrationTestPlan,
  'docs/tests/integration_test_plan.md': DOC_NAMES.integrationTestPlan,
  'docs/module-test-plan.md': DOC_NAMES.moduleTestPlan,
  'docs/module_test_plan.md': DOC_NAMES.moduleTestPlan,
  'docs/tests/module_test_plan.md': DOC_NAMES.moduleTestPlan,
  'docs/functional-test-plan.md': DOC_NAMES.functionalTestPlan,
  'docs/functional_test_plan.md': DOC_NAMES.functionalTestPlan,
  'docs/tests/functional_test_plan.md': DOC_NAMES.functionalTestPlan,
  'docs/quick-start.md': DOC_NAMES.quickstart,
  'docs/quick_start.md': DOC_NAMES.quickstart,
  'docs/quickstart.md': DOC_NAMES.quickstart,
  'docs/api.md': DOC_NAMES.apiGuide,
  'docs/api_guide.md': DOC_NAMES.apiGuide,
  'docs/api-guide.md': DOC_NAMES.apiGuide,
};

function canonicalTestPlanAlias(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/');
  const match = normalized.match(
    /^docs\/(?:tests\/)?(?:\d{1,2}[-_])?(functional|integration|module|unit)[-_]?test[-_]?plan\.md$/iu,
  );
  const kind = match?.[1]?.toLowerCase();
  if (kind === 'functional') return DOC_NAMES.functionalTestPlan;
  if (kind === 'integration') return DOC_NAMES.integrationTestPlan;
  if (kind === 'module') return DOC_NAMES.moduleTestPlan;
  if (kind === 'unit') return DOC_NAMES.unitTestPlan;
  return undefined;
}

/**
 * 把 LLM 容易写歪的常见旧文档名规整为 V 模型规范化命名。同时：
 *  - 各阶段若 outputs 缺失对应规范文档，自动追加；
 *  - V 模型左侧阶段同步补齐对应测试计划文档；
 *  - 若有 Step 把 docs/topic.md 列为 outputs，则移除（topic.md 仅由 xcompiler build 写入）。
 */
export function calibrateDocPaths(steps: Step[], projectType: ProjectType = 'application'): Step[] {
  const remap = (p: string): string => DOC_PATH_ALIASES[p] ?? canonicalTestPlanAlias(p) ?? p;
  const dropTopic = (p: string): boolean => p !== DOC_NAMES.topic;
  return steps.map((s) => {
    const iterationId = s.iterationId ?? 'P1';
    const inputs = dedup((s.inputs ?? []).map((p) => iterationScopedInput(remap(p), s.phase, iterationId)));
    let outputs = dedup((s.outputs ?? []).map((p) => iterationScopedDoc(remap(p), s.phase, iterationId)).filter(dropTopic));
    outputs = outputs.filter((out) => {
      const ownerPhase = testPlanOwnerPhase(out, iterationId);
      return !ownerPhase || ownerPhase === s.phase;
    });
    const expected = phaseDocForIteration(s.phase, iterationId);
    if (expected && !outputs.includes(expected)) {
      // 仅在该阶段允许有"主验收文档"时自动补齐（CODE/DEBUG 不在表内）。
      outputs = [expected, ...outputs];
    }
    const pairedTestPhase = V_MODEL_SOURCE_TO_TEST_PHASE[s.phase as keyof typeof V_MODEL_SOURCE_TO_TEST_PHASE];
    const testPlanDoc = pairedTestPhase ? testPlanDocForIteration(pairedTestPhase, iterationId) : undefined;
    if (testPlanDoc && !outputs.includes(testPlanDoc)) {
      outputs = [...outputs, testPlanDoc];
    }
    if (s.phase === 'FUNCTIONAL_TEST') {
      const requiredDocs = [...deliveryDocsForIteration(projectType, iterationId)];
      outputs = [...requiredDocs, ...outputs.filter((out) => !requiredDocs.includes(out))];
    }
    return { ...s, inputs, outputs };
  });
}

/** 补齐同一 iteration 内标准 V 模型宏步骤的相邻顺序依赖。 */
export function calibrateVModelDependencies(steps: Step[]): Step[] {
  const out = steps.map((step) => ({ ...step, dependsOn: [...(step.dependsOn ?? [])] }));
  const byIteration = new Map<string, Step[]>();
  for (const step of out) {
    const iterationId = step.iterationId ?? 'P1';
    const group = byIteration.get(iterationId) ?? [];
    group.push(step);
    byIteration.set(iterationId, group);
  }

  for (const group of byIteration.values()) {
    for (let index = 1; index < REQUIRED_V_MODEL_PHASES.length; index += 1) {
      const prevPhase = REQUIRED_V_MODEL_PHASES[index - 1]!;
      const phase = REQUIRED_V_MODEL_PHASES[index]!;
      const prevIds = group.filter((step) => step.phase === prevPhase).map((step) => step.id);
      if (prevIds.length === 0) continue;
      for (const step of group.filter((candidate) => candidate.phase === phase)) {
        if (step.dependsOn.some((dep) => prevIds.includes(dep))) continue;
        step.dependsOn = dedup([...step.dependsOn, ...prevIds]);
      }
    }
  }

  return out;
}

export function calibrateArchitectureModuleDependencies(
  modules: ArchitectureModule[] | undefined | null,
  dependencies: string[] | undefined | null,
): { architectureModules: ArchitectureModule[]; dependencies: string[] } {
  const architectureModules = (modules ?? []).map((module) => ({
    ...module,
    dependencies: [...(module.dependencies ?? [])],
  }));
  const moduleIds = new Set(architectureModules.map((module) => module.id));
  const projectDependencies = [...(dependencies ?? [])];

  for (const module of architectureModules) {
    const internalDependencies: string[] = [];
    for (const rawDependency of module.dependencies) {
      const dependency = String(rawDependency ?? '').trim();
      if (!dependency) continue;
      if (moduleIds.has(dependency) || /^M\d{3,}$/u.test(dependency)) {
        internalDependencies.push(dependency);
      } else {
        projectDependencies.push(dependency);
      }
    }
    module.dependencies = dedup(internalDependencies);
  }

  return {
    architectureModules,
    dependencies: dedup(projectDependencies.map((dependency) => dependency.trim()).filter(Boolean)),
  };
}

/**
 * Move product runtime assets that an LLM placed in sourcePaths into assetPaths.
 *
 * Invalid paths outside src/ remain in sourcePaths so the architecture validator
 * can reject them instead of silently laundering an unsafe or misplaced output.
 */
export function calibrateArchitectureModulePaths(
  modules: ArchitectureModule[] | undefined | null,
  language: Language,
): ArchitectureModule[] {
  const extensions = getLanguageProfile(language).codeExtensions;
  return (modules ?? []).map((module) => {
    const sourcePaths: string[] = [];
    const assetPaths = [...(module.assetPaths ?? [])];
    for (const path of module.sourcePaths) {
      const isCode = path.startsWith('src/') && extensions.some((extension) => path.endsWith(extension));
      const isRuntimeAsset = path.startsWith('src/') && !path.endsWith('/');
      if (!isCode && isRuntimeAsset) {
        assetPaths.push(path);
      } else {
        sourcePaths.push(path);
      }
    }
    return {
      ...module,
      sourcePaths: dedup(sourcePaths),
      assetPaths: assetPaths.length > 0 ? dedup(assetPaths) : undefined,
    };
  });
}

// =============================================================================
// 3. 语言级产物归属校准
// =============================================================================

/**
 * 修正常见的 LLM StepPlan 产物归属漂移：
 *  - TypeScript greenfield 的 package.json / tsconfig.json 必须由 HIGH_LEVEL_DESIGN 拥有；
 *  - S01-S04 左侧阶段拥有与其配对的测试计划和可执行测试；
 *  - S05-S08 仅消费测试文件并产出验证报告，不拥有或重写 tests/**。
 *
 * 这是 lint 前的机械校准，不改变需求语义，也不为具体样例硬编码文件名。
 */
export function calibrateLanguageStepOwnership(
  steps: Step[],
  args: {
    language: Language;
    intent?: string;
    architectureModules?: ArchitectureModule[];
  },
): Step[] {
  const profile = getLanguageProfile(args.language);
  const out = steps.map((step) => ({
    ...step,
    outputs: dedup([...(step.outputs ?? [])]),
  }));

  if (args.language === 'typescript') {
    const projectConfigOutputs = [profile.manifestFile, 'tsconfig.json'];
    const hld = out.find((step) => step.phase === 'HIGH_LEVEL_DESIGN');
    for (const step of out) {
      if (step.phase === 'HIGH_LEVEL_DESIGN') continue;
      step.outputs = step.outputs.filter((output) =>
        !projectConfigOutputs.some((configOutput) => isSameOrNestedPath(output, configOutput)),
      );
    }
    if (args.intent === 'greenfield' && hld) {
      const missingConfigOutputs = projectConfigOutputs.filter((configOutput) =>
        !hld.outputs.some((output) => isSameOrNestedPath(output, configOutput)),
      );
      hld.outputs = dedup([...hld.outputs, ...missingConfigOutputs]);
    }
  }

  const movedTests: Array<{ from: Step; output: string; sourcePhase: Step['phase'] }> = [];
  for (const step of out) {
    const sourcePhase =
      V_MODEL_TEST_TO_SOURCE_PHASE[step.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE];
    if (!sourcePhase) continue;
    const kept: string[] = [];
    for (const output of step.outputs) {
      if (isExecutableTestPath(output, args.language)) {
        movedTests.push({ from: step, output, sourcePhase });
      } else {
        kept.push(output);
      }
    }
    step.outputs = dedup(kept);
  }

  for (const item of movedTests) {
    const target = findIterationStep(out, item.from.iterationId ?? 'P1', item.sourcePhase);
    if (!target) continue;
    target.outputs = dedup([...target.outputs, item.output]);
    item.from.inputs = dedup([...item.from.inputs, item.output]);
  }

  return out;
}

function isSameOrNestedPath(output: string, targetPath: string): boolean {
  return output === targetPath || output.endsWith(`/${targetPath}`);
}

function findIterationStep(steps: Step[], iterationId: string, phase: Step['phase']): Step | undefined {
  return steps.find((step) => (step.iterationId ?? 'P1') === iterationId && step.phase === phase);
}

function testPlanOwnerPhase(path: string, iterationId: string): Step['phase'] | undefined {
  for (const [sourcePhase, testPhase] of Object.entries(V_MODEL_SOURCE_TO_TEST_PHASE)) {
    if (path === testPlanDocForIteration(testPhase as Step['phase'], iterationId)) {
      return sourcePhase as Step['phase'];
    }
  }
  return undefined;
}

function iterationScopedDoc(path: string, phase: Step['phase'], iterationId: string): string {
  if (iterationId === 'P1') return path;
  if (path === DOC_NAMES.readme && phase === 'FUNCTIONAL_TEST') {
    return `docs/iterations/${iterationId}/README.md`;
  }
  if (path === DOC_NAMES.quickstart && phase === 'FUNCTIONAL_TEST') {
    return `docs/iterations/${iterationId}/quickstart.md`;
  }
  if (path === DOC_NAMES.apiGuide && phase === 'FUNCTIONAL_TEST') {
    return `docs/iterations/${iterationId}/api-guide.md`;
  }
  for (const [docPhase, canonical] of Object.entries(PHASE_DOC)) {
    if (path === canonical) {
      return phaseDocForIteration(docPhase as Step['phase'], iterationId) ?? path;
    }
  }
  return path;
}

function iterationScopedInput(path: string, phase: Step['phase'], iterationId: string): string {
  if (iterationId === 'P1' || phase === 'REQUIREMENT_ANALYSIS') return path;
  return iterationScopedDoc(path, phase, iterationId);
}

// =============================================================================
// 3. Step id 规范化
// =============================================================================

/**
 * 把 LLM 偶尔写歪的 Step id 规整成 schema 要求的 S### 形式（至少 3 位数字）。
 * 同时同步更新所有 dependsOn 引用。
 *  - "id_S009" -> "S009"
 *  - "S9"      -> "S009"
 *  - "step-12" -> "S012"
 *  - 完全无数字时按出现顺序兜底 S00N（保留原序）。
 */
export function calibrateStepIds(steps: Step[]): Step[] {
  const map = new Map<string, string>();
  let fallback = 0;
  for (const s of steps) {
    fallback += 1;
    const raw = String(s.id ?? '').trim();
    let normalized: string;
    if (/^S\d{3,}$/.test(raw)) {
      normalized = raw;
    } else {
      const m = raw.match(/(\d+)/);
      const num = m ? parseInt(m[1]!, 10) : fallback;
      normalized = 'S' + String(num).padStart(3, '0');
    }
    map.set(raw, normalized);
  }
  return steps.map((s) => ({
    ...s,
    id: map.get(String(s.id ?? '').trim()) ?? s.id,
    dependsOn: Array.isArray(s.dependsOn)
      ? s.dependsOn.map((d) => map.get(String(d).trim()) ?? d)
      : s.dependsOn,
  }));
}

// =============================================================================
// 4. Step 形状补齐（兜底 schema 必填项）
// =============================================================================

/** 阶段 → 默认 role 兜底。 */
const PHASE_DEFAULT_ROLE: Record<string, string> = {
  REQUIREMENT_ANALYSIS: 'Planner',
  HIGH_LEVEL_DESIGN: 'Architect',
  DETAILED_DESIGN: 'Architect',
  CODE: 'Coder',
  UNIT_TEST: 'Tester',
  INTEGRATION_TEST: 'Tester',
  MODULE_TEST: 'Tester',
  FUNCTIONAL_TEST: 'Tester',
};

/** 把 LLM 偶尔写错的 role 别名规范到合法白名单。 */
const ROLE_ALIASES: Record<string, string> = {
  developer: 'Coder',
  programmer: 'Coder',
  engineer: 'Coder',
  tester: 'Tester',
  qa: 'Tester',
  debugger: 'Debugger',
  architect: 'Architect',
  designer: 'Architect',
  planner: 'Planner',
  pm: 'Planner',
};

const VALID_ROLES = new Set(['Planner', 'Architect', 'Coder', 'Tester', 'Debugger']);

const VALID_PHASES = new Set<string>(PHASES);

/** LLM 偶尔写错的 phase 别名 / 同义词 → 规范名。键已 lower-case。 */
const PHASE_ALIASES: Record<string, string> = {
  requirement: 'REQUIREMENT_ANALYSIS', requirements: 'REQUIREMENT_ANALYSIS', req: 'REQUIREMENT_ANALYSIS', spec: 'REQUIREMENT_ANALYSIS',
  requirement_analysis: 'REQUIREMENT_ANALYSIS', 'requirement-analysis': 'REQUIREMENT_ANALYSIS', analysis: 'REQUIREMENT_ANALYSIS',
  arch: 'HIGH_LEVEL_DESIGN', architecture: 'HIGH_LEVEL_DESIGN', high_level_design: 'HIGH_LEVEL_DESIGN', 'high-level-design': 'HIGH_LEVEL_DESIGN',
  overview_design: 'HIGH_LEVEL_DESIGN', system_design: 'HIGH_LEVEL_DESIGN', outline_design: 'HIGH_LEVEL_DESIGN', 概要设计: 'HIGH_LEVEL_DESIGN',
  task: 'DETAILED_DESIGN', tasks: 'DETAILED_DESIGN', planning: 'DETAILED_DESIGN', breakdown: 'DETAILED_DESIGN',
  design: 'DETAILED_DESIGN', detailed_design: 'DETAILED_DESIGN', 'detailed-design': 'DETAILED_DESIGN', 详细设计: 'DETAILED_DESIGN',
  code: 'CODE', coding: 'CODE', implement: 'CODE', implementation: 'CODE', dev: 'CODE', develop: 'CODE',
  test: 'UNIT_TEST', testing: 'UNIT_TEST', tests: 'UNIT_TEST', qa: 'UNIT_TEST', unit: 'UNIT_TEST', unit_test: 'UNIT_TEST', 'unit-test': 'UNIT_TEST',
  integration: 'INTEGRATION_TEST', integration_test: 'INTEGRATION_TEST', 'integration-test': 'INTEGRATION_TEST',
  module: 'MODULE_TEST', module_test: 'MODULE_TEST', 'module-test': 'MODULE_TEST',
  functional: 'FUNCTIONAL_TEST', functional_test: 'FUNCTIONAL_TEST', 'functional-test': 'FUNCTIONAL_TEST',
  verify: 'FUNCTIONAL_TEST', verification: 'FUNCTIONAL_TEST',
  refactor: 'CODE', refactoring: 'CODE', cleanup: 'CODE',
  delivery: 'FUNCTIONAL_TEST', deliver: 'FUNCTIONAL_TEST', release: 'FUNCTIONAL_TEST', package: 'FUNCTIONAL_TEST', packaging: 'FUNCTIONAL_TEST', deploy: 'FUNCTIONAL_TEST',
};

/** outputs 路径 → 阶段强证据（命中即覆盖 role 推断）。 */
const PHASE_BY_OUTPUT_DOC: Array<[RegExp, string]> = [
  [/(^|\/)docs\/01-(?:requirement|requirement-analysis)\.md$/i, 'REQUIREMENT_ANALYSIS'],
  [/(^|\/)docs\/02-(?:architecture|high-level-design)\.md$/i, 'HIGH_LEVEL_DESIGN'],
  [/(^|\/)docs\/03-(?:tasks|detailed-design)\.md$/i, 'DETAILED_DESIGN'],
  [/(^|\/)docs\/05-unit-test\.md$/i, 'UNIT_TEST'],
  [/(^|\/)docs\/06-integration-test\.md$/i, 'INTEGRATION_TEST'],
  [/(^|\/)docs\/07-module-test\.md$/i, 'MODULE_TEST'],
  [/(^|\/)docs\/(?:04-refactor|05-delivery|08-functional-test)\.md$/i, 'FUNCTIONAL_TEST'],
];

/** 由 role 反推阶段（弱证据，仅在路径线索与别名都不可用时使用）。 */
const PHASE_BY_ROLE: Record<string, string> = {
  Planner: 'REQUIREMENT_ANALYSIS',
  Architect: 'HIGH_LEVEL_DESIGN',
  Coder: 'CODE',
  Tester: 'UNIT_TEST',
};

const WRITE_CAPABLE_TOOL_REFS = new Set([
  'write_file',
  'append_file',
  'apply_patch',
  'replace_in_file',
  'skill:author',
  'skill:patcher',
  'skill:tester',
  'skill:debugger',
  'skill:refactorer',
]);

const PHASE_DEFAULT_TOOLS: Record<string, string[]> = {
  REQUIREMENT_ANALYSIS: ['skill:author'],
  HIGH_LEVEL_DESIGN: ['skill:author'],
  DETAILED_DESIGN: ['skill:author'],
  CODE: ['skill:author'],
  UNIT_TEST: ['skill:tester'],
  INTEGRATION_TEST: ['skill:tester'],
  MODULE_TEST: ['skill:tester'],
  FUNCTIONAL_TEST: ['skill:tester'],
};

const PHASE_DEFAULT_TOOLS_REQUIRED = new Set([
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'MODULE_TEST',
  'FUNCTIONAL_TEST',
]);

export function ensureEssentialToolRefs(step: Pick<Step, 'phase' | 'tools' | 'outputs'>): string[] {
  const tools = Array.isArray(step.tools) ? [...step.tools] : [];
  const outputs = Array.isArray(step.outputs) ? step.outputs : [];
  const needsWritableOutputs = outputs.some((out) => typeof out === 'string' && !out.endsWith('/'));
  const phaseDefaults = PHASE_DEFAULT_TOOLS[step.phase] ?? [];
  const baseTools = PHASE_DEFAULT_TOOLS_REQUIRED.has(step.phase)
    ? dedup([...tools, ...phaseDefaults])
    : tools;
  const hasWriteCapability = baseTools.some((tool) => WRITE_CAPABLE_TOOL_REFS.has(tool));
  const withChunkedWritePair = ensureChunkedWritePair(baseTools);
  if (!needsWritableOutputs || hasWriteCapability) return withChunkedWritePair;
  return ensureChunkedWritePair([...baseTools, ...(phaseDefaults.length > 0 ? phaseDefaults : ['write_file'])]);
}

function ensureChunkedWritePair(tools: string[]): string[] {
  const out = [...tools];
  const hasWriteFile = out.includes('write_file');
  const hasAppendFile = out.includes('append_file');
  if (hasWriteFile && !hasAppendFile) out.push('append_file');
  if (hasAppendFile && !hasWriteFile) out.push('write_file');
  return dedup(out);
}

/**
 * 推断 Step 的阶段。优先级：
 *   1. 原值是合法阶段 → 原样返回
 *   2. PHASE_ALIASES 命中（小写 / 同义词）
 *   3. outputs 中含强路径证据（docs/0N-*.md）
 *   4. outputs 含 src 下源文件 → CODE；含 tests 下测试文件 → 对应左侧测试设计阶段
 *   5. 由 role 兜底（Planner→REQUIREMENT_ANALYSIS 等）
 *   6. 仍无法识别 → 'CODE'（最常见阶段，避免连锁失败）
 */
function inferPhase(rawPhase: unknown, role: string, outputs: string[]): string {
  const raw = typeof rawPhase === 'string' ? rawPhase.trim() : '';
  if (VALID_PHASES.has(raw)) return raw;
  if (raw) {
    const alias = PHASE_ALIASES[raw.toLowerCase()];
    if (alias) return alias;
  }
  for (const out of outputs) {
    for (const [re, phase] of PHASE_BY_OUTPUT_DOC) {
      if (re.test(out)) return phase;
    }
  }
  if (outputs.some((o) => /(^|\/)tests\/functional\//i.test(o))) return 'REQUIREMENT_ANALYSIS';
  if (outputs.some((o) => /(^|\/)tests\/integration\//i.test(o))) return 'DETAILED_DESIGN';
  if (outputs.some((o) => /(^|\/)tests\/modules?\//i.test(o))) return 'HIGH_LEVEL_DESIGN';
  if (outputs.some((o) => /(^|\/)tests\/.*\.(?:py|ts|tsx)$/i.test(o))) return 'CODE';
  if (outputs.some((o) => /(^|\/)src\/.*\.(?:py|ts|tsx)$/i.test(o))) return 'CODE';
  if (role && PHASE_BY_ROLE[role]) return PHASE_BY_ROLE[role]!;
  return 'CODE';
}

/**
 * 补齐 Step schema 必填项，避免因 LLM 漏字段导致 Plan 整盘失败：
 *  - role 缺失 / 非法 → 用 PHASE_DEFAULT_ROLE 兜底；ROLE_ALIASES 做大小写&同义词修正
 *  - acceptance 缺失 / 空 → 用 description 截断或固定模板兜底
 *  - systemPrompt 长度不足 → 补齐到至少 20 字符
 *  - title / description 缺失 → 用阶段名兜底，避免空字符串
 *  - tools / inputs / outputs / dependsOn 缺失 → 默认空数组
 *  - maxRetries 非正整数 → 重置为 3
 */
export function calibrateStepShape(steps: Step[]): Step[] {
  return steps.map((raw) => {
    const s = raw as unknown as Record<string, unknown>;
    const outputs = Array.isArray(s.outputs) ? (s.outputs as string[]) : [];

    // role 先粗算一遍（用于 phase 推断兜底）
    let role = typeof s.role === 'string' ? s.role.trim() : '';
    if (!VALID_ROLES.has(role)) {
      const alias = ROLE_ALIASES[role.toLowerCase()];
      if (alias && VALID_ROLES.has(alias)) role = alias;
    }

    // phase 兜底：LLM 偶尔写 "---" / "design" / 漏字段，从别名 / outputs / role 推断
    const phase = inferPhase(s.phase, role, outputs);
    const title = (typeof s.title === 'string' && s.title.trim()) || `${phase} Step`;
    const description = (typeof s.description === 'string' && s.description.trim()) || title;

    // role 最终兜底：合法但与阶段职责不匹配也按 phase 默认收敛，避免 DLD=Coder 这类职能漂移。
    const phaseDefaultRole = PHASE_DEFAULT_ROLE[phase] ?? 'Coder';
    if (!VALID_ROLES.has(role) || role !== phaseDefaultRole) {
      role = phaseDefaultRole;
    }

    // acceptance 兜底
    let acceptance = typeof s.acceptance === 'string' ? s.acceptance.trim() : '';
    if (!acceptance) {
      acceptance = `${title} 完成，所有声明的 outputs 文件存在且内容非空。`;
    }

    // systemPrompt 兜底（schema 仅要求 min(1)，但 xcompiler_run 期望真实有效的提示词）
    let systemPrompt = typeof s.systemPrompt === 'string' ? s.systemPrompt.trim() : '';
    if (systemPrompt.length < 20) {
      systemPrompt =
        `${phase} 阶段任务：${title}。${description}` +
        `\n范围：仅完成本 Step 声明的 outputs。` +
        `\n验收：${acceptance}`;
    }

    return {
      id: String(s.id ?? ''),
      iterationId: (typeof s.iterationId === 'string' && s.iterationId.trim()) ? s.iterationId.trim() : 'P1',
      phase: phase as Step['phase'],
      title,
      description,
      systemPrompt,
      role: role as Step['role'],
      tools: ensureEssentialToolRefs({
        phase: phase as Step['phase'],
        tools: Array.isArray(s.tools) ? (s.tools as string[]) : [],
        outputs,
      }),
      inputs: Array.isArray(s.inputs) ? (s.inputs as string[]) : [],
      outputs,
      subTasks: calibrateSubTasks(s.subTasks),
      dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as string[]) : [],
      acceptance,
      status: (typeof s.status === 'string' ? s.status : 'PENDING') as Step['status'],
      retries: typeof s.retries === 'number' && s.retries >= 0 ? s.retries : 0,
      maxRetries:
        typeof s.maxRetries === 'number' && Number.isInteger(s.maxRetries) && s.maxRetries > 0
          ? s.maxRetries
          : 3,
    } as Step;
  });
}

function calibrateSubTasks(raw: unknown): StepSubtask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tasks = raw
    .map((item, index): StepSubtask | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const title =
        (typeof record.title === 'string' && record.title.trim()) ||
        (typeof record.id === 'string' && record.id.trim()) ||
        `Subtask ${index + 1}`;
      const description =
        (typeof record.description === 'string' && record.description.trim()) ||
        title;
      const subTask: StepSubtask = {
        id: (typeof record.id === 'string' && record.id.trim()) || `T${index + 1}`,
        title,
        description,
      };
      if (typeof record.acceptance === 'string' && record.acceptance.trim()) {
        subTask.acceptance = record.acceptance.trim();
      }
      if (Array.isArray(record.outputs)) {
        subTask.outputs = record.outputs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      }
      const children = calibrateSubTasks(record.subTasks);
      if (children && children.length > 0) subTask.subTasks = children;
      return subTask;
    })
    .filter((task): task is StepSubtask => task !== null);
  return tasks.length > 0 ? tasks : undefined;
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// =============================================================================
// 4a. HIGH_LEVEL_DESIGN 模块 ↔ CODE/MODULE_TEST Step 映射校准
// =============================================================================

/**
 * LLM 经常能正确列出 architectureModules，却没有把模块测试资产归给 HIGH_LEVEL_DESIGN。
 * 新版计划模型保留“大 Step”执行语义，不再把这些 Step 机械拆碎；模块级细分写入 subTasks。
 * MODULE_TEST 只消费并验证这些测试，不再负责创建测试文件。
 */
export function calibrateArchitectureStepMappings(
  steps: Step[],
  modules: ArchitectureModule[] | undefined | null,
): Step[] {
  if (!modules || modules.length === 0) return steps;

  const stepById = new Map(steps.map((step) => [step.id, step]));
  const moduleTestPaths = dedup(modules.flatMap((module) => module.testPaths));
  const highLevelDesignOwner = steps.find((step) => step.phase === 'HIGH_LEVEL_DESIGN');
  const ownerByModule = new Map<string, string>();
  const modulesByCodeStep = new Map<string, ArchitectureModule[]>();
  for (const step of steps.filter((item) => item.phase === 'CODE')) {
    const ownedModules = modules.filter((module) =>
      architectureImplementationPaths(module).every((path) => pathCoveredByOutputs(path, step.outputs)),
    );
    modulesByCodeStep.set(step.id, ownedModules);
    for (const module of ownedModules) {
      if (!ownerByModule.has(module.id)) ownerByModule.set(module.id, step.id);
    }
  }

  return steps.map((step) => {
    const ownedStep =
      step.id === highLevelDesignOwner?.id
        ? step
        : {
            ...step,
            outputs: step.outputs.filter((output) => !moduleTestPaths.includes(output)),
          };
    let dependsOn = ownedStep.dependsOn;
    if (step.id === highLevelDesignOwner?.id) {
      const outputs = dedup([...ownedStep.outputs, ...moduleTestPaths]);
      return withModuleSubTasks({ ...ownedStep, outputs }, modules, 'HIGH_LEVEL_DESIGN');
    }

    if (ownedStep.phase === 'CODE') {
      const ownedModules = modulesByCodeStep.get(ownedStep.id) ?? [];
      const moduleDependencyOwners = ownedModules
        .flatMap((module) => [...module.dependencies, module.id])
        .map((moduleId) => ownerByModule.get(moduleId))
        .filter((owner): owner is string => Boolean(owner) && owner !== ownedStep.id);
      dependsOn = dedup([...dependsOn, ...moduleDependencyOwners]);
      return withModuleSubTasks({ ...ownedStep, dependsOn }, ownedModules, 'CODE');
    }

    if (ownedStep.phase === 'MODULE_TEST') {
      const explicitModules = modules.filter((module) =>
        module.testPaths.some((testPath) => pathCoveredByOutputs(testPath, ownedStep.inputs)),
      );
      const dependencyIds = collectTransitiveDependencyIds(ownedStep, stepById);
      const dependencyModules = [...dependencyIds].flatMap((dep) => modulesByCodeStep.get(dep) ?? []);
      const testedModules =
        explicitModules.length > 0
          ? dedupModules(explicitModules)
          : dedupModules(dependencyModules);
      const testedOwners = testedModules
        .map((module) => ownerByModule.get(module.id))
        .filter((owner): owner is string => Boolean(owner));
      dependsOn = dedup([...dependsOn, ...testedOwners]);
      const inputs = dedup([...ownedStep.inputs, ...testedModules.flatMap((module) => module.testPaths)]);
      return withModuleSubTasks(
        { ...ownedStep, dependsOn, inputs },
        testedModules,
        'MODULE_TEST',
      );
    }

    return { ...ownedStep, dependsOn };
  });
}

function dedupModules(modules: ArchitectureModule[]): ArchitectureModule[] {
  const seen = new Set<string>();
  const out: ArchitectureModule[] = [];
  for (const module of modules) {
    if (seen.has(module.id)) continue;
    seen.add(module.id);
    out.push(module);
  }
  return out;
}

function testPathPrefixForPhase(phase: Step['phase']): string {
  if (phase === 'MODULE_TEST') return 'module';
  if (phase === 'INTEGRATION_TEST') return 'integration';
  if (phase === 'FUNCTIONAL_TEST') return 'functional';
  return 'unit';
}

function collectTransitiveDependencyIds(
  step: Step,
  stepById: ReadonlyMap<string, Step>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = stepById.get(id);
    if (dep) stack.push(...dep.dependsOn);
  }
  return seen;
}

function withModuleSubTasks(
  step: Step,
  modules: ArchitectureModule[],
  kind: 'HIGH_LEVEL_DESIGN' | 'CODE' | 'MODULE_TEST',
): Step {
  if (modules.length === 0) return step;
  const existing = step.subTasks ?? [];
  const existingKeys = new Set(flattenSubTaskTexts(existing));
  const generated = modules
    .filter((module) => !existingKeys.has(module.id))
    .map((module): StepSubtask => ({
      id: module.id,
      title: `${kind} ${module.name}`,
      description:
        kind === 'CODE'
          ? `${module.responsibility} Implementation paths: ${architectureImplementationPaths(module).join(', ')}.`
          : kind === 'HIGH_LEVEL_DESIGN'
            ? `${module.responsibility} Define the module contract and author its module tests: ${module.testPaths.join(', ')}.`
            : `${module.responsibility} Validate the existing module tests: ${module.testPaths.join(', ')}.`,
      acceptance:
        kind === 'CODE'
          ? `All implementation paths for ${module.id} are complete and usable at runtime.`
          : kind === 'HIGH_LEVEL_DESIGN'
            ? `The ${module.id} contract and executable module tests are complete before implementation.`
            : `Existing tests for ${module.id} cover the declared module behaviour and pass.`,
      outputs:
        kind === 'CODE'
          ? architectureImplementationPaths(module)
          : kind === 'HIGH_LEVEL_DESIGN'
            ? [...module.testPaths]
            : undefined,
    }));
  if (generated.length === 0) return step;
  return { ...step, subTasks: [...existing, ...generated] };
}

function flattenSubTaskTexts(tasks: StepSubtask[]): string[] {
  return tasks.flatMap((task) => [
    task.id,
    task.title,
    task.description,
    task.acceptance ?? '',
    ...(task.outputs ?? []),
    ...flattenSubTaskTexts(task.subTasks ?? []),
  ]);
}

// =============================================================================
// 4b. Plan 覆盖率补齐（左侧测试资产 + 右侧验证 Step）
// =============================================================================

/**
 * 兜底保证每个左侧阶段拥有配对的可执行测试资产，右侧测试阶段只消费
 * 这些测试并产出报告。若缺少 UNIT_TEST 宏 Step，则补充一个验证 Step，
 * 但测试文件仍由 CODE 阶段拥有。
 */
export function calibratePlanCoverage(steps: Step[], language: Language = 'python'): Step[] {
  const withPairedTestAssets = ensurePairedTestAssets(steps, language);
  const stepById = new Map(withPairedTestAssets.map((s) => [s.id, s] as const));
  const codeExtensions = getLanguageProfile(language).codeExtensions;
  const isInitOnly = (s: Step): boolean => {
    const implementationOutputs = s.outputs.filter(
      (output) =>
        output.startsWith('src/') &&
        codeExtensions.some((extension) => output.endsWith(extension)),
    );
    return (
      implementationOutputs.length > 0 &&
      implementationOutputs.every((output) => output.endsWith('/__init__.py'))
    );
  };
  const iterationIdOf = (s: Step): string => s.iterationId ?? 'P1';

  // 谁能传递地依赖到 codeId？
  const transitivelyDepends = (test: Step, codeId: string): boolean => {
    const seen = new Set<string>();
    const stack = [...test.dependsOn];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (id === codeId) return true;
      const dep = stepById.get(id);
      if (dep) stack.push(...dep.dependsOn);
    }
    return false;
  };

  const codeSteps = withPairedTestAssets.filter((s) => s.phase === 'CODE' && !isInitOnly(s));
  const testSteps = withPairedTestAssets.filter((s) => s.phase === 'UNIT_TEST');
  const uncoveredByIteration = new Map<string, Step[]>();
  for (const codeStep of codeSteps) {
    const iterationId = iterationIdOf(codeStep);
    const covered = testSteps.some((testStep) =>
      iterationIdOf(testStep) === iterationId && transitivelyDepends(testStep, codeStep.id),
    );
    if (!covered) {
      const bucket = uncoveredByIteration.get(iterationId) ?? [];
      bucket.push(codeStep);
      uncoveredByIteration.set(iterationId, bucket);
    }
  }
  if (uncoveredByIteration.size === 0) return withPairedTestAssets;

  // 取末位编号 + 1 作为新 UNIT_TEST id（保留 S### 三位前导零）
  let maxNum = withPairedTestAssets.reduce((m, s) => {
    const mm = String(s.id).match(/^S(\d{3,})$/);
    return mm ? Math.max(m, parseInt(mm[1]!, 10)) : m;
  }, 0);
  const tsMode = language === 'typescript';
  const usedPaths = new Set(withPairedTestAssets.flatMap((step) => step.outputs));
  const syntheticSteps: Step[] = [];
  const uncoveredIds = new Set<string>();
  for (const [iterationId, uncovered] of uncoveredByIteration) {
    for (const codeStep of uncovered) uncoveredIds.add(codeStep.id);
    maxNum += 1;
    const newId = 'S' + String(maxNum).padStart(3, '0');
    const unitTestDoc = phaseDocForIteration('UNIT_TEST', iterationId);
    const testOutputs = uncovered.map((codeStep) => {
      const existing = codeStep.outputs.find((output) => isExecutableTestPath(output, language));
      if (existing) return existing;
      const testOutput = uniqueRunnableTestPath(codeStep, 'UNIT_TEST', language, usedPaths);
      usedPaths.add(testOutput);
      codeStep.outputs = dedup([...codeStep.outputs, testOutput]);
      return testOutput;
    });

    const targetTitles = uncovered.map((c) => `${c.id} (${c.title})`).join('、');
    syntheticSteps.push({
      id: newId,
      iterationId,
      phase: 'UNIT_TEST',
      title: `自动补齐单元测试：覆盖 ${uncovered.map((c) => c.id).join(' / ')}`,
      description:
        `Planner 未为 ${targetTitles} 显式生成 UNIT_TEST Step，由 calibration 自动追加。` +
        `Tester 只检查并执行 CODE 阶段已经生成的测试，记录验证结果。`,
      systemPrompt:
        `本 Step 是 calibration 自动追加的 UNIT_TEST 验证兜底，覆盖以下 CODE Step：${targetTitles}。\n` +
        `范围：读取并审查 ${testOutputs.join(', ')}，运行测试，只写 ${unitTestDoc ?? 'UNIT_TEST report'}；` +
        `禁止创建或修改 tests/** 与 src/**。\n` +
        `验收：测试完整性检查通过，所有既有测试在 ${tsMode ? 'npm test / Vitest' : 'pytest'} 下通过。`,
      role: 'Tester',
      tools: ['skill:tester'],
      inputs: dedup(uncovered.flatMap((c) => c.outputs)),
      outputs: unitTestDoc ? [unitTestDoc] : [],
      dependsOn: uncovered.map((c) => c.id),
      acceptance: tsMode
        ? `既有 Vitest 测试完整且全部通过，验证报告覆盖 ${uncovered.map((c) => c.id).join(' / ')}。`
        : `既有 pytest 测试完整且全部通过，验证报告覆盖 ${uncovered.map((c) => c.id).join(' / ')}。`,
      status: 'PENDING',
      retries: 0,
      maxRetries: 3,
    });
  }
  const syntheticByIteration = new Map(syntheticSteps.map((step) => [iterationIdOf(step), step]));
  const rewired = withPairedTestAssets.map((step) => {
    if (!(['INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'] as Step['phase'][]).includes(step.phase)) return step;
    const alreadyDependsOnTest = step.dependsOn.some((depId) => stepById.get(depId)?.phase === 'UNIT_TEST');
    if (alreadyDependsOnTest) return step;
    const touchesUncoveredCode = step.dependsOn.some((depId) => uncoveredIds.has(depId));
    if (!touchesUncoveredCode) return step;
    const synthetic = syntheticByIteration.get(iterationIdOf(step));
    if (!synthetic) return step;
    return {
      ...step,
      dependsOn: dedup([...step.dependsOn, synthetic.id]),
    };
  });

  return ensurePairedTestAssets([...rewired, ...syntheticSteps], language);
}

function ensurePairedTestAssets(steps: Step[], language: Language): Step[] {
  const out = steps.map((step) => ({
    ...step,
    inputs: dedup([...step.inputs]),
    outputs: dedup([...step.outputs]),
  }));
  const usedPaths = new Set(out.flatMap((step) => step.outputs));
  const iterationIds = dedup(out.map((step) => step.iterationId ?? 'P1'));

  for (const iterationId of iterationIds) {
    for (const [sourcePhase, testPhase] of Object.entries(V_MODEL_SOURCE_TO_TEST_PHASE) as Array<
      [Step['phase'], Step['phase']]
    >) {
      const sourceSteps = out.filter(
        (step) => (step.iterationId ?? 'P1') === iterationId && step.phase === sourcePhase,
      );
      const testSteps = out.filter(
        (step) => (step.iterationId ?? 'P1') === iterationId && step.phase === testPhase,
      );
      if (sourceSteps.length === 0) continue;

      const movedFromTests = testSteps.flatMap((step) =>
        step.outputs.filter((output) => isExecutableTestPath(output, language)),
      );
      for (const testStep of testSteps) {
        testStep.outputs = testStep.outputs.filter(
          (output) => !isExecutableTestPath(output, language),
        );
      }

      const sourceAssets = sourceSteps.flatMap((step) =>
        step.outputs.filter((output) => isExecutableTestPath(output, language)),
      );
      const declaredInputs = testSteps.flatMap((step) =>
        step.inputs.filter((input) => isExecutableTestPath(input, language)),
      );
      let testAssets = dedup([...sourceAssets, ...movedFromTests, ...declaredInputs]);
      const owner = sourceSteps[0]!;
      let assetsToAssign = dedup([...movedFromTests, ...declaredInputs])
        .filter((asset) => !sourceAssets.includes(asset));
      if (testAssets.length === 0) {
        const generated = uniqueRunnableTestPath(owner, testPhase, language, usedPaths);
        usedPaths.add(generated);
        testAssets = [generated];
        assetsToAssign = [generated];
      }
      owner.outputs = dedup([...owner.outputs, ...assetsToAssign]);

      const testCommand = language === 'typescript' ? 'npm test / Vitest' : 'pytest';
      const sourceMarker = 'V-model paired test authoring contract';
      for (const sourceStep of sourceSteps) {
        if (!sourceStep.systemPrompt.includes(sourceMarker)) {
          sourceStep.systemPrompt +=
            `\n\n${sourceMarker}（强制）：本 ${sourcePhase} 阶段必须依据当前阶段契约创建并维护` +
            `配对 ${testPhase} 的可执行测试，测试路径为 ${testAssets.join(', ')}；` +
            `测试应在后续 ${testPhase} 阶段运行，不得把编写工作推迟到验证阶段。` +
            `测试必须导入或执行 Plan 声明的真实产品模块与公开接口；禁止在测试文件内复制业务类型、` +
            `类、算法、渲染器、解析器或调度逻辑来构造不依赖产品代码的自测通过。` +
            `这些测试可以引用将在 CODE 阶段实现、当前尚不存在的 sourcePaths；` +
            `REQUIREMENT_ANALYSIS/HIGH_LEVEL_DESIGN/DETAILED_DESIGN 禁止为此提前创建 src/** stub、占位实现或产品代码。` +
            (sourcePhase === 'DETAILED_DESIGN'
              ? `每个集成测试必须实际引用至少两个参与集成的已声明产品源码（Plan 仅声明一个源码时除外）。`
              : '');
          sourceStep.acceptance +=
            ` 配对 ${testPhase} 测试用例存在、内容非空，并与本阶段的测试计划和验收契约一致。`;
        }
        sourceStep.tools = ensureEssentialToolRefs(sourceStep);
      }

      const validationMarker = 'V-model validation-only contract';
      for (const testStep of testSteps) {
        testStep.inputs = dedup([...testStep.inputs, ...testAssets]);
        if (!testStep.systemPrompt.includes(validationMarker)) {
          testStep.systemPrompt +=
            `\n\n${validationMarker}（强制）：本 ${testPhase} 阶段先检查 ${testAssets.join(', ')} ` +
            `与配对测试计划的完整性和一致性，再使用 ${testCommand} 运行这些既有测试；` +
            `只写声明的验证报告/交付文档，禁止创建、修改或删除 tests/** 与 src/**。` +
            `发现缺失、错误或失败时必须报告证据；若现有测试仍可能运行成功但语义覆盖不完整，` +
            `在 JSON 中填写 validationDefect 并设置 done=false，由 Engine 建立 Bug Ticket 并路由回 ${sourcePhase}。`;
          testStep.acceptance +=
            ` 既有测试用例完整性检查通过且 ${testCommand} 执行成功；本阶段未改写测试或产品代码。`;
        }
        testStep.tools = ensureEssentialToolRefs(testStep);
      }
    }
  }
  return out;
}

function uniqueRunnableTestPath(
  step: Step,
  testPhase: Step['phase'],
  language: Language,
  usedPaths: ReadonlySet<string>,
): string {
  const prefix = testPathPrefixForPhase(testPhase);
  const stepId = step.id.toLowerCase();
  const base = language === 'typescript'
    ? `tests/${prefix}_${stepId}`
    : `tests/test_${prefix}_${stepId}`;
  const extension = language === 'typescript' ? '.test.ts' : '.py';
  let candidate = `${base}${extension}`;
  let suffix = 2;
  while (usedPaths.has(candidate)) {
    candidate = `${base}_${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

// =============================================================================
// 5. Debugger 失败日志 → 可执行修复建议
// =============================================================================

/**
 * 一条修复建议。`severity` 仅用于排序展示，hint 必须是"立即可执行"的指令型表达，
 * 避免空话；推荐工具调用名一律用反引号包裹，便于 Debugger LLM 直接复制使用。
 */
export interface DebugSuggestion {
  /** 模式标识，便于审计/统计；不会展示给 LLM。 */
  code: string;
  /** 1=高优先 2=中 3=兜底 */
  severity: 1 | 2 | 3;
  /** 给 Debugger 看的 actionable 文本（一行）。 */
  hint: string;
  /** 命中的关键证据片段（截断），便于排错。 */
  evidence?: string;
}

interface SuggestionRule {
  code: string;
  severity: 1 | 2 | 3;
  /** 用 RegExp 数组匹配 failureLog；任一命中即触发。 */
  patterns: RegExp[];
  /** 可选排除条件；用于避免基础设施 LLM provider 错误被业务网络 API 规则误吸收。 */
  skip?: (text: string) => boolean;
  /** 可选单次命中排除条件；用于忽略测试断言里的 mock HTTP 文本等局部误报。 */
  ignoreMatch?: (m: RegExpExecArray, text: string) => boolean;
  /** 由匹配组生成 hint；m 为第一条命中正则的 RegExpExecArray。 */
  build: (m: RegExpExecArray) => string;
}

function networkApiStatusGuidance(log: string): string {
  const status = extractNetworkStatus(log);
  if (!status) {
    return '先区分是认证/权限、URL 不存在、限流、超时还是服务端故障；';
  }
  if (status === '401' || status === '403') {
    return `HTTP ${status} 表示认证/权限不可用：若用户未提供 key/token，必须切换到公开免 key/token API；若用户提供了凭证，先修正鉴权头/参数；`;
  }
  if (status === '404' || status === '410') {
    return `HTTP ${status} 表示 URL/资源不可用：不要重试同一地址，必须更换仍维护的 endpoint 或 API；`;
  }
  if (status === '429') {
    return 'HTTP 429 表示限流：优先切换免 key 且限流更宽的候选 API，或实现退避/缓存并用测试覆盖限流分支；';
  }
  if (status === '408') {
    return 'HTTP 408/超时表示当前接口时延不可接受：尝试更稳定的 API，并设置显式 timeout 与失败分支；';
  }
  if (/^5/u.test(status)) {
    return `HTTP ${status} 表示服务端故障：不要把它当成功降级，需切换可用 API 或提供明确失败退出路径；`;
  }
  return `HTTP ${status} 表示接口契约或请求参数不匹配：先核对参数/响应 schema，不匹配则切换更适合的 API；`;
}

function extractNetworkStatus(log: string): string | undefined {
  const patterns = [
    /\bHTTP\s*(?:status\s*)?(401|403|404|408|409|410|422|429|5\d\d)\b/i,
    /\bstatus(?:\s*code)?\s*[=:]?\s*(401|403|404|408|409|410|422|429|5\d\d)\b/i,
    /\b(?:api|request|fetch|接口|请求)\b[^\n]{0,80}\b(401|403|404|408|409|410|422|429|5\d\d)\b/i,
    /\b(401|403|404|408|409|410|422|429|5\d\d)\b[^\n]{0,80}\b(?:api|request|fetch|接口|请求)\b/i,
  ];
  for (const pattern of patterns) {
    const match = log.match(pattern)?.[1];
    if (match) return match;
  }
  return undefined;
}

function hasOnlyLoopbackNetworkEvidence(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.some(isLoopbackNetworkFailureLine)) return false;
  return !lines.some((line) => {
    if (isLoopbackNetworkFailureLine(line)) return false;
    if (/^\s*Network API failure detected(?:\.|$)/i.test(line)) return false;
    return /https?:\/\/(?!localhost\b|127(?:\.\d{1,3}){3}\b|\[?::1\]?\b)[^\s'")]+[^\n]{0,160}\b(?:failed|error|timeout|unreachable|unavailable|401|403|404|429|5\d\d)\b/i.test(line) ||
      /\b(?:api|http|request|network|connection|timeout|timed out)\b[^\n]{0,120}\b(?:401|403|404|429|5\d\d)\b/i.test(line);
  });
}

/**
 * 常见 Python 错误模式 → 可执行建议。
 * 顺序意义：上面的规则优先级更高（severity=1 也排在前），重复 code 只保留首条。
 *
 * 维护原则：
 *  - 只针对"LLM 实际反复踩坑"的错误加规则；不要堆砌教科书式提示。
 *  - hint 必须给"下一步具体动作"，不是"原因解释"。
 *  - 工具名（read_file/code_search/write_file/...）用反引号包裹，让 LLM 直接复制。
 */
const PYTHON_ERROR_RULES: SuggestionRule[] = [
  // —— 模块/路径类（用户最常见痛点） ————————————————————
  {
    code: 'ModuleNotFoundError-direct-script',
    severity: 1,
    // 命中：错误来自 tests/ 下的脚本，且缺失模块名是无点的"裸名"——典型的
    // "python tests/test_X.py 直接执行 → src/ 不在 sys.path" 场景。
    patterns: [
      /File\s+["'][^"']*\/tests\/[^"']+\.py["'][^]*?ModuleNotFoundError:\s*No module named ['"]([A-Za-z_][A-Za-z0-9_]*)['"]/,
    ],
    build: (m) => {
      const mod = m[1] ?? '<module>';
      return (
        `[直接 python 脚本执行测试导致 ModuleNotFoundError: ${mod}] ` +
        `**首选**改用 \`run_tests\`（pytest）执行——XCompiler 已自动写入 tests/conftest.py 注入 src/ 到 sys.path，pytest 模式下能直接解析。` +
        `如确需保留 \`python tests/test_X.py\` 直接运行，则用 \`read_file\` 打开测试文件，` +
        `在 import 之前插入：\`import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))\`，` +
        `再 \`replace_in_file\` 提交修改。**严禁**把 import 改成 "from src.${mod} import ..." 形式。`
      );
    },
  },
  {
    code: 'ModuleNotFoundError',
    severity: 1,
    patterns: [
      /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/,
      /ImportError:\s*No module named ['"]?([A-Za-z0-9_.]+)['"]?/,
    ],
    build: (m) => {
      const mod = m[1] ?? '<module>';
      const top = mod.split('.')[0]!;
      return (
        `[ModuleNotFoundError: ${mod}] 先用 \`list_dir\` 查看 src/ 实际目录结构，` +
        `再用 \`code_search\` 搜索 "${top}" 看真实文件名/路径。` +
        `若是项目内模块缺失：用 \`read_file\` 确认 outputs 是否真的写入了 ${mod.replace(/\./g, '/')}.py，` +
        `否则用 \`write_file\` 创建。` +
        `若是第三方包：用 \`add_dependency\` 把真实 PyPI 包名（不是 import 名！例如 cv2→opencv-python, sklearn→scikit-learn, PIL→pillow）写进 requirements.txt。` +
        `若当前代码 import 的库与 HIGH_LEVEL_DESIGN 的库选型不一致，优先改回设计选定的真实库并同步 add_dependency。` +
        `**严禁**在生产 src/ 代码里 try/except ImportError 后伪造 module、写 fallback fake class/function，或用 mock 代码绕过缺失依赖。` +
        `**绝不要**用 \`replace_in_file\` 提交 find===replace 的"假修复"。`
      );
    },
  },
  {
    code: 'ImportError-name',
    severity: 1,
    patterns: [
      /ImportError:\s*cannot import name ['"]([^'"]+)['"]\s*from\s*['"]?([A-Za-z0-9_.]+)['"]?/,
    ],
    build: (m) => {
      const name = m[1] ?? '<name>';
      const mod = m[2] ?? '<module>';
      return (
        `[ImportError: cannot import name '${name}' from '${mod}'] ` +
        `先 \`read_file\` 打开 ${mod.replace(/\./g, '/')}.py 确认实际定义的符号；` +
        `若拼写错误就 \`replace_in_file\` 修正 import；若符号未实现就回到对应模块用 \`write_file\`/\`apply_patch\` 补出来。`
      );
    },
  },
  {
    code: 'pytest-collection',
    severity: 1,
    patterns: [
      /ERROR\s+collecting/,
      /pytest exit=2\b/,
      /errors during collection/,
    ],
    build: () =>
      `[pytest collection error (exit=2)] 通常是 import 失败或测试文件语法错。` +
      `**第一步**用 \`run_tests\` 拿到完整 traceback（不要只看 exit code）；` +
      `**第二步**用 \`read_file\` 打开报错的测试文件 + 它 import 的模块文件，比对真实符号；` +
      `**第三步**针对真实差异做最小修改。禁止盲目 replace_in_file。`,
  },
  {
    code: 'src-prefix-import',
    severity: 1,
    patterns: [/from\s+src\.[A-Za-z0-9_]+\s+import/],
    build: (m) =>
      `[检测到 "from src.X import" 形式] XCompiler 约定 src/ 内模块互相 import 必须用 \`from <module> import\`（不带 src. 前缀）；` +
      `tests/ 也一样。请 \`read_file\` 确认 import 行，再 \`replace_in_file\` 把 "from src." 改为 "from "。证据: ${m[0]}`,
  },
  {
    code: 'stale-date-test-data',
    severity: 1,
    patterns: [
      /20\d{2}-\d{2}-\d{2}[\s\S]{0,1800}No upcoming holidays? found/i,
      /No upcoming holidays? found[\s\S]{0,1800}20\d{2}-\d{2}-\d{2}/i,
    ],
    build: () =>
      `[测试数据日期已过期] 失败是 hard-coded 日期相对当前日期已经变成过去时间，不是外部 API 不可用。` +
      `用 \`read_file\` 打开失败测试，把固定日期改成基于 \`datetime.now().date() + timedelta(days=N)\` 生成的未来日期；` +
      `随后 \`run_tests\` 验证。只有出现真实 HTTP 状态码、DNS/连接/超时异常时，才按网络 API 失败切换接口。`,
  },
  {
    code: 'llm-context-too-large',
    severity: 1,
    patterns: [
      /prefill_memory_exceeded/i,
      /(?:prefill memory guard|dynamic ceiling|context length|context window|token limit|too many tokens|prompt too long|max(?:imum)? context|input[^\n]{0,80}tokens)/i,
    ],
    build: () =>
      `[LLM/provider 上下文超限] 当前失败来自 XCompiler 到 LLM provider 的 prompt/token 容量限制，` +
      `不是项目业务代码缺陷。请压缩 Debug 历史、裁剪 failureLog/上下文片段、拆分过大的 Step 或降低一次性注入的文件内容后重跑当前 step；` +
      `不要让 Debugger 为此修改业务代码，也不要把该错误回退到 V 模型业务阶段。`,
  },
  {
    code: 'llm-transport-failure',
    severity: 1,
    patterns: [
	      /^TypeError:\s*fetch failed\s*$/m,
	      /(?:LLM|provider|OpenAI|Ollama)[^\n]{0,120}(?:fetch failed|connection|timeout|unreachable)/i,
	      /(?:LLM|provider|OpenAI|Ollama|OpenRouter)[^\n]{0,180}(?:HTTP 429|rate[- ]?limit|rate limited|rate-limited|retry-after|retry_after_seconds)/i,
	      /(?:response_format|json_object|json_schema)[^\n]{0,220}(?:not support|unsupported|invalid_request_body|supported formats)/i,
	    ],
	    build: () =>
	      `[LLM/provider 传输或协议能力失败] 当前失败没有项目 API URL 或 HTTP 状态，优先按 XCompiler 到 LLM provider 的连接/能力问题处理：` +
	      `检查 \`OPENAI_BASE_URL\` / \`OPENROUTER_BASE_URL\` / provider base_url、模型服务是否可达、限流/配额、超时设置、网络权限，以及 provider 是否支持当前结构化输出格式。` +
	      `不要把这个错误当成项目源码缺陷，也不要让 Debugger 为此修改业务代码；恢复 provider 后重新运行当前 step。`,
  },
  {
    code: 'network-api-failure',
    severity: 1,
    skip: (text) => isLlmProviderFailureText(text) || hasOnlyLoopbackNetworkEvidence(text),
    ignoreMatch: (m, text) => isTestAssertionDiagnosticLine(lineAtIndex(text, m.index)),
    patterns: [
      /Network API failure detected/i,
      /https?:\/\/[^\s'")]+[^\n]{0,160}\b(?:failed|error|timeout|unreachable|unavailable|401|403|404|429|5\d\d)\b/i,
      /\b(?:api|http|request|network|connection|timeout|timed out)\b[^\n]{0,120}\b(?:401|403|404|429|5\d\d)\b/i,
      /(?:网络|接口|API|HTTP|请求|连接|超时|限流|不可用)[^\n]{0,120}(?:失败|错误|异常|超时|拒绝|不可达|不可用|限流)/,
    ],
    build: (m) =>
      `[网络 API 调用失败] 本任务必须判定失败，禁止用静态假数据、吞异常或仅展示“降级成功”来过关。` +
      networkApiStatusGuidance(m.input) +
      `请先定位失败的 API URL 与响应/异常；若接口不可达、格式不符、限流或返回错误状态，必须更换为当前可用且适合需求的 API，` +
      `并补充测试覆盖成功路径与失败路径。最多连续做 2 次 \`http_fetch\` 探测；一旦确认候选接口可用且 body 非空/格式可解析，` +
      `必须立刻 \`read_file\` 定位源码并用 \`apply_patch\` / \`replace_in_file\` 修改真实集成，随后 \`run_program\` 验证入口不再输出 API 失败。`,
  },
  {
    code: 'network-api-probe-loop',
    severity: 1,
    patterns: [
      /tool calls:[\s\S]*(?:http_fetch).*(?:http_fetch)/i,
      /http_fetch[\s\S]{0,400}(?:FAIL|失败)[\s\S]{0,400}http_fetch/i,
      /http_fetch[\s\S]{0,400}(?:200|OK|成功)[\s\S]{0,200}(?:0B|0 字节|body 为空)/i,
    ],
    build: () =>
      `[网络 API 探测循环] 已经出现多次 \`http_fetch\`，下一轮必须停止继续枚举接口。` +
      `先 \`read_file\` / \`code_search\` 找到失败 URL 所在源码；选择最近一次非空、格式可解析且适合需求的候选 API，` +
      `或换一个明确有文档的无 Key API；然后 patch 源码并用 \`run_program\` 运行入口验证。` +
      `HTTP 200 但 0B/空 body 不是可用 API，不能据此 done=true。`,
  },

  // —— 名称/属性 ——————————————————————————————
  {
    code: 'NameError',
    severity: 2,
    patterns: [/NameError:\s*name ['"]([^'"]+)['"] is not defined/],
    build: (m) =>
      `[NameError: ${m[1]}] 先 \`code_search\` 这个名字看是否漏 import 或拼写错；` +
      `再 \`read_file\` 当前文件检查作用域。修复手段：补 import 或改名。`,
  },
  {
    code: 'AttributeError-module-api',
    severity: 1,
    patterns: [
      /AttributeError:\s*module ['"]([^'"]+)['"] has no attribute ['"]([^'"]+)['"]/,
      /module ['"]([^'"]+)['"] has no attribute ['"]([^'"]+)['"]/,
    ],
    build: (m) => {
      const mod = m[1] ?? '<module>';
      const attr = m[2] ?? '<attribute>';
      return (
        `[第三方库 API 不存在: ${mod}.${attr}] 当前导入的库没有这个入口。` +
        `先用 \`code_search\` 查找 "${mod}.${attr}" 调用点，再 \`read_file\` 打开对应源码；` +
        `若是库选型错误，改用 HIGH_LEVEL_DESIGN 中确认且真实支持该领域格式的库，并用 \`add_dependency\` 写入真实包名；` +
        `若只是 API 名称错误，替换为该库真实存在的等价 API。` +
        `禁止在生产 src/ 里伪造 fallback/mock 来绕过该错误。`
      );
    },
  },
  {
    code: 'mock-patch-target-src-prefix',
    severity: 1,
    patterns: [/@patch\(['"]src\./, /patch\(['"]src\./],
    build: () =>
      `[测试 patch 目标使用了 src. 前缀] 测试文件按 XCompiler 约定应导入裸模块名，因此 mock 也必须 patch 运行时实际引用的模块名。` +
      `用 \`read_file\` 对照测试 import 与被测文件 import，把 \`@patch('src.<module>.<name>')\` 改成 \`@patch('<module>.<name>')\` 或 patch 调用方模块里的符号。` +
      `不要为了让 mock 通过而削弱断言；应修正 patch 目标与真实导入契约。`,
  },
  {
    code: 'AttributeError',
    severity: 2,
    patterns: [/AttributeError:\s*['"]?([^'"\s]+)['"]?\s*object has no attribute ['"]([^'"]+)['"]/],
    build: (m) =>
      `[AttributeError: ${m[1]} 无属性 ${m[2]}] 先 \`code_search\` 这个属性的真实名字（常见 typo / 大小写 / 单复数）；` +
      `若是第三方库 API 变更，\`read_file\` 该模块文档或换等价 API。`,
  },
  {
    code: 'TypeError-args',
    severity: 2,
    patterns: [
      /TypeError:\s*([A-Za-z_][A-Za-z0-9_]*)\(\)\s*(?:missing|takes|got|requires)[^\n]+/,
    ],
    build: (m) =>
      `[TypeError 函数签名不匹配: ${m[1]}] \`read_file\` 看 ${m[1]} 的真实参数列表，再修正调用点；` +
      `不要随手改函数签名（会破坏其它调用）。`,
  },

  // —— 语法/缩进 ——————————————————————————————
  {
    code: 'SyntaxError',
    severity: 1,
    patterns: [/SyntaxError:[^\n]+/, /IndentationError:[^\n]+/, /TabError:[^\n]+/],
    build: (m) =>
      `[${m[0].split(':')[0]}] 用 \`read_file\` 把整段函数读出来核对缩进/括号配对；` +
      `若是分块 \`append_file\` 拆断了函数体，优先用 \`apply_patch\` / \`replace_in_file\` 修复；` +
      `需要整文件重写时必须低于当前运行时 chunk limit，或按函数/类边界重新分块。`,
  },

  // —— 文件 IO ——————————————————————————————
  {
    code: 'FileNotFoundError-test-fixture',
    severity: 1,
    // 命中：traceback 含 tests/ 路径且缺失文件是相对裸名（典型测试 fixture，如 'sample.csv'）。
    // 同时支持 Python 标准 traceback `File "tests/x.py"` 与 pytest 短格式 `tests/x.py:NN:`。
    patterns: [
      /(?:File\s+["']|^|\s)[^"'\s]*tests\/[^"'\s]+\.py(?:["']|:)[^]*?FileNotFoundError:[^\n]*['"]([^'"/\\:]+\.[A-Za-z0-9]+)['"]/,
    ],
    build: (m) => {
      const f = m[1] ?? '<fixture>';
      return (
        `[测试用 fixture 文件未生成: ${f}] 测试代码引用了真实磁盘文件但没人创建它。可选修复（按推荐顺序）：` +
        `(1) 先 \`list_dir\` / \`read_file\` 查找用户或工作区是否已有同类型真实样例；若有，用它作为测试输入或复制到 tests/fixtures/${f}；` +
        `(2) 若这是第三方/行业标准格式且工作区无样例，用 \`http_fetch\` 获取官方文档、上游仓库或公开示例中的小型参考文件，` +
        `保存到 tests/fixtures/${f}，并在测试报告或测试注释中记录来源；` +
        `(3) 只有 CSV/JSON/INI 等简单文本格式，且能立即 \`run_tests\` 验证时，才可用 pytest \`tmp_path\` 构造最小样例；` +
        `(4) 网络不可用、用户未提供样例且无法确认格式标准时，应明确报告 blocker 请求用户提供样例。` +
        `**严禁**凭记忆反复编造复杂领域 fixture，或单纯把硬编码路径改成另一个不存在的路径。`
      );
    },
  },
  {
    code: 'FileNotFoundError',
    severity: 2,
    patterns: [/FileNotFoundError:[^\n]*['"]([^'"]+)['"]/],
    build: (m) =>
      `[FileNotFoundError: ${m[1]}] 先 \`list_dir\` 确认路径是否真的存在；` +
      `若测试期望的资源未生成，回 CODE 输出该文件；若路径硬编码错误，\`replace_in_file\` 修正路径。`,
  },

  // —— Fixture 内容格式错误 ——————————————————————————————
  // 测试已运行，但被测函数在解析 fixture 时报"Invalid syntax / Parse error / Malformed"。
  // LLM 反应模式常常是"反复重跑测试"或凭记忆重写复杂样例；这里强制先找真实/权威参考。
  {
    code: 'fixture-content-malformed',
    severity: 1,
    patterns: [
      /Invalid syntax at line\s+(\d+)(?:,\s*column\s+\d+)?/i,
      /(?:Parse(?:r)?Error|MalformedError|DecodeError(?!-Unicode))[:\s][^\n]+/,
      /(?:failed to parse|unable to parse|cannot parse|invalid format)\b[^\n]+/i,
    ],
    build: (m) => {
      const where = m[1] ? `（line ${m[1]}）` : '';
      return (
        `[Fixture 内容格式错误${where}] 测试已经能跑起来，但被测函数在解析输入文件时拒绝了内容——` +
        `这通常意味着**fixture 文件本身写错了**（不是被测代码的 bug，也不是测试逻辑的 bug）。修复路径：` +
        `(1) 用 \`read_file\` 打开测试文件和 tests/fixtures/<file> 看清 fixture 的真实内容；如果样例是测试里的内联常量，也要修该测试文件里的常量；` +
        `(2) 根据扩展名、被测解析库和错误信息确认格式标准，先查找工作区/用户提供的真实样例；` +
        `(3) 若本地没有可靠样例，用 \`http_fetch\` 下载官方文档、上游测试仓库或公开标准示例中的小型参考文件，再用 \`write_file\` 整文件重写 tests/fixtures/<file>；` +
        `(4) 只有简单文本格式才允许自己构造最小样例，并且必须马上 \`run_tests\` 验证；复杂领域格式连续失败后必须停止编造并请求用户提供样例或网络参考。` +
        `**严禁**因为这条错误就去改被测模块或测试断言，也严禁凭记忆反复生成复杂格式 fixture。`
      );
    },
  },

  // —— 依赖安装 ——————————————————————————————
  {
    code: 'pip-resolver',
    severity: 2,
    patterns: [
      /Could not find a version that satisfies the requirement\s+([A-Za-z0-9._-]+)/,
      /ERROR: No matching distribution found for\s+([A-Za-z0-9._-]+)/,
    ],
    build: (m) =>
      `[pip 解析失败: ${m[1]}] 该包名/版本不存在。\`add_dependency\` 重写为真实 PyPI 包名并去掉版本约束；` +
      `常见映射：sklearn→scikit-learn, cv2→opencv-python, PIL→pillow, yaml→PyYAML, bs4→beautifulsoup4, serial→pyserial。`,
  },

  // —— 编码/路径 ——————————————————————————————
  {
    code: 'UnicodeDecodeError',
    severity: 3,
    patterns: [/UnicodeDecodeError:[^\n]+/],
    build: () =>
      `[UnicodeDecodeError] 打开二进制文件用 \`open(..., "rb")\`；文本读 UTF-8 显式 \`encoding="utf-8"\`，` +
      `必要时加 \`errors="replace"\`。`,
 },

// —— Executor 工具反馈 ——————————————————————————————
{
  code: 'replace-missing-path',
  severity: 1,
  patterns: [/invalid replace_in_file args: path must be a non-empty string/i],
  build: () =>
    `[replace_in_file 缺少 path] 你调用了 replace_in_file 但没有提供 args.path。` +
    `args.path 是目标文件的相对路径（取自当前 Step writable allowlist），必填且不能为空。` +
    `请从 writable allowlist 或 required outputs 中选取目标文件路径，重新提交包含 path、find、replace 三个字段的 replace_in_file 调用。`,
},
{
  code: 'replace-no-op',
 severity: 1,
 patterns: [/no-op edit refused: find === replace/],
 build: () =>
   `[replace_in_file 被拒：find===replace] 你提交了无意义的相同字符串替换。` +
   `请先 \`read_file\` 看清原文，再给出**真正不同**的 replace；如只是想确认内容用 \`read_file\`，不要走 \`replace_in_file\`。`,
 },
 {
   code: 'replace-not-found',
   severity: 2,
   patterns: [/expected \d+ occurrences of find, found 0 in/],
    build: () =>
      `[replace_in_file: find 未命中] 文件实际内容与你假设不一致。` +
      `立即 \`read_file\` 完整读出该文件，按真实字节构造 find；连续 2 次仍失败请改用 \`write_file\` 整文件重写。`,
  },
];

function collectDebugSuggestions(text: string): DebugSuggestion[] {
  const out: DebugSuggestion[] = [];
  const seen = new Set<string>();
  for (const rule of PYTHON_ERROR_RULES) {
    if (seen.has(rule.code)) continue;
    if (rule.skip?.(text)) continue;
    for (const re of rule.patterns) {
      const m = re.exec(text);
      if (m && !rule.ignoreMatch?.(m, text)) {
        seen.add(rule.code);
        out.push({
          code: rule.code,
          severity: rule.severity,
          hint: rule.build(m),
          evidence: m[0].slice(0, 200),
        });
        break;
      }
    }
  }
  out.sort((a, b) => a.severity - b.severity);
  return out;
}

function isLlmProviderFailureText(text: string): boolean {
  return /all llm providers failed|openai-compatible provider request failed|provider_call_failed/i.test(text) ||
    /(?:OpenAI|Ollama|OpenRouter|LLM|provider|response_format|json_object|json_schema)[^\n]{0,420}(?:HTTP\s+(?:401|403|408|409|429|5\d\d)|rate[- ]?limit|rate limited|rate-limited|retry-after|retry_after_seconds|fetch failed|network connection lost|stream (?:wall-clock|idle)|context (?:length|window)|token limit|prompt too long|prefill_memory_exceeded|not support|unsupported|invalid_request_body|supported formats)/i.test(text);
}

function lineAtIndex(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? undefined : end);
}

function latestFailureSlice(text: string): string {
  const markers = [
    /(?:^|\n)\s*-\s*(?:run_tests|run_program)\s+(?:失败|failed\b|FAIL\b)/giu,
    /(?:^|\n)\s*(?:run_tests|run_program)[^\n]*(?:失败|failed\b|FAIL\b)/giu,
  ];
  let last = -1;
  for (const marker of markers) {
    let match: RegExpExecArray | null;
    while ((match = marker.exec(text)) !== null) {
      last = Math.max(last, match.index);
    }
  }
  if (last < 0) return '';
  return text.slice(last).trim();
}

/**
 * 把 Debugger 的失败日志（含 reason / pytest tail / tool calls）解析为一组建议。
 * 调用方应把结果拼到下一轮 Debugger 的 system / user prompt 中，引导其走出循环。
 *
 * - 同一 code 只保留首条命中
 * - 先聚焦最后一次工具失败段，避免历史错误覆盖当前失败证据
 * - 按 severity 升序、规则顺序输出
 * - 最多返回 6 条，避免淹没真正的 traceback
 */
export function calibrateDebugSuggestions(
  failureLog: string,
  reason?: string,
): DebugSuggestion[] {
  const text = `${reason ?? ''}\n${failureLog ?? ''}`;
  if (!text.trim()) return [];
  const focused = latestFailureSlice(text);
  const focusedSuggestions = focused ? collectDebugSuggestions(focused) : [];
  const suggestions = focusedSuggestions.length > 0 ? focusedSuggestions : collectDebugSuggestions(text);
  return suggestions.slice(0, 6);
}

/** 把建议数组渲染成可直接拼入 prompt 的 markdown 段（含编号 + 证据）。 */
export function renderDebugSuggestions(sugs: DebugSuggestion[]): string {
  if (sugs.length === 0) return '';
  const lines: string[] = ['## 修复建议（按优先级，必须遵循）'];
  sugs.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.hint}`);
    if (s.evidence) lines.push(`   - 证据: \`${s.evidence.replace(/`/g, "'")}\``);
  });
  return lines.join('\n');
}
