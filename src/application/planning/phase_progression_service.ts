import path from 'node:path';
import type { AuditLogger } from '../../audit/audit.js';
import { Planner, buildPlan, type DraftPhasePlan } from '../../agents/planner.js';
import { DOC_NAMES } from '../../core/docs.js';
import { assertPlanValid } from '../../core/lint.js';
import { advancePhasePlan, phasePlanFileName, type PhasePlan } from '../../core/phase_plan.js';
import type { Plan } from '../../core/plan.js';
import { refreshProjectMemory } from '../../core/project_memory.js';
import { renderPlanMarkdown } from '../../core/render.js';
import { savePhasePlan, savePlan } from '../../core/storage.js';
import { archiveIfExists } from '../../workspace/doc_archive.js';
import type { LLMRouter } from '../../llm/router.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { SkillRegistry } from '../../skills/index.js';

export interface PhaseProgressionResult {
  completedPhaseId: string;
  phasePlan: PhasePlan;
  nextPlan?: Plan;
}

export class PhaseProgressionService {
  constructor(
    private readonly workspace: Workspace,
    /** The container state root. Derived project memory belongs here, never inside a worktree. */
    private readonly state: Workspace,
    /** Project-root control plane. Phase plans never belong to the generated product worktree. */
    private readonly control: Workspace,
    private readonly router: LLMRouter,
    private readonly audit: AuditLogger,
    private readonly terminalOutput: boolean,
    private readonly signal?: AbortSignal,
    private readonly skills?: SkillRegistry,
  ) {}

  async completeAndPrepareNext(input: {
    phasePlan: PhasePlan;
    phasePlanPath: string;
    currentPlanPath: string;
    iterationDelivered: boolean;
  }): Promise<PhaseProgressionResult> {
    if (!input.iterationDelivered) {
      throw new Error('cannot advance implementation phase before its Delivery Feature and Epic close');
    }
    const transition = advancePhasePlan(input.phasePlan);
    const next = transition.nextPhase;
    if (!next) {
      await savePhasePlan(input.phasePlanPath, transition.phasePlan);
      await this.audit.event('plan.persist', `completed final implementation phase ${transition.completedPhaseId}`, {
        messageId: 'execute.phase_completed',
        phaseId: transition.completedPhaseId,
        phasePlanPath: input.phasePlanPath,
      });
      return {
        completedPhaseId: transition.completedPhaseId,
        phasePlan: transition.phasePlan,
      };
    }

    next.planPath ??= phasePlanFileName(next.id);
    const nextPlanPath = path.resolve(path.dirname(input.phasePlanPath), next.planPath);
    assertWorkspacePath(this.control.root, nextPlanPath);
    const topic = await this.workspace.exists(DOC_NAMES.topic)
      ? await this.workspace.readFile(DOC_NAMES.topic)
      : transition.phasePlan.requirementDigest;
    let baselineSummary = transition.phasePlan.baselineSummary;
    try {
      const memory = await refreshProjectMemory(this.workspace, this.state, {
        planPath: input.currentPlanPath,
        language: transition.phasePlan.language,
        intent: transition.phasePlan.intent,
      });
      baselineSummary = memory.summary;
    } catch (error) {
      await this.audit.event('note', `could not refresh phase baseline: ${(error as Error).message}`, {
        messageId: 'execute.phase_baseline_refresh_failed',
        phaseId: next.id,
      });
    }

    const draftPhasePlan: DraftPhasePlan = {
      requirementDigest: transition.phasePlan.requirementDigest,
      globalPrompt: transition.phasePlan.globalPrompt,
      projectType: transition.phasePlan.projectType,
      complexityAssessment: transition.phasePlan.complexityAssessment,
      implementationPhases: transition.phasePlan.phases.map(({ planPath: _planPath, ...phase }) => phase),
    };
    const planner = new Planner(
      this.router.for('Planner'),
      this.audit,
      transition.phasePlan.language,
      this.terminalOutput,
      this.signal,
      this.skills,
    );
    const draft = await planner.decomposePhase(
      {
        rawRequirement: topic,
        clarifications: [],
        userAddenda: transition.phasePlan.userAddenda,
        baselineContext: baselineSummary,
        intent: transition.phasePlan.intent,
      },
      draftPhasePlan,
      next.id,
    );
    const nextPlan = buildPlan(draft, {
      language: transition.phasePlan.language,
      intent: transition.phasePlan.intent,
      userAddenda: transition.phasePlan.userAddenda,
      baselineSummary,
    });
    if (nextPlan.phaseId !== next.id) {
      throw new Error(`materialized plan phase ${nextPlan.phaseId} does not match activated phase ${next.id}`);
    }
    assertPlanValid(nextPlan);

    // Publish the concrete plan before phasePlan references it.
    await savePlan(nextPlanPath, nextPlan);
    await savePhasePlan(input.phasePlanPath, transition.phasePlan);
    await archiveIfExists(this.workspace, DOC_NAMES.plan, this.audit, this.state);
    await this.workspace.writeFile(DOC_NAMES.plan, renderPlanMarkdown(nextPlan));
    await refreshProjectMemory(this.workspace, this.state, {
      planPath: nextPlanPath,
      language: nextPlan.language,
      intent: nextPlan.intent,
    });
    await this.audit.event('plan.persist', `prepared implementation phase ${next.id}`, {
      messageId: 'execute.phase_prepared',
      completedPhaseId: transition.completedPhaseId,
      nextPhaseId: next.id,
      nextPlanPath,
      phasePlanPath: input.phasePlanPath,
    });
    return {
      completedPhaseId: transition.completedPhaseId,
      phasePlan: transition.phasePlan,
      nextPlan,
    };
  }
}

function assertWorkspacePath(workspace: string, target: string): void {
  const relative = path.relative(path.resolve(workspace), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`phase plan path escapes workspace: ${target}`);
  }
}
