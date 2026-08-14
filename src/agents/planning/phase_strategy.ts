import {
  ComplexityAssessmentSchema,
  ImplementationPhaseSchema,
  REQUIRED_V_MODEL_PHASES,
  type ComplexityAssessment,
  type ImplementationPhase,
  type Language,
  type PlanIntent,
  type ProjectType,
  type Step,
} from '../../core/plan.js';
import { analyzeArchitectureDemand } from '../../core/architecture.js';
import { phaseDeliveryGate } from '../../domain/quality/delivery_gate.js';

export function parseComplexityAssessment(value: unknown): ComplexityAssessment | undefined {
  const result = ComplexityAssessmentSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function parseImplementationPhases(value: unknown): ImplementationPhase[] | undefined {
  const result = ImplementationPhaseSchema.array().safeParse(value);
  return result.success ? result.data : undefined;
}

export function validateImplementationPhaseDraft(
  phases: ImplementationPhase[],
  assessment: ComplexityAssessment,
  context: { language: Language; expectedCurrentPhaseId?: string },
): string | undefined {
  const expectedCurrentPhaseId = context.expectedCurrentPhaseId ?? 'P1';
  const requiredCount = requiredImplementationPhaseCount(assessment);
  const executable = phases.filter((phase) => phase.status !== 'deferred');
  if (executable.length < requiredCount) {
    return `complexityAssessment.level=${assessment.level} requires at least ${requiredCount} executable implementation iteration(s)`;
  }
  if (
    assessment.level === 'simple' &&
    !assessment.splitRecommended &&
    !assessment.userForcedPhaseSplit &&
    executable.length !== 1
  ) {
    return 'simple complexity without splitRecommended must use exactly one executable implementation iteration';
  }
  const current = phases.filter((phase) => phase.status === 'current');
  if (current.length !== 1 || current[0]?.id !== expectedCurrentPhaseId) {
    return `exactly one current phase is required and it must be ${expectedCurrentPhaseId}`;
  }
  if (phases[0]?.id !== 'P1') return 'P1 must be the first implementation phase';
  if (assessment.userForcedPhaseSplit && !assessment.splitRecommended) {
    return 'userForcedPhaseSplit=true requires splitRecommended=true';
  }
  if (assessment.level !== 'simple' && !assessment.splitRecommended) {
    return 'moderate/complex complexity requires splitRecommended=true';
  }
  if (assessment.splitRecommended && executable.filter((phase) => phase.id !== 'P1').length === 0) {
    return 'splitRecommended=true requires at least one planned executable iteration after P1';
  }
  for (const phase of executable) {
    if (!phase.deliveryGate) {
      return `${phase.id} must define a Phase deliveryGate with executable real-user scenarios`;
    }
    const liveScenarios = phase.deliveryGate.scenarios.filter((scenario) => scenario.environment === 'live');
    if (liveScenarios.length === 0) {
      return `${phase.id} deliveryGate must declare at least one live real-user scenario`;
    }
    const incomplete = liveScenarios.find((scenario) => !scenario.execution);
    if (incomplete) {
      return `${phase.id} deliveryGate scenario ${incomplete.name} must define concrete execution.command and execution.args`;
    }
    for (const scenario of liveScenarios) {
      const executionIssue = validateDeliveryExecution(
        scenario.execution!,
        context.language,
      );
      if (executionIssue) {
        return `${phase.id} deliveryGate scenario ${scenario.name} ${executionIssue}`;
      }
    }
  }
  return undefined;
}

export function validateCurrentPhaseDeliveryEntrypoints(
  phase: ImplementationPhase,
  steps: Step[],
  language: Language,
): string | undefined {
  const codeOutputs = new Set(
    steps
      .filter((step) => step.phase === 'CODE')
      .flatMap((step) => step.outputs)
      .map(normalizePlanPath),
  );
  const extensions = language === 'typescript' ? /\.tsx?$/iu : /\.py$/iu;
  for (const scenario of phase.deliveryGate?.scenarios ?? []) {
    if (scenario.environment !== 'live' || !scenario.execution) continue;
    const entrypaths = scenario.execution.args
      .map(normalizePlanPath)
      .filter((arg) => extensions.test(arg));
    const missing = entrypaths.filter((entrypath) => !codeOutputs.has(entrypath));
    if (missing.length > 0) {
      return `${phase.id} deliveryGate scenario ${scenario.name} references entry file(s) not delivered by ` +
        `the current phase CODE Step: ${missing.join(', ')}`;
    }
  }
  return undefined;
}

function validateDeliveryExecution(
  execution: { command: string; args: string[] },
  language: Language,
): string | undefined {
  const command = execution.command.trim();
  if (/\s/u.test(command)) {
    return 'execution.command must contain one executable only; move every argument into execution.args';
  }
  if (language !== 'typescript') return undefined;

  const toolchain = [command, ...execution.args].map((token) => token.toLowerCase());
  const forbidden = toolchain.find((token) => /^(?:ts-node|nodemon|jest|ts-jest)(?:$|\/)/u.test(token));
  if (forbidden) {
    return `uses forbidden TypeScript runner ${forbidden}; use Node 24, npx tsx, npm, or Vitest as appropriate`;
  }
  return undefined;
}

function normalizePlanPath(value: string): string {
  return value.trim().replace(/^\.\//u, '').replace(/\\/gu, '/');
}

export function validateIterationVModelDraft(
  steps: Step[],
  phases: ImplementationPhase[],
): string | undefined {
  const current = phases.filter((phase) => phase.status === 'current');
  const materializedIds = new Set(current.map((phase) => phase.id));
  for (const step of steps) {
    const iterationId = step.iterationId ?? 'P1';
    if (!materializedIds.has(iterationId)) {
      return `${step.id} references non-current iteration ${iterationId}; planned phases are PhasePlan goals and must not contain executable Steps yet`;
    }
  }
  for (const iteration of current) {
    const phaseSet = new Set(
      steps.filter((step) => (step.iterationId ?? 'P1') === iteration.id).map((step) => step.phase),
    );
    for (const required of REQUIRED_V_MODEL_PHASES) {
      if (!phaseSet.has(required)) return `${iteration.id} is missing ${required}; every iteration must be a complete V-model cycle`;
    }
  }
  return undefined;
}

export function parseProjectType(value: unknown): ProjectType | undefined {
  return value === 'application' || value === 'library' || value === 'mixed' ? value : undefined;
}

export function projectShapeSignals(text: string): {
  libraryLike: boolean;
  appLike: boolean;
  genericApi: boolean;
} {
  const lower = text.toLowerCase();
  const libraryLike =
    /\b(api[- ]?library|library|sdk|package|npm package|pypi package|client library|api client|reusable module|public api)\b/u.test(lower) ||
    /api\s*(库|客户端)|公共\s*api|可复用接口|公共库|库项目|软件包|客户端库|开发包/u.test(text);
  const appLike =
    /\b(cli|command|command line|web app|server|service|dashboard|software|script|tool|terminal|application|app|api[- ]?server|api[- ]?service|rest api|http api|web api|api endpoint)\b/u.test(lower) ||
    /命令行|服务|应用|脚本|工具|控制台|后台|仪表盘|软件/u.test(text);
  const explicitApiSurface =
    /\b(api[- ]?server|api[- ]?service|rest api|http api|web api|api endpoint|api client|api[- ]?library)\b/u.test(lower) ||
    /api\s*(服务|网关|端点|客户端|库)/u.test(text);
  const genericApi = (/\bapi\b/u.test(lower) || /接口/u.test(text)) && !explicitApiSurface;
  return { libraryLike, appLike, genericApi };
}

export function isProjectShapeAmbiguous(text: string): boolean {
  const signals = projectShapeSignals(text);
  return signals.genericApi || (!signals.libraryLike && !signals.appLike);
}

export function inferProjectType(text: string): ProjectType {
  const { libraryLike, appLike } = projectShapeSignals(text);
  if (libraryLike && appLike) return 'mixed';
  if (libraryLike) return 'library';
  return 'application';
}

export function inferComplexityAssessment(input: {
  requirementDigest: string;
  rawRequirement?: string;
  globalPrompt?: string;
  userAddenda?: string;
  baselineSummary?: string;
  intent: PlanIntent;
  language: Language;
}): ComplexityAssessment {
  const text = [
    input.requirementDigest,
    input.rawRequirement ?? '',
    input.userAddenda ?? '',
    input.baselineSummary ?? '',
  ].join('\n');
  const demand = analyzeArchitectureDemand(input, input.language);
  const forced = hasForcedPhaseSplit(text);
  const level: ComplexityAssessment['level'] = demand.nonTrivial || forced
    ? 'complex'
    : demand.surfaces.length > 0 || demand.baselineModules > 0
      ? 'moderate'
      : 'simple';
  return {
    level,
    rationale: demand.reasonLabel,
    splitRecommended: forced || level !== 'simple',
    userForcedPhaseSplit: forced,
  };
}

export function normalizeImplementationPhases(
  phases: ImplementationPhase[] | undefined,
  assessment: ComplexityAssessment,
  requirementDigest: string,
): ImplementationPhase[] {
  const requiredCount = requiredImplementationPhaseCount(assessment);
  const hasCurrent = (phases ?? []).some((phase) => phase.status === 'current');
  const sanitized: ImplementationPhase[] = (phases ?? [])
    .filter((phase) => phase.id && phase.title && phase.objective)
    .map((phase, index) => ({
      ...phase,
      id: phase.id || `P${index + 1}`,
      status: hasCurrent
        ? phase.status
        : index === 0
          ? 'current' as const
          : phase.status === 'deferred'
            ? 'deferred' as const
            : 'planned' as const,
      dependsOn: index === 0 ? [] : phase.dependsOn.length > 0 ? phase.dependsOn : [`P${index}`],
      verificationGate: phase.verificationGate ?? defaultVerificationGate(phase.id || `P${index + 1}`),
      deliveryGate: phase.deliveryGate ?? phaseDeliveryGate(
        phase.id || `P${index + 1}`,
        phase.verificationGate?.checks ?? [],
      ),
    }));
  if (sanitized.length > 0) {
    while (sanitized.filter((phase) => phase.status !== 'deferred').length < requiredCount) {
      sanitized.push(plannedIterationPhase(requirementDigest, sanitized.length + 1));
    }
    return sanitized;
  }
  const initial: ImplementationPhase[] = [{
    id: 'P1',
    title: 'Core functionality',
    objective: `Deliver the smallest complete core slice for: ${requirementDigest}`,
    status: 'current',
    scope: ['Core domain behaviour', 'Runnable entrypoint', 'Primary tests', 'Functional validation documentation'],
    deliverables: ['Complete V-model iteration for the highest-priority core slice.'],
    dependsOn: [],
    verificationGate: defaultVerificationGate('P1'),
    deliveryGate: phaseDeliveryGate('P1', defaultVerificationGate('P1').checks),
  }];
  while (initial.length < requiredCount) {
    initial.push(plannedIterationPhase(requirementDigest, initial.length + 1));
  }
  return initial;
}

export function requiredImplementationPhaseCount(assessment: ComplexityAssessment): number {
  if (assessment.level === 'complex') return 3;
  if (assessment.level === 'moderate' || assessment.splitRecommended || assessment.userForcedPhaseSplit) return 2;
  return 1;
}

export function defaultVerificationGate(iterationId: string) {
  return {
    summary: `${iterationId} iteration gate: documentation, automated tests, runnable entrypoint, and language quality checks must pass.`,
    checks: [
      'Declared functional validation documentation exists for this iteration.',
      'Automated test suite passes with no detected network API failure.',
      'Runnable entrypoint or public API probe succeeds.',
      'Language-specific build/lint checks pass when configured.',
    ],
    failurePolicy:
      'If any check fails, feed the full gate failure log into Debugger and repair the same iteration through the paired V-model rollback phase before rerunning subsequent phases.',
  };
}

export function normalizeStepIterations(steps: Step[], _phases: ImplementationPhase[]): Step[] {
  return steps.map((step) => ({ ...step, iterationId: step.iterationId ?? 'P1' }));
}

export function hasForcedPhaseSplit(text: string): boolean {
  return /\b(?:phase\s*\d+|multi[- ]phase|phase split|staged rollout)\b|分阶段|多阶段|分期|阶段拆分|一期|二期|第一阶段|第二阶段|后续阶段/iu.test(text);
}

function plannedIterationPhase(requirementDigest: string, index: number): ImplementationPhase {
  return {
    id: `P${index}`,
    title: `Iteration ${index} enhancements`,
    objective: `Deliver the next highest-priority iteration after P${index - 1}: ${requirementDigest}`,
    status: 'planned',
    scope: ['Next prioritized workflows', 'Extended integrations', 'Quality hardening', 'Functional validation update'],
    deliverables: ['Complete V-model iteration with all eight canonical Steps.'],
    dependsOn: [`P${Math.max(1, index - 1)}`],
    verificationGate: defaultVerificationGate(`P${index}`),
    deliveryGate: phaseDeliveryGate(
      `P${index}`,
      defaultVerificationGate(`P${index}`).checks,
    ),
  };
}
