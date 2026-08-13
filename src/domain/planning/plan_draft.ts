import type { StepType } from '../steps/step.js';
import type { ExecutionAgent } from '../workflow/role.js';
import type { DeliveryGate } from '../quality/delivery_gate.js';

/**
 * The planning DTO the Domain plan compiler accepts as input.
 *
 * Planning produces a draft; only the Domain compiler turns it into canonical objects. The contract
 * therefore belongs to the Domain, not to the outer module that happens to persist the plan file:
 * Domain must not import Application, Runtime, Infrastructure, or the plan-file layer.
 *
 * These are structural types, deliberately narrower than the persisted plan schema. They name only
 * what compilation reads, so the plan file can carry presentation or tooling fields without
 * widening the Domain's input surface. The persisted `Plan` type structurally satisfies them, which
 * TypeScript verifies at every call site.
 */

/** Canonical complexity vocabulary; compilation derives Phase count and attempt budgets from it. */
export const PLAN_DRAFT_COMPLEXITY_LEVELS = ['simple', 'moderate', 'complex'] as const;
export type PlanDraftComplexityLevel = (typeof PLAN_DRAFT_COMPLEXITY_LEVELS)[number];

export interface PlanDraftComplexityAssessment {
  level: PlanDraftComplexityLevel;
  rationale: string;
  splitRecommended: boolean;
  userForcedPhaseSplit: boolean;
}

export interface PlanDraftVerificationGate {
  summary: string;
  checks: readonly string[];
  failurePolicy: string;
}

export interface PlanDraftQualityTolerance {
  metricShortfall: number;
  maxFailedTests: number;
  maxSkippedTests: number;
  maxWarnings: number;
}

export interface PlanDraftQualityGate {
  completionMin?: number;
  upstreamAlignmentMin?: number;
  metrics: Readonly<Record<string, number>>;
  tolerance: PlanDraftQualityTolerance;
}

export interface PlanDraftPhase {
  id: string;
  title: string;
  objective: string;
  status: string;
  scope: readonly string[];
  deliverables: readonly string[];
  dependsOn: readonly string[];
  verificationGate?: PlanDraftVerificationGate;
  deliveryGate?: DeliveryGate;
}

export interface PlanDraftTask {
  id: string;
  title: string;
  description: string;
  acceptance?: string;
  outputs?: readonly string[];
  subTasks?: readonly PlanDraftTask[];
}

export interface PlanDraftStep {
  id: string;
  iterationId: string;
  /** Draft vocabulary for the canonical {@link StepType}; normalized during compilation. */
  phase: StepType;
  title: string;
  description: string;
  systemPrompt: string;
  role: ExecutionAgent;
  tools: readonly string[];
  inputs: readonly string[];
  outputs: readonly string[];
  subTasks?: readonly PlanDraftTask[];
  dependsOn: readonly string[];
  acceptance: string;
  qualityGate?: PlanDraftQualityGate;
  deliveryGate?: DeliveryGate;
  maxAttempts: number;
}

export interface PlanDraft {
  language: string;
  intent: string;
  phaseId: string;
  projectType: string;
  requirementDigest: string;
  complexityAssessment: PlanDraftComplexityAssessment;
  implementationPhases: readonly PlanDraftPhase[];
  steps: readonly PlanDraftStep[];
}
