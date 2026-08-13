import type { AuditLogger } from '../../audit/audit.js';
import { StepExecutor, type ExecutorRunResult, type ToolCallRecord } from '../../agents/executor.js';
import { ensureEssentialToolRefs } from '../../agents/calibration.js';
import { buildDebugBrief } from '../../core/debug_brief.js';
import { DebugWiki, defaultDebugWikiPath, type DebugWikiMatch } from '../../core/debug_wiki.js';
import {
  ContextAssembler,
  type AssembledContext,
} from '../context/context_assembler.js';
import {
  buildDownstreamContextSnippet,
  computeDebugAllowedWrites,
  computeStepAllowedWrites,
  stepContextChars,
} from './execution_context.js';
import { TestPhaseValidator } from './test_phase_validator.js';
import {
  inspectPairedSourceTests,
  mergePairedSourceTestQuality,
} from '../../core/paired_test_contract.js';
import { normalizeGitPath } from './v_model_policy.js';
import { RECORDED_FIXTURE_DIR } from '../../core/external_dependency_contract.js';
import { getLanguageProfile, type LanguageProfile } from '../../core/language.js';
import type { Plan, Step as ExecutionStep } from '../../core/plan.js';
import type { StageQualityAssessment } from '../../core/quality_gate.js';
import type { Step } from '../../domain/steps/step.js';
import {
  TicketSchema,
  appendTicketCommit,
  type BugTicket,
  type Ticket,
  type TicketCommit,
} from '../../domain/tickets/ticket.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import { QualityAssessmentService } from './quality_assessment_service.js';
import type { QualityAssessment } from '../../domain/quality/quality.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import type { Changelist } from '../../domain/evidence/evidence.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { DomainAuditTrail } from '../observability/domain_audit_trail.js';
import type { LLMRouter } from '../../llm/router.js';
import type { RoutingActor } from '../project_management/role_registry.js';
import { resolveSkillOperationWindow } from '../../llm/window.js';
import type { PluginHost } from '../../plugins/host.js';
import type { Sandbox } from '../../sandbox/types.js';
import { buildDefaultSkills, type SkillRegistry } from '../../skills/skill.js';
import {
  buildDefaultRegistry,
  EditGuard,
  resolveWriteChunkBytes,
  isAllowedWrite,
  type ToolContext,
  type ToolExecutionReporter,
  type ToolPermissionRequester,
  type ToolRegistry,
} from '../../tools/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { GitService } from '../../workspace/git.js';
import { createHash } from 'node:crypto';
import { isCancellationError } from '../../core/cancellation.js';
import {
  classifyFailure,
  type AttemptFailure,
  type AttemptFailureKind,
} from './failure_classification.js';
import { collectTestOutcomes, type TestOutcome } from './test_outcome.js';
import type { RecordReplayController } from '../record_replay/controller.js';
import {
  reconcileMeasuredQualityAssessment,
  reconcileDeferredSourceQualityAssessment,
  renderAttemptRetryFeedback,
  prioritizeAttemptFailureEvidence,
  selectActionableAttemptFailure,
  resolveAttemptRoundLimit,
  resolveAttemptTestArgs,
  resolveAttemptVerificationScope,
  resolveBaselineGateExecution,
  shouldPreserveFailedCandidate,
  shouldPreserveExistingFiles,
  type AttemptMode,
} from './attempt_policy.js';
import { VerifiedBugKnowledgeService } from './verified_bug_knowledge_service.js';
import {
  discoverDebugContextPaths,
  extractWorkspacePaths,
} from './debug_context_snippets.js';
import { resolveCorrectionChainOrigin } from './correction_provenance.js';

export {
  prioritizeAttemptFailureEvidence,
  reconcileDeferredSourceQualityAssessment,
  reconcileMeasuredQualityAssessment,
  renderAttemptRetryFeedback,
  selectActionableAttemptFailure,
  resolveAttemptRoundLimit,
  resolveAttemptTestArgs,
  resolveAttemptVerificationScope,
  resolveBaselineGateExecution,
  shouldPreserveFailedCandidate,
  shouldPreserveExistingFiles,
} from './attempt_policy.js';

/**
 * The working copy an attempt actually runs in, together with the Git and sandbox bindings for it.
 *
 * Resolved per attempt rather than fixed at construction, because a Ticket develops in its own
 * worktree: the canonical working copy is only the default for work that has no ChangeSet yet.
 */
export interface ExecutionScope {
  workspace: Workspace;
  git: GitService;
  sandbox: Sandbox;
}

export interface AttemptRunnerOptions {
  workspace: Workspace;
  git: GitService;
  sandbox: Sandbox;
  /** Resolves the scope for one attempt; defaults to the canonical workspace bindings. */
  resolveScope?: (input: AttemptInput) => Promise<ExecutionScope>;
  router: LLMRouter;
  audit: AuditLogger;
  repository: DomainObjectRepositoryPort;
  plugins: PluginHost;
  registry?: ToolRegistry;
  skills?: SkillRegistry;
  maxRoundsPerStep?: number;
  maxDebugRoundsPerStep?: number;
  maxEditLinesPerStep?: number | 'auto';
  requestPermission?: ToolPermissionRequester;
  onToolEvent?: ToolExecutionReporter;
  terminalOutput?: boolean;
  debugWikiPath?: string;
  /**
   * Project-scoped Debug Wiki root, under container state. Without it findings would accumulate in
   * the shared installation tier, where one project's build quirk becomes a retrieval candidate for
   * every unrelated project.
   */
  projectDebugWikiPath?: string;
  recordReplay?: RecordReplayController;
  abortSignal?: AbortSignal;
  /** Character budget for the assembled context block. Unset means no trimming. */
  contextBudgetChars?: number;
}

export interface AttemptInput {
  plan: Plan;
  executionStep: ExecutionStep;
  domainStep: Step;
  ticket: Ticket;
  mode: AttemptMode;
  /**
   * The actor holding this Ticket, with the definition it instantiates. Resolved by PM at routing
   * time rather than here, because which actor holds the work is an assignment fact; the runner
   * only reads what that actor is and which models it may use.
   */
  assignee?: RoutingActor;
}

export interface AttemptResult {
  ok: boolean;
  /**
   * Packages this Step asked for and is not allowed to add itself.
   *
   * Reported rather than acted on here: which Step owns the manifest is a Domain rule, and the
   * transition back to it belongs to PM.
   */
  dependencyRequest?: { packages: string[]; reason: string };
  failureKind?: AttemptFailureKind;
  failure?: AttemptFailure;
  reason?: string;
  failureLog?: string;
  assessment?: QualityAssessment;
  changedFiles: string[];
  changes?: Changelist['entries'];
  commit?: string;
  solutionPlan?: string;
  bugResolutionDisposition?: ExecutorRunResult['bugResolutionDisposition'];
  changeRequestDisposition?: ExecutorRunResult['changeRequestDisposition'];
  wikiEntryIds: string[];
  executor?: ExecutorRunResult;
  testOutcomes: TestOutcome[];
  /** Independent problems found before/past assessment persistence. */
  gateFindings?: DeliveryGateFinding[];
}

export class DomainAttemptRunner {
  private readonly registry: ToolRegistry;
  private readonly skills: SkillRegistry;
  private readonly quality: QualityAssessmentService;
  private readonly wiki: DebugWiki;
  private readonly context: ContextAssembler;
  private readonly profile: LanguageProfile;
  private readonly traces: DomainAuditTrail;
  private readonly knowledge: VerifiedBugKnowledgeService;

  constructor(private readonly options: AttemptRunnerOptions, language: Plan['language']) {
    this.registry = options.registry ?? buildDefaultRegistry();
    this.skills = options.skills ?? buildDefaultSkills();
    this.quality = new QualityAssessmentService(options.repository);
    this.traces = new DomainAuditTrail(options.repository);
    this.wiki = new DebugWiki(
      options.debugWikiPath ?? defaultDebugWikiPath(options.workspace.root),
      // Findings about this codebase go to the project tier; the installation tiers stay shared.
      { projectPath: options.projectDebugWikiPath },
    );
    this.profile = getLanguageProfile(language);
    this.knowledge = new VerifiedBugKnowledgeService(options.repository, this.wiki, this.profile.id);
    this.context = new ContextAssembler(options.repository, {
      wiki: this.wiki,
      language: this.profile.id,
    });
  }

  async initialize(): Promise<void> {
    await this.wiki.load();
    this.options.plugins.applyExtensions({ tools: this.registry, skills: this.skills });
  }

  async synchronizeVerifiedBugResolutions(projectId: Step['projectId']): Promise<void> {
    await this.knowledge.synchronize(projectId);
  }

  async recordVerifiedBugResolution(ticketId: BugTicket['id']): Promise<void> {
    await this.knowledge.record(ticketId);
  }

  async run(input: AttemptInput): Promise<AttemptResult> {
    return this.runAttempt(input);
  }

  private canonicalScope(): ExecutionScope {
    return {
      workspace: this.options.workspace,
      git: this.options.git,
      sandbox: this.options.sandbox,
    };
  }

  private async runAttempt(input: AttemptInput): Promise<AttemptResult> {
    const scope = await this.options.resolveScope?.(input) ?? this.canonicalScope();
    // Persist the baseline before doing any work. Project defects preserve a committed candidate
    // for incremental correction; infrastructure and non-progress failures return here.
    const baseline = await this.recordTicketCommit(scope, input, 'baseline', 'attempt baseline');
    let wikiMatches: DebugWikiMatch[] = [];
    try {
      if (isVerification(input.domainStep)) {
        const inspection = await this.testValidator(scope).inspect(input.plan, input.executionStep);
        if (!inspection.ok) {
          return await this.failAttempt(scope, baseline, input, {
            reason: `${input.domainStep.type} test assets are incomplete`,
            failureLog: inspection.failureLog,
            failure: {
              kind: 'execution',
              category: 'test',
              code: 'test_assets_incomplete',
              message: inspection.failureLog,
              retryable: true,
              switchProvider: false,
            },
            gateFindings: [
              ...inspection.missing.map((file): DeliveryGateFinding => ({
                category: 'test-incomplete',
                summary: `Required baseline test asset is missing: ${file}`,
                evidence: [inspection.failureLog],
                target: 'paired-source',
                dependencyPackages: [],
              })),
              ...inspection.invalid.map((detail): DeliveryGateFinding => ({
                category: 'test-incomplete',
                summary: detail,
                evidence: [inspection.failureLog],
                target: 'paired-source',
                dependencyPackages: [],
              })),
            ],
          });
        }
      }

      // One assembly per attempt: it is both the context the role sees and the single Debug Wiki
      // retrieval, so the snapshot below records exactly what reached the model.
      const assembled = await this.assembleContext(input);
      const debugContext = input.ticket.type === 'bug'
        ? debugContextFrom(input.ticket, input.executionStep, assembled.debugWikiMatches)
        : undefined;
      const retryFeedback = input.ticket.type === 'bug'
        ? await this.latestAttemptFailure(input)
        : undefined;
      wikiMatches = assembled.debugWikiMatches;
      if (wikiMatches.length > 0 && input.ticket.type === 'bug') {
        await this.wiki.recordUse(wikiMatches.map((match) => match.entry.id), {
          brief: debugContext!.brief,
          ticketId: input.ticket.id,
          stepId: input.domainStep.id,
          phase: input.executionStep.phase,
          targetPhase: input.executionStep.phase,
          language: input.plan.language,
          solution: 'Retrieved before the current repair attempt.',
        });
      }

      const environment = await this.buildEnvironment(scope, input, debugContext?.suggestions);
      if (environment.baselineGateExecution.mode !== 'not-applicable') {
        if (environment.verificationScope.testArgs.length === 0) {
          const failureLog = `${input.domainStep.name} declares no executable paired baseline test asset.`;
          return await this.failAttempt(scope, baseline, input, {
            reason: 'Development delivery gate has no paired baseline tests',
            failureLog,
            failure: {
              kind: 'execution',
              category: 'quality',
              code: 'baseline_test_assets_missing',
              message: failureLog,
              retryable: true,
              switchProvider: false,
            },
            gateFindings: [{
              category: 'test-incomplete',
              summary: failureLog,
              evidence: [
                `Declared outputs: ${input.executionStep.outputs.join(', ') || '(none)'}`,
              ],
              target: 'current-step',
              dependencyPackages: [],
            }],
          });
        }
        await this.options.audit.event(
          'note',
          `${input.domainStep.name} development delivery gate: baseline execution ${environment.baselineGateExecution.mode}`,
          {
            messageId: 'domain.development_delivery_gate_policy',
            projectId: input.domainStep.projectId,
            phaseId: input.domainStep.phaseId,
            stepId: input.domainStep.id,
            stepName: input.domainStep.name,
            ticketId: input.ticket.id,
            mode: input.mode,
            stageChecks: input.domainStep.deliveryGate?.checks ?? [],
            baselineGateExecution: environment.baselineGateExecution,
            baselineTestArgs: environment.context.testGateArgs ?? [],
          },
        );
      }
      const result = await environment.executor.run({
        step: input.executionStep,
        stepName: input.domainStep.name,
        executionRole: input.mode === 'debug' ? 'Debugger' : input.domainStep.agent,
        baselineTestExecution: environment.baselineGateExecution.mode === 'defer'
          ? 'defer'
          : 'execute',
        baselineTestExecutionReason: environment.baselineGateExecution.reason,
        tools: environment.tools,
        ctx: environment.context,
        contextSnippets: environment.snippets,
        ticket: input.ticket,
        changeRequest: input.ticket.type === 'change-request' ? input.ticket : undefined,
        enhancement: input.ticket.type === 'enhancement' ? input.ticket : undefined,
        skillHints: environment.hints,
        debugContext: input.ticket.type === 'bug' ? {
          bugTicketId: input.ticket.id,
          reason: retryFeedback
            ? 'The previous repair attempt produced newer failure evidence. Continue from the current workspace state and that evidence; do not restart the original repair.'
            : input.ticket.failure.summary,
          failureLog: prioritizeAttemptFailureEvidence(
            input.ticket.failure.message,
            retryFeedback,
          ),
          debugBrief: retryFeedback
            ? buildDebugBrief({
                reason: 'The latest attempt for this Bug failed after partial progress.',
                failureLog: retryFeedback,
                phase: input.executionStep.phase,
                targetPhase: input.executionStep.phase,
              }).summary
            : debugContext?.brief.summary,
          suggestions: debugContext?.suggestions,
          repairRequired: true,
          verificationScope: environment.verificationScope.inheritedFromTicket
            ? {
                stepId: environment.verificationScope.verificationStepId!,
                phase: environment.verificationScope.verificationPhase!,
                testArgs: environment.verificationScope.testArgs,
              }
            : undefined,
          deferredVerificationScope: environment.verificationScope.deferredToChangeRequest &&
            environment.verificationScope.verificationStepId &&
            environment.verificationScope.verificationPhase
            ? {
                stepId: environment.verificationScope.verificationStepId,
                phase: environment.verificationScope.verificationPhase,
              }
            : undefined,
        } : undefined,
        layeredContext: assembled.text,
        globalPrompt: input.plan.globalPrompt,
        roleIdentity: input.assignee && {
          rolePrompt: input.assignee.definition.rolePrompt,
          capabilityPrompt: input.assignee.definition.capabilityPrompt,
          prohibitions: input.assignee.definition.prohibitions,
        },
        languageProfile: this.profile,
      });
      if (!result.success) {
        const failure = result.toolCalls.some((call) => call.tool === 'run_tests' && !call.ok)
          ? {
              kind: 'execution' as const,
              category: 'test' as const,
              code: 'test_command_failed',
              message: result.error ?? 'Test command failed.',
              retryable: true,
              switchProvider: false,
            }
          : classifyFailure(result.error);
        const failureKind = failure.kind;
        if (
          failureKind === 'execution' &&
          input.ticket.type === 'bug' &&
          wikiMatches.length > 0
        ) {
          await this.wiki.recordFailure(wikiMatches.map((match) => match.entry.id), {
            brief: debugContext!.brief,
            ticketId: input.ticket.id,
            stepId: input.domainStep.id,
            phase: input.executionStep.phase,
            targetPhase: input.executionStep.phase,
            language: input.plan.language,
            solution: 'Retrieved solution did not resolve the attempt.',
            reason: result.error,
          });
        }
        return await this.failAttempt(scope, baseline, input, {
          reason: result.error ?? 'Step executor did not complete',
          failureLog: renderExecutorFailure(result),
          failureKind,
          failure,
          executor: result,
          dependencyRequest: dependencyRequestFrom(result.toolCalls),
          wikiEntryIds: wikiMatches.map((match) => match.entry.id),
        });
      }

      const pairedTestInspection = await inspectPairedSourceTests(
        scope.workspace,
        input.plan,
        input.executionStep,
      );
      const status = await scope.git.raw().status();
      const changedFiles = status.files.map((file) => normalizeGitPath(file.path));
      const changes = status.files.map((file) => ({
        path: normalizeGitPath(file.path),
        operation: gitChangeOperation(file.index, file.working_dir),
      }));
      const measuredAssessment = reconcileMeasuredQualityAssessment(
        result.qualityAssessment,
        result.toolCalls,
      );
      const scopedAssessment = reconcileDeferredSourceQualityAssessment(measuredAssessment, {
        currentPhase: input.executionStep.phase,
        deferredToChangeRequest: environment.verificationScope.deferredToChangeRequest,
        verificationPhase: environment.verificationScope.verificationPhase,
        changedFiles,
      });
      if (measuredAssessment && scopedAssessment && measuredAssessment.gaps.length > scopedAssessment.gaps.length) {
        await this.options.audit.event(
          'note',
          `Deferred ${input.executionStep.phase} verification gaps to ${environment.verificationScope.verificationPhase}`,
          {
            messageId: 'audit.source_quality_verification_deferred',
            stepId: input.domainStep.id,
            ticketId: input.ticket.id,
            verificationStepId: environment.verificationScope.verificationStepId,
            verificationPhase: environment.verificationScope.verificationPhase,
            deferredGaps: measuredAssessment.gaps,
            changedFiles,
          },
        );
      }
      const assessment = await this.recordAssessment(
        input.domainStep,
        scopedAssessment
          ? mergePairedSourceTestQuality(scopedAssessment, pairedTestInspection)
          : scopedAssessment,
      );
      if (!assessment.passed) {
        return await this.failAttempt(scope, baseline, input, {
          reason: `Quality gate failed: ${assessment.gaps.join('; ')}`,
          failureLog: assessment.gaps.join('\n'),
          assessment,
          failure: {
            kind: 'execution',
            category: 'quality',
            code: 'quality_gate_failed',
            message: assessment.gaps.join('; '),
            retryable: true,
            switchProvider: false,
          },
          executor: result,
          wikiEntryIds: wikiMatches.map((match) => match.entry.id),
        });
      }
      if (environment.baselineGateExecution.mode !== 'not-applicable') {
        const baselineCalls = result.toolCalls.filter((call) => call.tool === 'run_tests');
        await this.options.audit.event(
          'note',
          `${input.domainStep.name} development delivery gate passed`,
          {
            messageId: 'domain.development_delivery_gate_passed',
            projectId: input.domainStep.projectId,
            phaseId: input.domainStep.phaseId,
            stepId: input.domainStep.id,
            stepName: input.domainStep.name,
            ticketId: input.ticket.id,
            stageValidation: 'passed',
            baselineExecution: environment.baselineGateExecution.mode === 'defer'
              ? environment.baselineGateExecution.reason === 'initial-pre-code'
                ? 'skipped-initial-pre-code'
                : 'skipped-pre-code-correction'
              : baselineCalls.length > 0
                ? 'passed'
                : 'not-configured',
            baselineEvidence: baselineCalls.map((call) => call.summary ?? call.error ?? call.tool),
          },
        );
      }
      // The manifest can be delivered as a plain file output, not only through add_dependency, and
      // writing it changes nothing about the sandbox on its own. A design that declared its
      // dependencies and left the environment without them hands every later Step a project whose
      // toolchain is not installed.
      await this.syncSandboxIfManifestChanged(scope, changedFiles);
      const commit = await this.recordTicketCommit(scope, input, 'verified', 'verified change');
      return {
        ok: true,
        assessment,
        changedFiles,
        changes,
        commit,
        solutionPlan: result.changeRequestDisposition?.outcome === 'not-applicable'
          ? result.changeRequestDisposition.rationale
          : result.bugResolutionPlan ?? result.finalThought,
        bugResolutionDisposition: result.bugResolutionDisposition,
        changeRequestDisposition: result.changeRequestDisposition,
        wikiEntryIds: wikiMatches.map((match) => match.entry.id),
        executor: result,
        testOutcomes: collectTestOutcomes(result.toolCalls, input.domainStep.type),
        gateFindings: [],
      };
    } catch (error) {
      if (isAttemptCancellation(error, this.options.abortSignal)) {
        await scope.git.revertTo(baseline);
        throw error;
      }
      // A thrown error on our own execution path carries a message this runtime authored.
      const failure = classifyFailure(error, { trustProviderText: true });
      return this.failAttempt(scope, baseline, input, {
        reason: error instanceof Error ? error.message : String(error),
        failureLog: error instanceof Error ? error.stack ?? error.message : String(error),
        failureKind: failure.kind,
        failure,
        wikiEntryIds: wikiMatches.map((match) => match.entry.id),
      });
    }
  }

  private async buildEnvironment(scope: ExecutionScope, input: AttemptInput, debugSuggestions?: string) {
    const incremental = input.mode !== 'normal';
    const verificationScope = resolveAttemptVerificationScope(
      input.plan,
      input.executionStep,
      input.ticket,
    );
    const correctionOrigin = await resolveCorrectionChainOrigin(
      this.options.repository,
      input.plan,
      input.ticket,
    );
    const baselineGateExecution = resolveBaselineGateExecution(
      input.plan,
      input.executionStep,
      input.ticket,
      correctionOrigin,
    );
    const refs = ensureEssentialToolRefs(input.executionStep);
    const expanded = this.skills.resolve(incremental
      ? [...refs, 'read_file', 'list_dir', 'code_search', 'replace_in_file', 'apply_patch']
      : refs);
    if (input.mode === 'debug') {
      const debuggerSkill = this.skills.get('debugger');
      if (debuggerSkill) {
        expanded.resolvedToolNames.push(...debuggerSkill.tools);
        expanded.hints.push(`[debugger] ${debuggerSkill.prompt}`);
      }
    }
    if (debugSuggestions) expanded.hints.push(`[debug-wiki] ${debugSuggestions}`);
    const resolvedToolNames = [...expanded.resolvedToolNames];
    if (
      (verificationScope.inheritedFromTicket || baselineGateExecution.mode === 'execute') &&
      verificationScope.testArgs.length > 0 &&
      this.registry.get('run_tests')
    ) {
      resolvedToolNames.push('run_tests');
    }
    const toolNames = [...new Set(resolvedToolNames)].filter((name) =>
      baselineGateExecution.mode !== 'defer' || name !== 'run_tests'
    );
    const baseWrites = incremental
      ? computeDebugAllowedWrites(input.plan, input.executionStep, this.profile)
      : computeStepAllowedWrites(input.executionStep);
    const affected = input.ticket.type === 'change-request' && !isVerification(input.domainStep)
      ? input.ticket.contractDelta.affectedArtifacts.filter((artifact) =>
          input.executionStep.outputs.some((output) => pathsOverlap(output, artifact))
        )
      : [];
    const supplementalTestRoot = isVerification(input.domainStep)
      ? this.testValidator(scope).supplementalRoot(input.executionStep)
      : undefined;
    const allowedWrites = [...new Set([
      ...baseWrites,
      ...affected,
      ...(supplementalTestRoot ? [supplementalTestRoot, `${RECORDED_FIXTURE_DIR}/`] : []),
    ])];
    const retryFeedback = await this.latestAttemptFailure(input);
    const rewriteExistingFiles = input.mode === 'debug'
      ? await this.failureEvidenceRewriteTargets(scope, input, allowedWrites, retryFeedback)
      : [];
    const budgetContext = {
      phase: input.executionStep.phase,
      role: input.mode === 'debug' ? 'Debugger' as const : input.domainStep.agent,
      debug: input.mode === 'debug',
      tools: toolNames,
      outputs: input.executionStep.outputs,
      allowedWrites,
      contextChars: stepContextChars(input.plan, input.executionStep),
      contextWindowTokens: this.options.router.primaryContextWindow?.(
        input.mode === 'debug' ? 'Debugger' : input.domainStep.agent,
      ),
    };
    const window = resolveSkillOperationWindow({
      contextWindowTokens: budgetContext.contextWindowTokens,
      promptChars: budgetContext.contextChars,
    });
    const guard = new EditGuard({
      ws: scope.workspace,
      stepId: input.domainStep.id,
      maxLines: this.options.maxEditLinesPerStep ?? 'auto',
      budgetContext,
    });
    const tools = this.registry.pick(toolNames).map((tool) => {
      const guarded = guard.wrap(tool);
      return this.options.plugins.size > 0 ? this.options.plugins.wrapTool(guarded) : guarded;
    });
    const context: ToolContext = {
      ws: scope.workspace,
      sandbox: scope.sandbox,
      audit: this.options.audit,
      allowedWrites,
      stepId: input.domainStep.id,
      phase: input.domainStep.type,
      language: input.plan.language,
      contextWindowTokens: window.contextWindowTokens,
      responseTokenBudget: window.responseTokenBudget,
      feedbackCharBudget: window.feedbackCharBudget,
      readChunkBytes: window.readChunkBytes,
      writeChunkBytes: resolveWriteChunkBytes(window.writeChunkBytes, budgetContext),
      testGateArgs: resolveAttemptTestArgs(verificationScope, input.plan.language),
      supplementalTestRoot,
      preserveExistingFiles: shouldPreserveExistingFiles(input.mode),
      rewriteExistingFiles,
      requestPermission: this.options.requestPermission,
      onToolEvent: this.options.onToolEvent,
      recordReplay: this.options.recordReplay,
    };
    const snippets = await this.contextSnippets(scope, input, retryFeedback);
    const rounds = resolveAttemptRoundLimit(
      input.mode,
      this.options.maxRoundsPerStep ?? 6,
      this.options.maxDebugRoundsPerStep,
    );
    return {
      executor: new StepExecutor({
        llm: this.options.router.for(
          input.mode === 'debug' ? 'Debugger' : input.domainStep.agent,
          { providerPool: input.assignee?.actor.llmBinding?.providerPool },
        ),
        signal: this.options.abortSignal,
        streamOutput: this.options.terminalOutput === true,
        maxRounds: rounds,
      }),
      tools,
      context,
      snippets,
      hints: expanded.hints,
      verificationScope,
      baselineGateExecution,
    };
  }

  private async contextSnippets(
    scope: ExecutionScope,
    input: AttemptInput,
    retryFeedback?: string,
  ): Promise<Array<{ path: string; content: string }>> {
    const candidates = new Set([
      ...input.executionStep.inputs,
      ...(input.mode === 'normal' ? [] : input.executionStep.outputs),
      'docs/topic.md',
      'docs/01-requirement-analysis.md',
      'docs/02-high-level-design.md',
      'docs/03-detailed-design.md',
    ]);
    const snippets: Array<{ path: string; content: string }> = [{
      path: `.xcompiler/objects/ticket/${input.ticket.id}.json`,
      content: JSON.stringify(input.ticket, null, 2),
    }];
    if (retryFeedback) {
      snippets.push({
        path: `.xcompiler/retry/${input.ticket.name}.md`,
        content: retryFeedback,
      });
    }
    if (input.mode === 'debug' || input.mode === 'change-request') {
      const failureEvidence = input.ticket.type === 'bug'
        ? [input.ticket.failure.summary, input.ticket.failure.message, retryFeedback ?? ''].join('\n')
        : input.ticket.type === 'change-request'
          ? [
              input.ticket.contractDelta.summary,
              ...input.ticket.contractDelta.before,
              ...input.ticket.contractDelta.affectedArtifacts,
              retryFeedback ?? '',
            ].join('\n')
          : retryFeedback;
      const debugPaths = await discoverDebugContextPaths({
        workspace: scope.workspace,
        seedPaths: [
          ...input.executionStep.outputs,
          ...(input.ticket.type === 'change-request'
            ? input.ticket.contractDelta.affectedArtifacts
            : []),
        ],
        failureEvidence,
        language: input.plan.language,
      });
      for (const debugPath of debugPaths) candidates.add(debugPath);
    }
    if ((input.plan.architectureModules?.length ?? 0) > 0) {
      snippets.push({
        path: '.xcompiler/architecture-contract.json',
        content: JSON.stringify({ architectureModules: input.plan.architectureModules }, null, 2),
      });
    }
    const downstream = buildDownstreamContextSnippet(input.plan, input.executionStep);
    if (downstream) snippets.push({ path: `.xcompiler/downstream/${input.domainStep.name}.md`, content: downstream });
    for (const candidate of candidates) {
      if (!candidate || candidate.endsWith('/') || !(await scope.workspace.exists(candidate))) continue;
      snippets.push({ path: candidate, content: await scope.workspace.readFile(candidate) });
    }
    return snippets;
  }

  private async failureEvidenceRewriteTargets(
    scope: ExecutionScope,
    input: AttemptInput,
    allowedWrites: string[],
    retryFeedback?: string,
  ): Promise<string[]> {
    const evidence = input.ticket.type === 'bug'
      ? [input.ticket.failure.summary, input.ticket.failure.message, retryFeedback ?? ''].join('\n')
      : retryFeedback ?? '';
    const targets: string[] = [];
    for (const candidate of extractWorkspacePaths(evidence)) {
      if (!isAllowedWrite(candidate, allowedWrites)) continue;
      if (!(await scope.workspace.exists(candidate))) continue;
      targets.push(candidate);
    }
    return [...new Set(targets)];
  }

  private async latestAttemptFailure(input: AttemptInput): Promise<string | undefined> {
    const failures = [];
    for (const logId of input.ticket.logIds) {
      const object = await this.options.repository.read(logId);
      if (object.objectType !== 'log' || object.level !== 'error') continue;
      if (object.data.stepId !== input.domainStep.id) continue;
      failures.push(object);
    }
    const selected = selectActionableAttemptFailure(failures);
    return selected ? renderAttemptRetryFeedback(selected, input.executionStep.phase) : undefined;
  }

  private async recordAssessment(step: Step, value?: StageQualityAssessment): Promise<QualityAssessment> {
    const metrics = [
      ...(value?.completion === undefined ? [] : [{ metric: 'completion', value: value.completion }]),
      ...(value?.upstreamAlignment === undefined ? [] : [{ metric: 'upstreamAlignment', value: value.upstreamAlignment }]),
      ...Object.entries(value?.metrics ?? {}).map(([metric, metricValue]) => ({ metric, value: metricValue })),
    ];
    return this.quality.assessStep({
      step,
      metrics,
      // A precondition the Step does not own is recorded, not held against it. It reaches the gate
      // as evidence so the assessment still shows why the Step could go no further.
      evidence: [
        ...(value?.evidence ?? []),
        ...(value?.blockedBy ?? []).map((blocker) => `blocked by: ${blocker}`),
      ],
      gaps: [
        ...(value?.gaps ?? []),
        ...((value?.tolerance.failedTests ?? 0) > step.tolerance.maxFailedTests
          ? [`failedTests=${value!.tolerance.failedTests}`]
          : []),
        ...((value?.tolerance.skippedTests ?? 0) > step.tolerance.maxSkippedTests
          ? [`skippedTests=${value!.tolerance.skippedTests}`]
          : []),
        ...((value?.tolerance.warnings ?? 0) > step.tolerance.maxWarnings
          ? [`warnings=${value!.tolerance.warnings}`]
          : []),
      ],
      findings: value?.findings ?? [],
    });
  }

  /**
   * Assembles the layered context for this attempt and records what it contained.
   *
   * The snapshot is persisted rather than kept in memory because its purpose is replay: an attempt
   * can only be re-run against the context it actually saw if the revisions of every source and the
   * wiki entries retrieved survive the run.
   */
  private async assembleContext(input: AttemptInput): Promise<AssembledContext> {
    const assembled = await this.context.assemble({
      projectId: input.domainStep.projectId,
      phaseId: input.domainStep.phaseId,
      stepId: input.domainStep.id,
      ticketId: input.ticket.id,
      budgetChars: this.options.contextBudgetChars,
      debugBrief: input.ticket.type === 'bug'
        ? debugBriefFor(input.ticket, input.executionStep)
        : undefined,
    });
    await this.traces.recordLog({
      projectId: input.domainStep.projectId,
      subject: { id: input.ticket.id, objectType: 'ticket' },
      level: 'info',
      message: `context assembled for ${input.domainStep.name}`,
      data: {
        phaseId: input.domainStep.phaseId,
        stepId: input.domainStep.id,
        mode: input.mode,
        attempt: input.domainStep.attempts,
        snapshot: assembled.snapshot,
      },
      correlationId: input.ticket.source.correlationId,
    });
    return assembled;
  }

  private testValidator(scope: ExecutionScope): TestPhaseValidator {
    return new TestPhaseValidator(scope.workspace);
  }

  /**
   * Snapshots the working copy and records the commit on the Ticket in one step, so the Ticket is
   * always the authority on what can be rolled back to.
   */
  /** Rebuilds the sandbox when an attempt delivered a new dependency manifest. */
  private async syncSandboxIfManifestChanged(
    scope: ExecutionScope,
    changedFiles: readonly string[],
  ): Promise<void> {
    const manifest = this.profile.manifestFile;
    if (!deliveredManifest(changedFiles, manifest)) return;
    try {
      const built = await scope.sandbox.build(manifest);
      await this.options.audit.event('sandbox.exec', `sandbox synced after ${manifest} changed`, {
        messageId: 'execute.sandbox_synced',
        rebuilt: built.rebuilt,
        reason: built.reason,
      });
    } catch (error) {
      // Reported, not thrown: the Step did deliver its design, and a Step that cannot resolve the
      // packages will say so itself with the condition in front of it.
      await this.options.audit.event('note', `sandbox sync failed after ${manifest} changed: ${(error as Error).message}`, {
        messageId: 'execute.sandbox_sync_failed',
      });
    }
  }

  private async recordTicketCommit(
    scope: ExecutionScope,
    input: AttemptInput,
    kind: TicketCommit['kind'],
    summary: string,
  ): Promise<string> {
    const revision = await scope.git.snapshot(
      input.domainStep.id,
      input.domainStep.attempts,
      summary,
    );
    const current = await this.options.repository.read(input.ticket.id);
    if (current.objectType !== 'ticket') throw new Error(`Object ${input.ticket.id} is not a Ticket`);
    const updated = appendTicketCommit(current, {
      revision,
      kind,
      attempt: input.domainStep.attempts,
      stepId: input.domainStep.id,
      summary,
      recordedAt: new Date().toISOString(),
    });
    await this.options.repository.update(
      TicketSchema.parse({ ...updated, ...reviseObjectEnvelope(updated) }),
      updated.state,
    );
    return revision;
  }

  private async failAttempt(
    scope: ExecutionScope,
    baseline: string,
    input: AttemptInput,
    failure: Omit<AttemptResult, 'ok' | 'changedFiles' | 'wikiEntryIds' | 'testOutcomes' | 'gateFindings'> & {
      wikiEntryIds?: string[];
      testOutcomes?: TestOutcome[];
      gateFindings?: DeliveryGateFinding[];
    },
  ): Promise<AttemptResult> {
    // `reason` is authored by this runtime, so provider phrasing in it is trustworthy evidence.
    // `failureLog` is captured from the generated project and must not be text-matched.
    const classified = failure.failure ?? (failure.reason !== undefined
      ? classifyFailure(failure.reason)
      : classifyFailure(failure.failureLog, { trustProviderText: false }));
    const failureKind = failure.failureKind ?? classified.kind;
    const preserveCandidate = shouldPreserveFailedCandidate(
      classified,
      failure.dependencyRequest !== undefined,
    );
    const status = await scope.git.raw().status();
    const changedFiles = status.files.map((file) => normalizeGitPath(file.path));
    const changes = status.files.map((file) => ({
      path: normalizeGitPath(file.path),
      operation: gitChangeOperation(file.index, file.working_dir),
    }));
    const commit = preserveCandidate
      ? await this.recordTicketCommit(scope, input, 'attempt', 'rejected candidate')
      : undefined;
    if (!preserveCandidate) await scope.git.revertTo(baseline);
    const testOutcomes = failure.testOutcomes ?? collectTestOutcomes(
      failure.executor?.toolCalls ?? [],
      input.domainStep.type,
    );
    const brief = buildDebugBrief({
      reason: failure.reason,
      failureLog: failure.failureLog,
      phase: input.executionStep.phase,
      targetPhase: input.executionStep.phase,
      typedFailure: classified,
    });
    const failureSignature = createHash('sha256').update(JSON.stringify({
      category: brief.category,
      primaryError: brief.primaryError,
      failedTests: brief.failedTests,
      toolFailures: brief.toolFailures,
      structuredCode: classified.code,
    })).digest('hex');
    await this.options.audit.event('note', `attempt failed for ${input.domainStep.name}: ${failure.reason}`, {
      messageId: 'domain.attempt_failed',
      projectId: input.domainStep.projectId,
      phaseId: input.domainStep.phaseId,
      stepId: input.domainStep.id,
      stepName: input.domainStep.name,
      ticketId: input.ticket.id,
      reason: failure.reason,
    });
    await this.traces.recordLog({
      projectId: input.domainStep.projectId,
      subject: { id: input.ticket.id, objectType: 'ticket' },
      level: 'error',
      message: failure.reason ?? `Attempt failed for ${input.domainStep.name}`,
      data: {
        phaseId: input.domainStep.phaseId,
        stepId: input.domainStep.id,
        stepName: input.domainStep.name,
        mode: input.mode,
        failureLog: failure.failureLog,
        failureCategory: brief.category,
        structuredFailure: classified,
        testOutcomes,
        failureSignature,
        workspaceDisposition: preserveCandidate ? 'candidate-preserved' : 'rolled-back',
        candidateRevision: commit,
        changedFiles,
      },
      correlationId: input.ticket.source.correlationId,
      causationId: input.ticket.source.causationId,
    });
    await this.options.audit.event('note', `structured failure classified for ${input.domainStep.name}`, {
      messageId: 'domain.attempt_failure_classified',
      stepId: input.domainStep.id,
      ticketId: input.ticket.id,
      failure: classified,
      testOutcomes,
      gateFindings: failure.gateFindings ?? failure.assessment?.findings ?? [],
      workspaceDisposition: preserveCandidate ? 'candidate-preserved' : 'rolled-back',
      candidateRevision: commit,
      changedFiles,
    });
    return {
      ok: false,
      changedFiles,
      changes,
      commit,
      wikiEntryIds: [],
      ...failure,
      failure: classified,
      failureKind,
      testOutcomes,
      gateFindings: failure.gateFindings ?? failure.assessment?.findings ?? [],
    };
  }
}

export function isAttemptCancellation(error: unknown, signal?: AbortSignal): boolean {
  return isCancellationError(error, signal);
}

function isVerification(step: Step): boolean {
  return ['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(step.type);
}

export function renderExecutorFailure(result: ExecutorRunResult): string {
  return [
    result.error ?? 'Executor failed.',
    // Tool errors name the category (for example `npm test exit=1`); their summaries carry the
    // bounded stderr/stdout evidence. Persisting the shorter error first discarded failed test names,
    // assertions, and stacks before the Bug Ticket was created.
    ...result.toolCalls.filter((call) => !call.ok).map((call) =>
      `${call.tool}: ${call.summary ?? call.error ?? 'failed'}`),
  ].join('\n');
}

export function changelistEntries(files: readonly string[]) {
  return [...new Set(files)].map((file) => ({
    path: file,
    operation: 'update' as const,
  }));
}

/**
 * The packages a Step asked for and was refused because another phase owns the manifest.
 *
 * Read from the tool's code rather than its message: an earlier wording change here silently
 * switched a Step from retrying to aborting, and this decides whether the whole flow rolls back.
 */
/**
 * Whether an attempt delivered the dependency manifest.
 *
 * Matched at a path boundary so a file merely ending in the manifest's name — `vendor-package.json`
 * — does not trigger a rebuild of an environment nothing asked to change.
 */
export function deliveredManifest(changedFiles: readonly string[], manifestFile: string): boolean {
  return changedFiles.some((file) => file === manifestFile || file.endsWith(`/${manifestFile}`));
}

function dependencyRequestFrom(
  calls: readonly ToolCallRecord[],
): { packages: string[]; reason: string } | undefined {
  const refused = calls.filter((call) => call.code === 'dependency_not_owned');
  if (refused.length === 0) return undefined;
  const packages = [...new Set(refused.flatMap((call) => {
    const asked = (call.args as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(asked) ? asked.filter((item): item is string => typeof item === 'string') : [];
  }))];
  if (packages.length === 0) return undefined;
  return { packages, reason: refused[0]!.error ?? 'A Step requested packages it does not own.' };
}

function gitChangeOperation(index: string, workingDirectory: string): Changelist['entries'][number]['operation'] {
  const status = `${index}${workingDirectory}`;
  if (status.includes('D')) return 'delete';
  if (status.includes('R')) return 'rename';
  if (status.includes('A') || status.includes('?')) return 'create';
  return 'update';
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeGitPath(left);
  const b = normalizeGitPath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function debugBriefFor(ticket: BugTicket, step: ExecutionStep) {
  return buildDebugBrief({
    reason: ticket.failure.summary,
    failureLog: ticket.failure.message,
    phase: step.phase,
    targetPhase: step.phase,
    typedFailure: ticket.failure,
  });
}

function debugContextFrom(ticket: BugTicket, step: ExecutionStep, matches: DebugWikiMatch[]) {
  return {
    brief: debugBriefFor(ticket, step),
    matches,
    suggestions: matches.length === 0 ? undefined : [
      'Relevant debug-wiki entries (validate before applying):',
      'These are hypotheses. Discard any entry contradicted by current files or executable failure evidence.',
      ...matches.map((match) =>
        match.entry.status === 'needs_review'
          ? `- ${match.entry.id} status=needs_review: prior solution intentionally hidden; derive a fresh solution from current evidence`
          : `- ${match.entry.id} status=${match.entry.status} confidence=${match.confidence?.toFixed(2) ?? 'unknown'}: ${match.entry.solution}`),
    ].join('\n'),
  };
}
