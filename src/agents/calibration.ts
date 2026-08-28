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
import {
  isExecutableTestPath,
  isRuntimeOwnedVerificationTestPath,
  verificationSupplementRoot,
} from '../core/test_assets.js';
import {
  baselineDeliveryGate,
  type DevelopmentDeliveryGateStage,
  verificationDeliveryGate,
} from '../domain/quality/delivery_gate.js';

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
  'docs/project-topic.md': DOC_NAMES.topic,
  'docs/project_topic.md': DOC_NAMES.topic,
  'docs/project-topic.txt': DOC_NAMES.topic,
  'docs/topic.txt': DOC_NAMES.topic,
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
    let inputs = dedup((s.inputs ?? []).map((p) => iterationScopedInput(remap(p), s.phase, iterationId)));
    if (s.phase === 'REQUIREMENT_ANALYSIS' && !inputs.includes(DOC_NAMES.topic)) {
      inputs = [DOC_NAMES.topic, ...inputs];
    }
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
      return { ...s, inputs, outputs, acceptance: withOutcomeAssertionRequirement(s.acceptance) };
    }
    return { ...s, inputs, outputs };
  });
}

/**
 * Requires the acceptance level to check what the product produced, not merely its shape.
 *
 * Stated as a requirement rather than detected afterwards: whether an assertion examines a value or
 * its type cannot be told apart from source text with any reliability. A delivered project passed
 * 115 assertions of the form `expect(typeof item.title).toBe('string')` while every one of its
 * hundred records carried the same summary twice — every field present, every type right, the
 * content wrong. The Phase delivery gate judges the same question against the run's real output, so
 * a suite that ignores this is caught there; saying it here is what gives the Step a chance to get
 * it right the first time.
 *
 * Phrased without reference to any domain, because the Step it instructs may be verifying a
 * scraper, a compiler, a migration, or a report.
 */
function withOutcomeAssertionRequirement(acceptance: string | undefined): string {
  const requirement = 'Acceptance cases must assert what the produced result contains — exact ' +
    'values, ranges, ordering, counts, or the absence of wrong content — not merely that a field ' +
    'exists and has the expected type. A suite that only checks shape passes on output that is ' +
    'duplicated, empty, or nonsense for the field it fills.';
  const text = (acceptance ?? '').trim();
  return text.includes('assert what the produced result contains') || text.includes(requirement)
    ? text
    : [text, requirement].filter(Boolean).join(' ');
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

/**
 * Expands Planner globs only when they resolve to concrete outputs in the same StepPlan.
 *
 * Step inputs are an auditable artifact graph, not shell selectors. Models nevertheless copy
 * patterns such as `src/**\/*.ts` from tsconfig conventions. Expanding a matched pattern preserves
 * the intended dependency while keeping lint strict: an unmatched glob remains unchanged and is
 * rejected as an unowned input instead of being silently accepted.
 */
export function calibrateProducedInputGlobs(steps: Step[]): Step[] {
  const outputs = dedup(steps.flatMap((step) => step.outputs)).sort();
  return steps.map((step) => ({
    ...step,
    inputs: dedup(step.inputs.flatMap((input) => {
      if (!hasPathGlob(input)) return [input];
      const matches = outputs.filter((output) => globPathMatches(input, output));
      return matches.length > 0 ? matches : [input];
    })),
  }));
}

function hasPathGlob(value: string): boolean {
  return /[*?]/u.test(value);
}

function globPathMatches(pattern: string, candidate: string): boolean {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`${source}$`, 'u').test(candidate);
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
  'skill:artifact-authoring',
  'skill:focused-file-editing',
  'skill:file-operations',
  'skill:test-design',
  'skill:test-execution',
  'skill:systematic-debugging',
  'skill:behavior-preserving-refactoring',
]);

import { DEPENDENCY_MANIFEST_OWNER } from '../domain/steps/step.js';

const PHASE_DEFAULT_TOOLS: Record<string, string[]> = {
  REQUIREMENT_ANALYSIS: ['skill:artifact-authoring', 'skill:test-design'],
  // The phase that owns the manifest is handed the dependency Skill. An earlier capability existed
  // but was wired to nobody, so the Step every dependency Change Request routes to could not act.
  HIGH_LEVEL_DESIGN: ['skill:artifact-authoring', 'skill:test-design', 'skill:dependency-resolution'],
  DETAILED_DESIGN: ['skill:artifact-authoring', 'skill:test-design'],
  // CODE owns both build/static validation and the executable unit baseline gate.
  CODE: ['skill:artifact-authoring', 'skill:test-design', 'run_program', 'run_tests'],
  UNIT_TEST: ['skill:test-execution', 'skill:record-replay-fixtures'],
  INTEGRATION_TEST: ['skill:test-execution', 'skill:record-replay-fixtures'],
  MODULE_TEST: ['skill:test-execution', 'skill:record-replay-fixtures'],
  FUNCTIONAL_TEST: ['skill:test-execution', 'skill:record-replay-fixtures', 'skill:verification-before-delivery'],
};

// Phases whose defaults are merged in rather than used only as a fallback. A verification phase
// cannot verify without a runner, and the manifest owner cannot own a manifest it has no tool to
// edit — in both cases the planner's list is a preference, not the whole story.
const PHASE_DEFAULT_TOOLS_REQUIRED = new Set([
  DEPENDENCY_MANIFEST_OWNER,
  'CODE',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'MODULE_TEST',
  'FUNCTIONAL_TEST',
]);

/**
 * Reading is a precondition of every contract a Step is held to, not a capability a plan may omit.
 *
 * A planner that declared only write tools left three of the four development phases unable to read
 * anything. A Change Request disposition requires inspecting the affected artifacts before it can be
 * recorded; a Step that cannot inspect produces no valid completion and spends its whole round
 * budget — which is exactly how a downstream dependency re-check stalled with no tool call at all.
 */
const ALWAYS_AVAILABLE_TOOL_REFS = ['read_file', 'list_dir'] as const;

/**
 * Development phases own paired baseline suites, and their delivery gate can require executing them.
 *
 * S1-S3 defer that execution only on the initial pre-CODE pass; a correction routed back from CODE
 * or any right-side Step proves a product baseline exists, and the gate then requires the run. The
 * runner is injected automatically at that point — but only if the Step has it, and none of the
 * three had it, so the requirement passed silently without a single test being executed.
 */
const BASELINE_OWNING_PHASES = new Set([
  'REQUIREMENT_ANALYSIS',
  'HIGH_LEVEL_DESIGN',
  'DETAILED_DESIGN',
  'CODE',
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
  if (!needsWritableOutputs || hasWriteCapability) {
    return withBaselineRunner(withReadAccess(withChunkedWritePair), step.phase);
  }
  return withBaselineRunner(
    withReadAccess(
      ensureChunkedWritePair([...baseTools, ...(phaseDefaults.length > 0 ? phaseDefaults : ['write_file'])]),
    ),
    step.phase,
  );
}

/** A skill that already carries reading satisfies this; only a Step with no reader gains one. */
function withReadAccess(tools: string[]): string[] {
  const missing = ALWAYS_AVAILABLE_TOOL_REFS.filter((tool) => !tools.includes(tool));
  return missing.length === 0 ? tools : dedup([...tools, ...missing]);
}

/** Holding the runner does not run anything: the gate decides, and only `execute` injects a run. */
function withBaselineRunner(tools: string[], phase: string): string[] {
  if (!BASELINE_OWNING_PHASES.has(phase) || tools.includes('run_tests')) return tools;
  return dedup([...tools, 'run_tests']);
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
 *  - maxAttempts 非正整数 -> 重置为 3
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
      maxAttempts:
        typeof s.maxAttempts === 'number' && Number.isInteger(s.maxAttempts) && s.maxAttempts > 0
          ? s.maxAttempts
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
 * MODULE_TEST 消费这些基线，并只在自己的隔离命名空间按风险追加补充测试。
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
 * 兜底保证每个左侧阶段拥有配对的可执行基线测试。右侧测试阶段独立检查基线、
 * 在自己的隔离目录按风险补充测试、冻结并执行完整集合。若缺少 UNIT_TEST 宏 Step，
 * 则补充一个遵循相同门禁的验证 Step；基线测试文件仍由 CODE 阶段拥有。
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
    const supplementalRoot = verificationSupplementRoot({
      id: newId,
      iterationId,
      phase: 'UNIT_TEST',
    });
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
        `Tester 独立检查 CODE 基线，按风险补充、冻结并执行完整测试集合。`,
      systemPrompt:
        `本 Step 是 calibration 自动追加的 UNIT_TEST 验证兜底，覆盖以下 CODE Step：${targetTitles}。\n` +
        `范围：读取并审查 ${testOutputs.join(', ')}；只允许在 ${supplementalRoot} 新增风险补充测试，` +
        `冻结“基线 + 补充”集合后运行测试，并写 ${unitTestDoc ?? 'UNIT_TEST report'}；` +
        `禁止修改配对基线测试与 src/**。\n` +
        `验收：测试完整性检查通过，冻结集合在 ${tsMode ? 'npm test / Vitest' : 'pytest'} 下全部通过。`,
      role: 'Tester',
      tools: ['skill:test-execution', 'skill:record-replay-fixtures'],
      inputs: dedup(uncovered.flatMap((c) => c.outputs)),
      outputs: unitTestDoc ? [unitTestDoc] : [],
      dependsOn: uncovered.map((c) => c.id),
      acceptance: tsMode
        ? `Vitest 基线与风险补充测试完整、冻结且全部通过，验证报告覆盖 ${uncovered.map((c) => c.id).join(' / ')}。`
        : `pytest 基线与风险补充测试完整、冻结且全部通过，验证报告覆盖 ${uncovered.map((c) => c.id).join(' / ')}。`,
      maxAttempts: 3,
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
    inputs: dedup(step.inputs.filter((path) => !isRuntimeOwnedVerificationTestPath(path))),
    outputs: dedup(step.outputs.filter((path) => !isRuntimeOwnedVerificationTestPath(path))),
    deliveryGate: step.deliveryGate ?? (
      (['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE'] as Step['phase'][])
        .includes(step.phase)
        ? baselineDeliveryGate(step.id, step.phase as DevelopmentDeliveryGateStage)
        : verificationDeliveryGate(step.id)
    ),
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

      const validationMarker = 'V-model independent acceptance contract';
      for (const testStep of testSteps) {
        testStep.inputs = dedup([...testStep.inputs, ...testAssets]);
        const supplementalRoot = verificationSupplementRoot(testStep);
        if (!testStep.systemPrompt.includes(validationMarker)) {
          testStep.systemPrompt +=
            `\n\n${validationMarker}（强制）：本 ${testPhase} 阶段先检查 ${testAssets.join(', ')} ` +
            `与配对测试计划的完整性和一致性，执行风险分析；只允许在 ${supplementalRoot} ` +
            `新增本阶段拥有的聚焦补充测试，禁止修改配对基线测试和 src/**。` +
            `补充完成后冻结“基线 + 补充”测试集，再使用 ${testCommand} 完整执行。` +
            `涉及外部数据时使用 Record/Replay 保持可复现；真实用户场景由 Phase 交付门禁统一执行。` +
            `每个独立问题写入 qualityAssessment.findings，并提供同一问题重现时稳定复用的机器 code；基线测试缺陷使用 test-defect + paired-source，` +
            `补充测试缺陷使用 test-defect + current-step，` +
            `产品缺陷使用 product-defect，测试不完整使用 test-incomplete，依赖问题使用 dependency。`;
          testStep.acceptance +=
            ` 基线与风险补充测试已冻结并由 ${testCommand} 执行成功；本阶段未改写基线测试或产品代码。`;
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
// 5. Debugger 失败日志 → 修复知识
// =============================================================================
//
// Removed. This section held ~26 regex rules that turned a failure log into prescriptive repair
// instructions, and nothing in production called them: `calibrateDebugSuggestions` and
// `renderDebugSuggestions` had only test callers, so every bundle tree-shook the table away. The
// rules were never wrong — measured against three live runs they fired 55 times with no false
// positive, and one of them held the exact diagnosis for a defect that later took a manual
// investigation to find. They simply never reached a model.
//
// That knowledge belongs in the Debug Wiki (`src/core/debug_wiki.ts`, `debug-wiki/wiki/**`), which
// is retrieved for real and beats a static table on every axis that matters here: it matches on the
// DebugBrief rather than on raw prose, it records use and confidence so a bad entry decays, and it
// presents itself to the model as a hypothesis rather than as a command. The general rules were
// migrated there; `calibration-fixtures` and `calibration-python-imports` name the rules they came
// from in their `evidence`.
//
// Deliberately not migrated: entries that only restate a traceback the model already reads
// (NameError, AttributeError, TypeError-args, SyntaxError, UnicodeDecodeError), and one rule keyed
// to a single past project's domain ("No upcoming holidays found").
//
// The live path for a failure is now: buildDebugBrief → category + debugDemand (always), then
// DebugWiki.search(brief) → up to 3 ranked entries.
