import type { ExecutorRunMetrics } from '../../agents/executor.js';
import type {
  QualityGateEvaluation,
  StageQualityAssessment,
} from '../quality_gate.js';
import type {
  BugKind,
  ChangeRequestTicket,
  EnhanceTicket,
} from '../ticket.js';

export interface DebugAttemptContext {
  asDebugger: true;
  failureLog: string;
  reason: string;
  priorAttemptsPrompt?: string;
  contextPaths?: string[];
  extraAllowedWrites?: string[];
  contextMode?: 'audit-repair' | 'iteration-gate' | 'test-rollback';
  testScopeArgs?: string[];
  bugTicketId?: string;
  completedBeforeDebug?: boolean;
  debugWikiEntryIds?: string[];
  bugResolutionPlan?: string;
}

export interface AttemptOptions {
  archiveOutputs?: boolean;
  changeRequest?: ChangeRequestTicket;
  enhancement?: EnhanceTicket;
}

export interface AttemptOutcome {
  ok: boolean;
  failureLog: string;
  reason?: string;
  workspaceReverted?: boolean;
  metrics?: ExecutorRunMetrics;
  rollbackToPairedSource?: boolean;
  rollbackTestStepId?: string;
  bugKind?: BugKind;
  evidence?: Record<string, unknown>;
  bugResolutionPlan?: string;
  qualityGap?: {
    assessment: StageQualityAssessment;
    evaluation: QualityGateEvaluation;
    remediationTarget?: 'same-step' | 'paired-source';
  };
}
