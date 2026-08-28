import { z } from 'zod';

/** What a delivery gate protects. */
export const DELIVERY_GATE_KINDS = [
  'baseline-test',
  'verification-acceptance',
  'phase-delivery',
] as const;

/** The three validation classes a Step delivery gate can compose. */
export const DELIVERY_GATE_VALIDATION_TYPES = [
  'deliverable-validation',
  'baseline-test',
  'supplemental-functional-test',
] as const;

export const BASELINE_EXECUTION_POLICIES = [
  'defer-until-code',
  'required',
  'freeze-then-required',
  'phase-aggregate',
] as const;

export const TEST_ASSET_POLICIES = [
  'generate-baseline',
  'inspect-supplement-freeze-execute',
  'phase-aggregate',
] as const;

export const EXTERNAL_DATA_POLICIES = [
  'controlled',
  'record-replay',
  'live',
] as const;

export const DeliveryGateScenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  operation: z.string().min(1),
  environment: z.enum(['controlled', 'record-replay', 'live']),
  expected: z.string().min(1),
  execution: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }).strict().optional(),
}).strict();

export type DeliveryGateScenario = z.infer<typeof DeliveryGateScenarioSchema>;

export const DeliveryGateSceneSchema = z.object({
  scenario: DeliveryGateScenarioSchema,
  capturedAt: z.string().datetime({ offset: true }),
  command: z.string().min(1),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
}).strict();

export type DeliveryGateScene = z.infer<typeof DeliveryGateSceneSchema>;

/**
 * Whether what a live scenario produced matches what the scenario said to expect.
 *
 * The process check answers a narrower question than the gate asks: a run that exits zero has not
 * shown that it did the right thing. A delivered project passed every Step gate and its own 115
 * tests while every one of its 100 output records carried the same text twice — the scenario's
 * `expected` described exactly that content, and nothing read it.
 *
 * Judged, not matched: `expected` is prose written for the project at hand, and a pattern language
 * general enough for every kind of project would express none of them well. The judgement is
 * supplied by Runtime rather than performed here, so this module keeps knowing only the contract.
 */
export interface ScenarioOutcomeVerdict {
  ok: boolean;
  /** Why the produced result does or does not meet `expected`, in the judge's words. */
  reason: string;
  /** What the judgement was made from: output excerpts, artifact paths, command output. */
  evidence: string[];
}

export type ScenarioOutcomeJudge = (input: {
  scenario: DeliveryGateScenario;
  scene: DeliveryGateScene;
}) => Promise<ScenarioOutcomeVerdict>;

const DeliveryGateInputSchema = z.object({
  kind: z.enum(DELIVERY_GATE_KINDS),
  summary: z.string().min(1),
  checks: z.array(z.string().min(1)).min(1),
  validationTypes: z.array(z.enum(DELIVERY_GATE_VALIDATION_TYPES)).min(1).optional(),
  baselineExecutionPolicy: z.enum(BASELINE_EXECUTION_POLICIES).optional(),
  testAssetPolicy: z.enum(TEST_ASSET_POLICIES),
  externalDataPolicy: z.enum(EXTERNAL_DATA_POLICIES),
  /** Executable user journeys owned by this gate, rather than by an individual V-model Step. */
  scenarios: z.array(DeliveryGateScenarioSchema).default([]),
  /** A right-side supplement is immutable once the executable gate starts. */
  freezeBeforeExecution: z.boolean().default(false),
  /** Every independent finding becomes its own Ticket; findings are never flattened. */
  routeEachFinding: z.literal(true).default(true),
}).strict();

export const DeliveryGateSchema = DeliveryGateInputSchema.transform((gate) => ({
  ...gate,
  validationTypes: gate.validationTypes ?? defaultValidationTypes(gate.kind),
  baselineExecutionPolicy:
    gate.baselineExecutionPolicy ?? defaultBaselineExecutionPolicy(gate.kind),
}));

export type DeliveryGate = z.infer<typeof DeliveryGateSchema>;

export const DELIVERY_GATE_FINDING_CATEGORIES = [
  'test-defect',
  'product-defect',
  'test-incomplete',
  'quality-shortfall',
  'deliverable-defect',
  'dependency',
] as const;

export const DELIVERY_GATE_FINDING_TARGETS = [
  'current-step',
  'paired-source',
  'requirement-analysis',
  'high-level-design',
  'detailed-design',
  'code',
] as const;

/**
 * One independently actionable problem discovered by a gate.
 *
 * This is evidence awaiting PM intake, not a Ticket. Inside a Phase the discovering actor supplies
 * the context; at the Phase boundary Runtime supplies the captured scene. PM alone materializes and
 * routes a Phase-local Ticket without inventing or rewriting that context.
 */
export const DeliveryGateFindingSchema = z.object({
  category: z.enum(DELIVERY_GATE_FINDING_CATEGORIES),
  /** Stable machine code: reuse it for the same problem and change it for an independent problem. */
  code: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  target: z.enum(DELIVERY_GATE_FINDING_TARGETS),
  /** Workspace artifacts the correction is allowed to modify. */
  affectedArtifacts: z.array(z.string().min(1)).default([]),
  dependencyPackages: z.array(z.string().min(1)).default([]),
  /** Immutable execution scene supplied to PM; this is evidence, not a Ticket. */
  scene: DeliveryGateSceneSchema.optional(),
}).strict().superRefine((finding, ctx) => {
  if (finding.category === 'dependency' && finding.dependencyPackages.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dependencyPackages'],
      message: 'A dependency finding must name at least one package',
    });
  }
});

export type DeliveryGateFinding = z.infer<typeof DeliveryGateFindingSchema>;

export type DevelopmentDeliveryGateStage =
  | 'REQUIREMENT_ANALYSIS'
  | 'HIGH_LEVEL_DESIGN'
  | 'DETAILED_DESIGN'
  | 'CODE';

const DEVELOPMENT_DELIVERY_CHECKS: Record<DevelopmentDeliveryGateStage, string[]> = {
  REQUIREMENT_ANALYSIS: [
    'Validate the requirement deliverables for topic traceability, observable acceptance criteria, scope, constraints, and unresolved decisions.',
    'Validate the functional baseline test plan and cases against the accepted requirements without requiring product code to exist.',
  ],
  HIGH_LEVEL_DESIGN: [
    'Validate the architecture deliverables for system placement, module boundaries, external interfaces, APIs, dependencies, and ownership.',
    'Validate architecture feasibility and trace every planned module and contract to its module baseline tests.',
  ],
  DETAILED_DESIGN: [
    'Validate the detailed design for upstream architecture alignment, internal data/control flow, error handling, and implementation contracts.',
    'Validate the implementation solution and trace cross-module behavior to its integration baseline tests.',
  ],
  CODE: [
    'Validate the code deliverables against the detailed design, declared source ownership, build/static checks, and public contracts.',
    'Validate that the unit baseline tests exercise the implemented product behavior rather than duplicate it.',
  ],
};

export function baselineDeliveryGate(
  name: string,
  stage: DevelopmentDeliveryGateStage = 'CODE',
): DeliveryGate {
  return {
    kind: 'baseline-test',
    summary: `${name} validates its stage deliverables and paired baseline tests.`,
    checks: [
      ...DEVELOPMENT_DELIVERY_CHECKS[stage],
      'Validate that every declared deliverable and paired baseline test asset exists, is complete, and is reviewable.',
      stage === 'CODE'
        ? 'Execute the paired unit baseline tests and require them to pass before delivery.'
        : 'Execute the paired baseline tests when product code exists; defer execution only on the initial pre-CODE pass and record that deferral explicitly.',
    ],
    validationTypes: ['deliverable-validation', 'baseline-test'],
    baselineExecutionPolicy: stage === 'CODE' ? 'required' : 'defer-until-code',
    testAssetPolicy: 'generate-baseline',
    externalDataPolicy: 'controlled',
    scenarios: [],
    freezeBeforeExecution: false,
    routeEachFinding: true,
  };
}

export function verificationDeliveryGate(name: string): DeliveryGate {
  return {
    kind: 'verification-acceptance',
    summary: `${name} independently accepts the paired behavior against its quality thresholds.`,
    checks: [
      'Inspect the paired baseline tests for completeness and contract alignment.',
      'Add only risk-driven supplemental tests under this verification Step ownership.',
      'Freeze the resulting baseline plus supplemental suite before execution.',
      'Execute the frozen suite and evaluate the Step KPI and tolerance thresholds.',
    ],
    validationTypes: ['baseline-test', 'supplemental-functional-test'],
    baselineExecutionPolicy: 'freeze-then-required',
    testAssetPolicy: 'inspect-supplement-freeze-execute',
    externalDataPolicy: 'record-replay',
    scenarios: [],
    freezeBeforeExecution: true,
    routeEachFinding: true,
  };
}

export function phaseDeliveryGate(name: string, plannedChecks: readonly string[] = []): DeliveryGate {
  return {
    kind: 'phase-delivery',
    summary: `${name} passes complete deliverable and real-scenario acceptance.`,
    checks: [
      'Every V-model Step is closed and every corrective Ticket is closed or cancelled as a recorded duplicate.',
      'All declared deliverables exist and satisfy their acceptance contracts.',
      'The integrated project passes build, test, and entrypoint checks.',
      'The real user scenario passes against live external dependencies.',
      ...plannedChecks,
    ],
    validationTypes: [
      'deliverable-validation',
      'baseline-test',
      'supplemental-functional-test',
    ],
    baselineExecutionPolicy: 'phase-aggregate',
    testAssetPolicy: 'phase-aggregate',
    externalDataPolicy: 'live',
    scenarios: [{
      name: 'real-user-entrypoint',
      description: 'Exercise the delivered product as a user would, through its public entrypoint.',
      operation: 'Launch the documented primary user flow with live external dependencies.',
      environment: 'live',
      expected: 'The documented user flow completes successfully and returns usable output.',
    }],
    freezeBeforeExecution: true,
    routeEachFinding: true,
  };
}

function defaultValidationTypes(kind: (typeof DELIVERY_GATE_KINDS)[number]) {
  if (kind === 'baseline-test') {
    return ['deliverable-validation', 'baseline-test'] as const;
  }
  if (kind === 'verification-acceptance') {
    return ['baseline-test', 'supplemental-functional-test'] as const;
  }
  return [
    'deliverable-validation',
    'baseline-test',
    'supplemental-functional-test',
  ] as const;
}

function defaultBaselineExecutionPolicy(kind: (typeof DELIVERY_GATE_KINDS)[number]) {
  if (kind === 'baseline-test') return 'defer-until-code' as const;
  if (kind === 'verification-acceptance') return 'freeze-then-required' as const;
  return 'phase-aggregate' as const;
}
