import type { AuditLogger } from '../../audit/audit.js';
import type { GitService } from '../../workspace/git.js';
import {
  affectedStepContract,
  TicketStore,
  type BugTicket,
  type ChangeRequestTicket,
  type EnhanceTicket,
} from '../ticket.js';
import {
  V_MODEL_TEST_PHASES,
  type Plan,
  type Step,
} from '../plan.js';
import { pairedTestAssetPaths } from '../test_assets.js';
import { normalizeGitPath } from './v_model_policy.js';
import { BugLifecycle } from './bug_lifecycle.js';
import { ChangeRequestLifecycle } from './change_request_lifecycle.js';
import { EnhancementLifecycle } from './enhancement_lifecycle.js';

export interface QualityChangeRequestInput {
  plan: Plan;
  enhancement: EnhanceTicket;
  sourceStep: Step;
  verificationStep: Step;
  affectedSteps: Step[];
  baselineCommit: string;
  activeChangeRequest?: ChangeRequestTicket;
}

export interface DesignChangeRequestInput {
  plan: Plan;
  bug: BugTicket;
  sourceStep: Step;
  failedTest: Step;
  affectedSteps: Step[];
  activeChangeRequest?: ChangeRequestTicket;
}

export class ChangeRequestOpening {
  constructor(
    private readonly store: TicketStore,
    private readonly git: GitService,
    private readonly audit: AuditLogger,
    private readonly enhancements: EnhancementLifecycle,
    private readonly bugs: BugLifecycle,
    private readonly changes: ChangeRequestLifecycle,
  ) {}

  async headCommit(): Promise<string> {
    return (await this.git.raw().revparse(['HEAD'])).trim();
  }

  async establishQuality(input: QualityChangeRequestInput): Promise<ChangeRequestTicket> {
    const current = input.activeChangeRequest;
    const currentCoversSource = current && (
      current.designSource.stepId === input.sourceStep.id ||
      current.affectedSteps.some((step) => step.stepId === input.sourceStep.id)
    );
    if (current && currentCoversSource) {
      await this.changes.requestRework(
        current,
        input.enhancement.id,
        `${input.enhancement.id} adds a quality delta in ${input.sourceStep.id}`,
      );
      await this.enhancements.linkToChange(input.enhancement, current.id);
      if (!current.relatedTicketIds.includes(input.enhancement.id)) {
        await this.store.link(current, input.enhancement.id, 'enhancement-linked');
      }
      return current;
    }

    const repairCommit = await this.headCommit();
    const changedArtifacts = dedup(input.sourceStep.outputs);
    const affectedSteps = input.affectedSteps.map(affectedStepContract);
    const affectedArtifacts = dedup([
      ...changedArtifacts,
      ...input.affectedSteps.flatMap((step) => step.outputs),
    ]);
    const relatedWorkTicketIds = input.affectedSteps
      .map((step) => this.store.workForStep(step.id)?.id)
      .filter((id): id is string => !!id);
    const objective =
      `Propagate the accepted ${input.sourceStep.phase} quality delta from ${input.enhancement.id} ` +
      'through affected downstream stages without regenerating accepted baseline work.';
    const request = await this.store.createChangeRequest({
      iterationId: input.sourceStep.iterationId ?? 'P1',
      priority: 'high',
      parentTicketId: current?.id,
      rootTicketId: input.enhancement.rootTicketId,
      relatedTicketIds: dedup([input.enhancement.id, ...relatedWorkTicketIds]),
      blockedByTicketIds: [],
      source: {
        kind: 'runtime',
        externalId: `${input.enhancement.id}:${input.sourceStep.id}`,
        stepId: input.sourceStep.id,
        phase: input.sourceStep.phase,
        role: input.sourceStep.role,
      },
      title: `${input.sourceStep.phase} quality change propagation`,
      description: objective,
      objective,
      acceptance: [
        ...input.enhancement.acceptance,
        `All affected stages pass through ${input.verificationStep.id} ${input.verificationStep.phase}.`,
      ],
      artifacts: affectedArtifacts,
      sourceEnhanceTicketId: input.enhancement.id,
      triggerTicketId: input.enhancement.id,
      scope: {
        in: dedup([
          `${input.sourceStep.id} accepted quality delta`,
          ...affectedSteps.map((step) => `${step.stepId} ${step.phase}`),
          ...affectedArtifacts,
        ]),
        out: ['Unrelated requirements, modules, files, and accepted behavior'],
      },
      trigger: {
        failedStepId: input.verificationStep.id,
        failedPhase: input.verificationStep.phase,
        failedAcceptance: input.verificationStep.acceptance,
        reason: input.enhancement.finding,
        failureSummary: input.enhancement.qualityFailures?.join('; ') ??
          input.enhancement.finding,
      },
      designSource: {
        stepId: input.sourceStep.id,
        phase: input.sourceStep.phase as 'HIGH_LEVEL_DESIGN' | 'DETAILED_DESIGN',
        baselineCommit: input.baselineCommit,
        repairCommit,
        changedArtifacts,
      },
      contractChange: {
        summary: input.enhancement.finding,
        before: input.enhancement.qualityFailures ?? [input.enhancement.finding],
        after: input.enhancement.acceptance,
        interfaces: input.sourceStep.outputs.map((output) => `Contract artifact: ${output}`),
        dependencies: input.plan.dependencies ?? [],
        constraints: [
          'Apply only the accepted quality delta.',
          'Preserve unrelated accepted behavior and artifacts.',
        ],
      },
      implementationPlan: [
        objective,
        `Apply in order: ${affectedSteps.map((step) => `${step.stepId}/${step.phase}`).join(' -> ')}.`,
      ].join('\n'),
      affectedSteps,
      affectedArtifacts,
      verification: {
        targetStepId: input.verificationStep.id,
        targetPhase: input.verificationStep.phase,
        testArgs: isVModelTestPhase(input.verificationStep.phase)
          ? testGateArgs(input.plan, input.verificationStep)
          : [],
        checks: [
          input.verificationStep.acceptance,
          ...input.enhancement.acceptance,
        ],
        failurePolicy:
          'Open a linked Ticket, revise this change request, and resume from the owning V-model stage.',
        rollbackTargetStepId: input.sourceStep.id,
        rollbackTargetPhase: input.sourceStep.phase,
      },
      execution: { completedStepIds: [] },
    });
    await this.enhancements.linkToChange(input.enhancement, request.id);
    await this.changes.recordApplication(request, {
      stepId: input.sourceStep.id,
      phase: input.sourceStep.phase,
      kind: 'design-change',
      commit: repairCommit,
      changedFiles: changedArtifacts,
      summary: objective,
    });
    const providers = dedup(
      input.enhancement.modelAttributions
        .filter((attribution) => attribution.outcome === 'repair-verified')
        .map((attribution) => attribution.provider),
    );
    if (providers.length > 0) {
      await this.store.recordModelAttribution(request, {
        providers,
        role: input.sourceStep.role,
        contribution: 'change-applier',
        outcome: 'change-applied',
        stepId: input.sourceStep.id,
        phase: input.sourceStep.phase,
      });
    }
    await this.audit.event(
      'ticket.change-request.created',
      `${request.id} opened for ${input.enhancement.id}`,
      {
        messageId: 'engine.quality_change_request_opened',
        changeRequestTicketId: request.id,
        sourceEnhanceTicketId: input.enhancement.id,
        sourceStepId: input.sourceStep.id,
        sourcePhase: input.sourceStep.phase,
        affectedStepIds: affectedSteps.map((step) => step.stepId),
      },
    );
    return request;
  }

  async establishDesign(input: DesignChangeRequestInput): Promise<ChangeRequestTicket> {
    const bug = input.bug;
    const enhancement = await this.enhancements.ensureForBug(bug, input.sourceStep);
    if (!enhancement) {
      throw new Error(`${bug.id} cannot create a change-request without an Enhance finding`);
    }
    const current = input.activeChangeRequest;
    const currentCoversSource = current && (
      current.designSource.stepId === input.sourceStep.id ||
      current.affectedSteps.some((step) => step.stepId === input.sourceStep.id)
    );
    if (current && currentCoversSource) {
      if (!current.relatedTicketIds.includes(bug.id)) {
        await this.changes.requestRework(
          current,
          bug.id,
          `${input.failedTest.id} requires a design correction in ${input.sourceStep.id}`,
        );
      }
      await this.enhancements.linkToChange(enhancement, current.id);
      if (!current.relatedTicketIds.includes(enhancement.id)) {
        await this.store.link(current, enhancement.id, 'enhancement-linked');
      }
      await this.ensureDesignApplication(current, bug, input.sourceStep);
      await this.bugs.markBugBlockedByChange(bug, current);
      return current;
    }

    const repairCommit = bug.repair?.commit ?? await this.headCommit();
    const baselineCommit = bug.repair?.baselineCommit ?? repairCommit;
    const changedArtifacts = dedup(
      bug.repair?.changedFiles?.length
        ? bug.repair.changedFiles
        : input.sourceStep.outputs,
    );
    const affectedSteps = input.affectedSteps.map(affectedStepContract);
    const affectedArtifacts = dedup([
      ...changedArtifacts,
      ...input.affectedSteps.flatMap((step) => step.outputs),
    ]);
    const resolutionPlan = bug.bugResolutionPlan ??
      `Apply the repaired ${input.sourceStep.phase} contract incrementally through the affected downstream steps.`;
    const relatedWorkTicketIds = input.affectedSteps
      .map((step) => this.store.workForStep(step.id)?.id)
      .filter((id): id is string => !!id);
    const request = await this.store.createChangeRequest({
      iterationId: input.sourceStep.iterationId ?? 'P1',
      priority: 'high',
      parentTicketId: current?.id,
      rootTicketId: current?.rootTicketId ?? bug.rootTicketId,
      relatedTicketIds: dedup([enhancement.id, bug.id, ...relatedWorkTicketIds]),
      blockedByTicketIds: [],
      source: {
        kind: 'runtime',
        externalId: `${bug.id}:${input.sourceStep.id}`,
        stepId: input.sourceStep.id,
        phase: input.sourceStep.phase,
        role: input.sourceStep.role,
      },
      title: `${input.sourceStep.phase} correction after ${input.failedTest.phase} failure`,
      description: resolutionPlan,
      objective: resolutionPlan,
      acceptance: [
        input.failedTest.acceptance,
        `All affected tasks pass through ${input.failedTest.id} ${input.failedTest.phase}.`,
      ],
      artifacts: affectedArtifacts,
      sourceEnhanceTicketId: enhancement.id,
      originBugTicketId: bug.id,
      triggerTicketId: enhancement.id,
      scope: {
        in: dedup([
          `${input.sourceStep.id} design correction`,
          ...affectedSteps.map((step) => `${step.stepId} ${step.phase}`),
          ...affectedArtifacts,
        ]),
        out: ['Unrelated requirements, modules, files, and already accepted behavior'],
      },
      trigger: {
        failedStepId: input.failedTest.id,
        failedPhase: input.failedTest.phase,
        failedAcceptance: input.failedTest.acceptance,
        reason: bug.reason,
        failureSummary: bug.debugBrief?.summary ?? bug.failureLog.slice(0, 1200),
        failureEvidencePath: bug.rawFailureLogPath,
      },
      designSource: {
        stepId: input.sourceStep.id,
        phase: input.sourceStep.phase as 'HIGH_LEVEL_DESIGN' | 'DETAILED_DESIGN',
        baselineCommit,
        repairCommit,
        changedArtifacts,
        patchPath: bug.repair?.patchPath,
      },
      contractChange: {
        summary: resolutionPlan,
        before: [
          `Rejected acceptance: ${input.failedTest.acceptance}`,
          `Observed failure: ${bug.debugBrief?.summary ?? bug.reason}`,
        ],
        after: [
          `Accepted repair plan: ${resolutionPlan}`,
          `Repaired artifacts: ${changedArtifacts.join(', ')}`,
        ],
        interfaces: input.sourceStep.outputs.map((output) => `Contract artifact: ${output}`),
        dependencies: input.plan.dependencies ?? [],
        constraints: [
          'Apply only this contract delta; preserve unrelated accepted behavior.',
          `Re-run the affected V-model chain through ${input.failedTest.id} ${input.failedTest.phase}.`,
        ],
      },
      implementationPlan: [
        resolutionPlan,
        `Apply in order: ${affectedSteps.map((step) => `${step.stepId}/${step.phase}`).join(' -> ')}.`,
      ].join('\n'),
      affectedSteps,
      affectedArtifacts,
      verification: {
        targetStepId: input.failedTest.id,
        targetPhase: input.failedTest.phase,
        testArgs: testGateArgs(input.plan, input.failedTest),
        checks: [
          input.failedTest.acceptance,
          ...input.failedTest.outputs.map((output) => `Required output exists: ${output}`),
        ],
        failurePolicy:
          'Create a linked bug ticket, return this change-request ticket to rework, and resume from the paired V-model source. ' +
          'Create a child change-request ticket only when the correction expands the design contract or scope.',
        rollbackTargetStepId: input.sourceStep.id,
        rollbackTargetPhase: input.sourceStep.phase,
      },
      execution: { completedStepIds: [] },
    });
    await this.enhancements.linkToChange(enhancement, request.id);
    await this.ensureDesignApplication(request, bug, input.sourceStep);
    if (current) {
      await this.changes.blockOnChild(
        current,
        request.id,
        bug.id,
        `${request.id} expands ${current.id} to upstream ${input.sourceStep.phase} scope`,
      );
    }
    await this.bugs.markBugBlockedByChange(bug, request);
    await this.audit.event(
      'ticket.change-request.created',
      `${request.id} opened for ${bug.id}`,
      {
        messageId: 'engine.change_request_opened',
        changeRequestTicketId: request.id,
        sourceEnhanceTicketId: enhancement.id,
        parentTicketId: request.parentTicketId,
        bugTicketId: bug.id,
        sourceStepId: input.sourceStep.id,
        sourcePhase: input.sourceStep.phase,
        affectedStepIds: affectedSteps.map((step) => step.stepId),
      },
    );
    return request;
  }

  private async ensureDesignApplication(
    request: ChangeRequestTicket,
    bug: BugTicket,
    sourceStep: Step,
  ): Promise<void> {
    const commit = bug.repair?.commit ?? await this.headCommit();
    const alreadyRecorded = request.applications.some(
      (application) =>
        application.revision === request.revision &&
        application.stepId === sourceStep.id &&
        application.kind === 'design-change' &&
        application.commit === commit,
    );
    if (alreadyRecorded) return;
    await this.changes.recordApplication(request, {
      stepId: sourceStep.id,
      phase: sourceStep.phase,
      kind: 'design-change',
      commit,
      changedFiles: bug.repair?.changedFiles ?? sourceStep.outputs,
      summary: bug.bugResolutionPlan ??
        `Repair ${sourceStep.id} ${sourceStep.phase} contract for ${bug.id}.`,
    });
    const providers = dedup(
      bug.modelAttributions
        .filter((attribution) =>
          attribution.contribution === 'debugger' &&
          attribution.outcome === 'repair-verified'
        )
        .map((attribution) => attribution.provider),
    );
    if (providers.length > 0) {
      await this.store.recordModelAttribution(request, {
        providers,
        role: 'Debugger',
        contribution: 'change-applier',
        outcome: 'change-applied',
        stepId: sourceStep.id,
        phase: sourceStep.phase,
      });
    }
  }
}

function testGateArgs(plan: Plan, step: Step): string[] {
  return pairedTestAssetPaths(plan.steps, step, plan.language).map(normalizeGitPath);
}

function isVModelTestPhase(
  phase: Step['phase'],
): phase is (typeof V_MODEL_TEST_PHASES)[number] {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
