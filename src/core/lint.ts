import {
  PHASE_ORDER,
  REQUIRED_V_MODEL_PHASES,
  V_MODEL_SOURCE_TO_TEST_PHASE,
  type ComplexityAssessment,
  type Phase,
  type Plan,
  type Step,
} from './plan.js';
import { DOC_NAMES, deliveryDocsForIteration, phaseDocForIteration, testPlanDocForIteration } from './docs.js';
import { getLanguageProfile } from './language.js';
import { analyzeArchitectureDemand, validateArchitectureContract } from './architecture.js';
import { stepTransitivelyDependsOn } from './workflow_state.js';
import { isExecutableTestPath } from './test_assets.js';

export interface LintIssue {
  level: 'error' | 'warn';
  stepId?: string;
  message: string;
}

export class PlanLintError extends Error {
  constructor(public readonly issues: LintIssue[]) {
    super(
      `Plan lint failed with ${issues.length} issue(s):\n` +
        issues.map((i) => `  [${i.level}] ${i.stepId ?? '*'}: ${i.message}`).join('\n'),
    );
    this.name = 'PlanLintError';
  }
}

export function lintPlan(plan: Plan): LintIssue[] {
  const issues: LintIssue[] = [];
  const ids = new Set<string>();
  const profile = getLanguageProfile(plan.language);

  // 1. unique ids + dependsOn closure
  for (const s of plan.steps) {
    if (ids.has(s.id)) issues.push({ level: 'error', stepId: s.id, message: 'Duplicate step id' });
    ids.add(s.id);
  }
  for (const s of plan.steps) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) {
        issues.push({ level: 'error', stepId: s.id, message: `dependsOn ${dep} not found` });
      }
    }
  }

  const implementationPhases = plan.implementationPhases ?? [];
  const implementationPhaseIds = new Set(implementationPhases.map((phase) => phase.id));
  const plannedOrCurrentImplementationPhases = implementationPhases.filter((phase) => phase.status !== 'deferred');
  const currentImplementationPhases = implementationPhases.filter((phase) => phase.status === 'current');
  const currentIterationIds = new Set(currentImplementationPhases.map((phase) => phase.id));
  const iterationOrder = new Map(implementationPhases.map((phase, index) => [phase.id, index]));
  const stepIterationId = (step: Step): string => step.iterationId ?? 'P1';
  const stepIterationOrder = (step: Step): number => iterationOrder.get(stepIterationId(step)) ?? 0;

  for (const step of plan.steps) {
    const iterationId = stepIterationId(step);
    if (implementationPhases.length > 0 && !implementationPhaseIds.has(iterationId)) {
      issues.push({
        level: 'error',
        stepId: step.id,
        message: `Step iterationId ${iterationId} is not declared in implementationPhases.`,
      });
    }
    if (implementationPhases.length > 0 && !currentIterationIds.has(iterationId)) {
      issues.push({
        level: 'error',
        stepId: step.id,
        message:
          `Step belongs to non-current implementation phase ${iterationId}; ` +
          `planned/deferred phases stay in PhasePlan until loaded as the current phase.`,
      });
    }
  }

  for (const iteration of currentImplementationPhases) {
    const iterationSteps = plan.steps.filter((step) => stepIterationId(step) === iteration.id);
    const phases = new Set(iterationSteps.map((s) => s.phase));
    for (const phase of REQUIRED_V_MODEL_PHASES) {
      if (!phases.has(phase)) {
        issues.push({
          level: 'error',
          message:
            `Plan must include a ${phase} macro Step for implementation phase ${iteration.id}. ` +
            `Each iteration is a complete V-model cycle: ${REQUIRED_V_MODEL_PHASES.join(' -> ')}.`,
        });
      }
    }
  }

  // 2. acyclic
  if (hasCycle(plan.steps)) {
    issues.push({ level: 'error', message: 'Plan contains a dependency cycle' });
  }

  // 3. outputs unique. Runtime DEBUG repairs edit the source Step's allowed
  //    dependency chain; they are not represented as duplicate-output Steps.
  const outputOwners = new Map<string, string>();
  const stepByIdEarly = new Map(plan.steps.map((s) => [s.id, s]));
  for (const s of plan.steps) {
    for (const out of s.outputs) {
      const prev = outputOwners.get(out);
      if (prev) {
        const prevStep = stepByIdEarly.get(prev);
        const allowIterativeModify =
          prevStep !== undefined &&
          stepIterationOrder(prevStep) < stepIterationOrder(s) &&
          stepTransitivelyDependsOn(s, prev, stepByIdEarly);
        if (!allowIterativeModify) {
          issues.push({
            level: 'error',
            stepId: s.id,
            message: `Output ${out} already produced by ${prev}`,
          });
        }
      } else {
        outputOwners.set(out, s.id);
      }
    }
  }

  // 4. phase order along dependency edges
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));
  for (const s of plan.steps) {
    for (const dep of s.dependsOn) {
      const d = stepById.get(dep);
      if (!d) continue;
      const depOrder = stepIterationOrder(d);
      const currentOrder = stepIterationOrder(s);
      if (depOrder > currentOrder) {
        issues.push({
          level: 'error',
          stepId: s.id,
          message: `Iteration ${stepIterationId(s)} depends on later iteration ${stepIterationId(d)} (${dep}).`,
        });
      }
      if (depOrder === currentOrder && PHASE_ORDER[d.phase] > PHASE_ORDER[s.phase]) {
        issues.push({
          level: 'error',
          stepId: s.id,
          message: `Phase ${s.phase} depends on later phase ${d.phase} (${dep})`,
        });
      }
    }
  }

  // 5. each CODE step needs at least one UNIT_TEST step that depends on it (directly or transitively).
  //    Exception: CODE steps whose outputs are entirely Python package marker files (`__init__.py`)
  //    are not independently testable.
  const codeSteps = plan.steps.filter((s) => s.phase === 'CODE');
  for (const c of codeSteps) {
    const onlyInitFiles =
      c.outputs.length > 0 && c.outputs.every((o) => o === '__init__.py' || o.endsWith('/__init__.py'));
    if (onlyInitFiles) continue;
    const covered = plan.steps.some(
      (t) => t.phase === 'UNIT_TEST' && stepIterationId(t) === stepIterationId(c) && stepTransitivelyDependsOn(t, c.id, stepById),
    );
    if (!covered) {
      const suggestedId = nextStepId(plan.steps);
      const srcOut = c.outputs.find(
        (o) => o.startsWith('src/') && profile.codeExtensions.some((e) => o.endsWith(e)),
      );
      const testFile = profile.testFileFor(srcOut, c.id);
      issues.push({
        level: 'error',
        stepId: c.id,
        message:
          `CODE step ${c.id} has no corresponding UNIT_TEST step. ` +
          `Add a UNIT_TEST step (e.g. id="${suggestedId}", phase="UNIT_TEST", role="Tester", dependsOn=["${c.id}"], ` +
          `inputs=["${testFile}"], outputs=["${phaseDocForIteration('UNIT_TEST', stepIterationId(c)) ?? 'docs/05-unit-test.md'}"]) ` +
          `and keep "${testFile}" in CODE outputs so plan lint rule S004/S005 passes; ` +
          `or have an existing UNIT_TEST step include "${c.id}" in its dependsOn (chain-style coverage is allowed).`,
      });
    }
  }

  // 6. 依赖清单规则（按语言 profile 分流）。
  const ownsManifest = (step: Step): boolean =>
    step.outputs.some((o) => o === profile.manifestFile || o.endsWith(`/${profile.manifestFile}`));
  if (profile.seedManifestFromDeps) {
    // Python：runtime 依据 plan.dependencies 渲染 requirements.txt；HIGH_LEVEL_DESIGN 不得直接产出该文件。
    if (!plan.dependencies || plan.dependencies.length === 0) {
      issues.push({
        level: 'error',
        message: `For ${profile.displayName} plans, plan.dependencies must be non-empty (will seed ${profile.manifestFile} at runtime).`,
      });
    }
    for (const s of plan.steps) {
      if (ownsManifest(s)) {
        issues.push({
          level: 'error',
          stepId: s.id,
          message: `${profile.manifestFile} is renderer-owned; do not list it as a Step output. Use add_dependency tool instead.`,
        });
      }
    }
  } else {
    // Greenfield TypeScript：HIGH_LEVEL_DESIGN 必须创建 package.json。
    // 增量/自举：现有 manifest 是基线契约，除非需求确实修改它，否则不应列为输出。
    const manifestSteps = plan.steps.filter((s) => ownsManifest(s));
    const archManifestSteps = manifestSteps.filter((s) => s.phase === 'HIGH_LEVEL_DESIGN');
    if (
      (plan.intent === 'greenfield' && archManifestSteps.length !== 1) ||
      (plan.intent !== 'greenfield' && archManifestSteps.length > 1)
    ) {
      issues.push({
        level: 'error',
        message:
          plan.intent === 'greenfield'
            ? `For ${profile.displayName} greenfield plans, exactly one HIGH_LEVEL_DESIGN step must output ${profile.manifestFile} (scripts + dependencies + devDependencies).`
            : `For ${profile.displayName} incremental plans, at most one HIGH_LEVEL_DESIGN step may modify the existing ${profile.manifestFile}.`,
      });
    }
    for (const s of manifestSteps) {
      if (s.phase !== 'HIGH_LEVEL_DESIGN') {
        issues.push({
          level: 'error',
          stepId: s.id,
          message: `${profile.manifestFile} must be authored by a HIGH_LEVEL_DESIGN step, not ${s.phase}.`,
        });
      }
    }
  }

  // 7. phase purity — 左侧需求/设计阶段可产出 tests/，但不得提前写 src/；
  //    右侧测试阶段只写报告/交付文档，不得拥有 src/ 或可执行测试。
  const DESIGN_PHASES = new Set(['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN']);
  const TEST_PHASES = new Set(['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST']);
  for (const s of plan.steps) {
    for (const out of s.outputs) {
      const isImplementationPath = out.startsWith('src/') && (profile.codeExtensions.some((e) => out.endsWith(e)) || out.endsWith('/'));
      const isTestAsset = isExecutableTestPath(out, plan.language);
      if (
        (DESIGN_PHASES.has(s.phase) && isImplementationPath) ||
        (TEST_PHASES.has(s.phase) && (isImplementationPath || isTestAsset))
      ) {
        issues.push({
          level: 'error',
          stepId: s.id,
          message:
            TEST_PHASES.has(s.phase)
              ? `${s.phase} is validation-only and must not output implementation/test code: ${out}`
              : `${s.phase} must not output implementation product code: ${out}`,
        });
      }
    }
  }

  // 8. 每个 Step 必须带 systemPrompt（schema 已强制非空，这里再校验长度避免 xcompiler_build 偷懒）
  for (const s of plan.steps) {
    if (s.systemPrompt.trim().length < 20) {
      issues.push({
        level: 'error',
        stepId: s.id,
        message: 'systemPrompt too short — xcompiler_build must specify scope/inputs/outputs/forbidden',
      });
    }
    const subTaskDepth = maxSubTaskDepth(s.subTasks ?? []);
    if (subTaskDepth > 2) {
      issues.push({
        level: 'error',
        stepId: s.id,
        message: `Step subTasks may be nested at most 2 levels; got depth ${subTaskDepth}`,
      });
    }
  }

  // 9. FUNCTIONAL_TEST 阶段：每个 FUNCTIONAL_TEST Step outputs 必须包含完整交付文档包。
  for (const d of plan.steps.filter((s) => s.phase === 'FUNCTIONAL_TEST')) {
    const requiredDocs = deliveryDocsForIteration(plan.projectType ?? 'application', stepIterationId(d));
    for (const doc of requiredDocs) {
      if (!d.outputs.includes(doc)) {
        issues.push({
          level: 'error',
          stepId: d.id,
          message: `FUNCTIONAL_TEST step outputs must include ${doc}`,
        });
      }
    }
  }

  // 10. 每个迭代周期都必须产出各阶段规范验收文档；左侧阶段同步产出对应测试计划。
  for (const iteration of currentImplementationPhases) {
    for (const phase of REQUIRED_V_MODEL_PHASES) {
      const expected = phaseDocForIteration(phase, iteration.id);
      if (!expected) continue;
      const phaseSteps = plan.steps.filter((s) => s.phase === phase && stepIterationId(s) === iteration.id);
      if (phaseSteps.length === 0) continue;
      const covered = phaseSteps.some((s) => s.outputs.includes(expected));
      if (!covered) {
        issues.push({
          level: 'error',
          stepId: phaseSteps[0]!.id,
          message: `${iteration.id} ${phase} 阶段未产出规范验收文档：${expected}`,
        });
      }
    }
    for (const [sourcePhase, testPhase] of Object.entries(V_MODEL_SOURCE_TO_TEST_PHASE) as Array<[Phase, Phase]>) {
      const sourceSteps = plan.steps.filter((s) => s.phase === sourcePhase && stepIterationId(s) === iteration.id);
      if (sourceSteps.length === 0) continue;
      const expectedTestPlan = testPlanDocForIteration(testPhase, iteration.id);
      if (expectedTestPlan && !sourceSteps.some((step) => step.outputs.includes(expectedTestPlan))) {
        issues.push({
          level: 'error',
          stepId: sourceSteps[0]!.id,
          message: `${sourcePhase} must synchronously output paired ${testPhase} plan: ${expectedTestPlan}`,
        });
      }
      const sourceTestAssets = dedup(
        sourceSteps.flatMap((step) =>
          step.outputs.filter((output) => isExecutableTestPath(output, plan.language)),
        ),
      );
      if (sourceTestAssets.length === 0) {
        issues.push({
          level: 'error',
          stepId: sourceSteps[0]!.id,
          message:
            `${sourcePhase} must synchronously author executable ${testPhase} test cases under tests/.`,
        });
      }
      for (const sourceStep of sourceSteps) {
        const pairedTestSteps = plan.steps.filter(
          (candidate) =>
            candidate.phase === testPhase &&
            stepIterationId(candidate) === iteration.id &&
            stepTransitivelyDependsOn(candidate, sourceStep.id, stepById),
        );
        if (pairedTestSteps.length === 0) {
          issues.push({
            level: 'error',
            stepId: sourceStep.id,
            message: `${sourceStep.phase} step ${sourceStep.id} must be covered by a paired ${testPhase} step in ${iteration.id}.`,
          });
          continue;
        }
        for (const testStep of pairedTestSteps) {
          const ownedTestOutputs = testStep.outputs.filter((output) =>
            isExecutableTestPath(output, plan.language),
          );
          if (ownedTestOutputs.length > 0) {
            issues.push({
              level: 'error',
              stepId: testStep.id,
              message:
                `${testPhase} is validation-only; move executable tests to ${sourcePhase}: ${ownedTestOutputs.join(', ')}`,
            });
          }
          const missingInputs = sourceTestAssets.filter((asset) => !testStep.inputs.includes(asset));
          if (missingInputs.length > 0) {
            issues.push({
              level: 'error',
              stepId: testStep.id,
              message:
                `${testPhase} must consume its paired ${sourcePhase} test assets as inputs: ${missingInputs.join(', ')}`,
            });
          }
        }
      }
    }
  }

  // 10c. 任何 Step 都不允许在 outputs 里多名习寫 topic.md（仅由 xcompiler build 写入）
  for (const s of plan.steps) {
    if (s.outputs.includes(DOC_NAMES.topic)) {
      issues.push({
        level: 'error',
        stepId: s.id,
        message: `${DOC_NAMES.topic} 是 xcompiler build 专属产物，不得列为 Step 输出。`,
      });
    }
  }

  // 11. Every planned phase must declare at least one output.
  for (const s of plan.steps) {
    if (s.outputs.length === 0) {
      issues.push({
        level: 'error',
        stepId: s.id,
        message: `${s.phase} step must declare at least one output`,
      });
    }
  }

  // 12. 架构规模门槛：按需求关注面线性扩展，不再把复杂工程的最低要求固定封顶为 3。
  const demand = analyzeArchitectureDemand(plan, plan.language);
  if (demand.nonTrivial) {
    const codeSteps = plan.steps.filter((s) => s.phase === 'CODE');
    const sourceOutputs = dedup(
      codeSteps.flatMap((s) =>
        s.outputs.filter((out) => out.startsWith('src/') && profile.codeExtensions.some((ext) => out.endsWith(ext))),
      ),
    );
    if (sourceOutputs.length < demand.minModules) {
      issues.push({
        level: 'error',
        stepId: codeSteps[0]?.id,
        message:
          `Non-trivial request detected (${demand.reasonLabel}). ` +
          `CODE outputs currently cover only ${sourceOutputs.length} source module(s); expected at least ${demand.minModules}.`,
      });
    }
  }

  // 13. V 模型可追踪性：HIGH_LEVEL_DESIGN 产出模块契约与模块测试，
  //     CODE 实现模块，MODULE_TEST 消费既有模块测试完成验证。
  const architectureModules = plan.architectureModules ?? [];
  if (demand.nonTrivial && architectureModules.length === 0) {
    issues.push({
      level: 'error',
      message:
        'Non-trivial plans require architectureModules for HIGH_LEVEL_DESIGN → CODE → MODULE_TEST traceability.',
    });
  }
  if (architectureModules.length > 0) {
    for (const contractIssue of validateArchitectureContract(
      architectureModules,
      plan.steps,
      plan.language,
      demand,
    )) {
      issues.push({ level: 'error', ...contractIssue });
    }
  }

  if (!plan.complexityAssessment) {
    issues.push({
      level: 'error',
      message: 'Plan must include complexityAssessment from the planning phase.',
    });
  }
  if (implementationPhases.length === 0) {
    issues.push({
      level: 'error',
      message: 'Plan must include implementationPhases with executable V-model iteration goals.',
    });
  } else {
    const current = implementationPhases.filter((phase) => phase.status === 'current');
    const materializedPhaseId = plan.phaseId ?? 'P1';
    if (current.length !== 1 || current[0]?.id !== materializedPhaseId) {
      issues.push({
        level: 'error',
        message: `implementationPhases must have exactly one current phase and it must match plan.phaseId ${materializedPhaseId}.`,
      });
    }
    for (const phase of plannedOrCurrentImplementationPhases) {
      if (!phase.verificationGate || phase.verificationGate.checks.length === 0) {
        issues.push({
          level: 'error',
          message:
            `implementation phase ${phase.id} must define a verificationGate with concrete end-of-iteration checks.`,
        });
      }
    }
  }
  if (plan.complexityAssessment) {
    const requiredPhaseCount = requiredImplementationPhaseCount(plan.complexityAssessment);
    if (plannedOrCurrentImplementationPhases.length > 0 && plannedOrCurrentImplementationPhases.length < requiredPhaseCount) {
      issues.push({
          level: 'error',
          message:
            `complexityAssessment.level=${plan.complexityAssessment.level} requires at least ` +
          `${requiredPhaseCount} planned/current implementation iteration(s).`,
      });
    }
    if (plan.complexityAssessment.level !== 'simple' && !plan.complexityAssessment.splitRecommended) {
      issues.push({
        level: 'error',
        message: 'moderate/complex complexityAssessment requires splitRecommended=true.',
      });
    }
    if (plan.complexityAssessment?.splitRecommended && plannedOrCurrentImplementationPhases.length < 2) {
      issues.push({
        level: 'error',
        message: 'complexityAssessment.splitRecommended requires at least two planned/current implementation iterations.',
      });
    }
    if (
      plan.complexityAssessment.level === 'simple' &&
      !plan.complexityAssessment.splitRecommended &&
      !plan.complexityAssessment.userForcedPhaseSplit &&
      plannedOrCurrentImplementationPhases.length > 1
    ) {
      issues.push({
        level: 'error',
        message: 'simple complexity without splitRecommended must use exactly one executable implementation iteration.',
      });
    }
  }

  return issues;
}

function requiredImplementationPhaseCount(assessment: ComplexityAssessment): number {
  if (assessment.level === 'complex') return 3;
  if (assessment.level === 'moderate' || assessment.splitRecommended || assessment.userForcedPhaseSplit) return 2;
  return 1;
}

export function assertPlanValid(plan: Plan): void {
  const issues = lintPlan(plan);
  const errs = issues.filter((i) => i.level === 'error');
  if (errs.length > 0) throw new PlanLintError(errs);
}

function hasCycle(steps: Step[]): boolean {
  const graph = new Map<string, string[]>();
  for (const s of steps) graph.set(s.id, s.dependsOn);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const s of steps) color.set(s.id, WHITE);

  const dfs = (id: string): boolean => {
    color.set(id, GRAY);
    for (const next of graph.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  };

  for (const s of steps) if (color.get(s.id) === WHITE && dfs(s.id)) return true;
  return false;
}

/** 给 lint S004/S005 错误提示用：算出下一个未被占用的 S### id。 */
function nextStepId(steps: Step[]): string {
  const max = steps.reduce((m, s) => {
    const mm = String(s.id).match(/^S(\d{3,})$/);
    return mm ? Math.max(m, parseInt(mm[1]!, 10)) : m;
  }, 0);
  return 'S' + String(max + 1).padStart(3, '0');
}

function dedup<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function maxSubTaskDepth(tasks: NonNullable<Step['subTasks']>): number {
  if (tasks.length === 0) return 0;
  return Math.max(
    ...tasks.map((task) => {
      const children = task.subTasks ?? [];
      return 1 + maxSubTaskDepth(children);
    }),
  );
}

export function topoSort(steps: Step[]): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map<string, number>();
  for (const s of steps) indeg.set(s.id, s.dependsOn.length);
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  // tie-break by phase order then id for determinism
  queue.sort((a, b) => cmp(byId.get(a)!, byId.get(b)!));

  const out: Step[] = [];
  const remaining = new Map(indeg);
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    for (const dep of s.dependsOn) {
      const arr = dependents.get(dep) ?? [];
      arr.push(s.id);
      dependents.set(dep, arr);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const s = byId.get(id)!;
    out.push(s);
    for (const n of dependents.get(id) ?? []) {
      const r = (remaining.get(n) ?? 0) - 1;
      remaining.set(n, r);
      if (r === 0) {
        queue.push(n);
        queue.sort((a, b) => cmp(byId.get(a)!, byId.get(b)!));
      }
    }
  }

  if (out.length !== steps.length) throw new Error('Cycle detected during topoSort');
  return out;

  function cmp(a: Step, b: Step): number {
    const ia = iterationSortValue(a.iterationId ?? 'P1');
    const ib = iterationSortValue(b.iterationId ?? 'P1');
    if (ia !== ib) return ia - ib;
    const pa = PHASE_ORDER[a.phase];
    const pb = PHASE_ORDER[b.phase];
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  }
}

function iterationSortValue(iterationId: string): number {
  const match = iterationId.match(/^P(\d{1,3})$/u);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
