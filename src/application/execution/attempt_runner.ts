import type { AuditLogger } from '../../audit/audit.js';
import { StepExecutor, type ExecutorRunResult } from '../../agents/executor.js';
import { ensureEssentialToolRefs } from '../../agents/calibration.js';
import {
  buildDebugBrief,
  compactFailureEvidence,
  renderDebugBriefForPrompt,
} from '../../core/debug_brief.js';
import { DebugWiki, defaultDebugWikiPath, type DebugWikiMatch } from '../../core/debug_wiki.js';
import {
  buildDownstreamContextSnippet,
  computeDebugAllowedWrites,
  computeStepAllowedWrites,
  stepContextChars,
} from './execution_context.js';
import { TestPhaseValidator } from './test_phase_validator.js';
import { isTestFilePath, normalizeGitPath } from './v_model_policy.js';
import { getLanguageProfile, type LanguageProfile } from '../../core/language.js';
import type { Plan, Step as ExecutionStep } from '../../core/plan.js';
import type { StageQualityAssessment } from '../../core/quality_gate.js';
import { pairedTestAssetPaths } from '../../core/test_assets.js';
import type { Step } from '../../domain/steps/step.js';
import { TicketSchema, type BugTicket, type Ticket } from '../../domain/tickets/ticket.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import { QualityAssessmentService } from '../../domain/quality/assessment_service.js';
import type { QualityAssessment } from '../../domain/quality/quality.js';
import type { Changelist } from '../../domain/evidence/evidence.js';
import type { DomainObjectRepository } from '../../infrastructure/repository/domain_object_repository.js';
import { DomainAuditTrail } from '../../domain/observability/audit_trail.js';
import type { DomainLog } from '../../domain/observability/records.js';
import type { LLMRouter } from '../../llm/router.js';
import { resolveSkillOperationWindow } from '../../llm/window.js';
import type { PluginHost } from '../../plugins/host.js';
import type { Sandbox } from '../../sandbox/types.js';
import { buildDefaultSkills, type SkillRegistry } from '../../skills/skill.js';
import {
  buildDefaultRegistry,
  EditGuard,
  resolveWriteChunkBytes,
  type ToolContext,
  type ToolExecutionReporter,
  type ToolPermissionRequester,
  type ToolRegistry,
  type WriteChunkBytes,
} from '../../tools/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { GitService } from '../../workspace/git.js';
import { createHash } from 'node:crypto';
import { executionPhaseFor } from './execution_adapter.js';
import {
  classifyAttemptFailure,
  type AttemptFailureKind,
} from './failure_classification.js';

export interface AttemptRunnerOptions {
  workspace: Workspace;
  git: GitService;
  sandbox: Sandbox;
  router: LLMRouter;
  audit: AuditLogger;
  repository: DomainObjectRepository;
  plugins: PluginHost;
  registry?: ToolRegistry;
  skills?: SkillRegistry;
  maxRoundsPerStep?: number;
  maxDebugRoundsPerStep?: number;
  maxEditLinesPerStep?: number | 'auto';
  maxWriteChunkBytes?: WriteChunkBytes;
  requestPermission?: ToolPermissionRequester;
  onToolEvent?: ToolExecutionReporter;
  terminalOutput?: boolean;
  debugWikiPath?: string;
}

export interface AttemptInput {
  plan: Plan;
  executionStep: ExecutionStep;
  domainStep: Step;
  ticket: Ticket;
  mode: 'normal' | 'debug' | 'enhancement' | 'change-request';
}

export interface AttemptResult {
  ok: boolean;
  failureKind?: AttemptFailureKind;
  reason?: string;
  failureLog?: string;
  assessment?: QualityAssessment;
  changedFiles: string[];
  changes?: Changelist['entries'];
  commit?: string;
  solutionPlan?: string;
  wikiEntryIds: string[];
  executor?: ExecutorRunResult;
}

export interface AttemptVerificationScope {
  testArgs: string[];
  inheritedFromTicket: boolean;
  verificationStepId?: string;
  verificationPhase?: ExecutionStep['phase'];
}

export function resolveAttemptTestArgs(
  scope: AttemptVerificationScope,
  language: Plan['language'],
): string[] {
  const args = [...scope.testArgs];
  if (
    language === 'typescript' &&
    scope.verificationPhase === 'UNIT_TEST' &&
    !args.some((arg) => arg === '--coverage' || arg.startsWith('--coverage.'))
  ) {
    args.push('--coverage');
  }
  return args;
}

export function resolveAttemptRoundLimit(
  mode: AttemptInput['mode'],
  configuredRounds: number,
  configuredCorrectiveRounds?: number,
): number {
  if (mode === 'normal') return configuredRounds;
  return configuredCorrectiveRounds ?? Math.ceil(configuredRounds * 1.5);
}

export function reconcileMeasuredQualityAssessment(
  value: StageQualityAssessment | undefined,
  toolCalls: ExecutorRunResult['toolCalls'],
): StageQualityAssessment | undefined {
  if (!value) return value;
  const summaries = toolCalls
    .filter((call) => call.ok && call.tool === 'run_tests' && call.summary)
    .map((call) => call.summary!);
  const measured = [...summaries].reverse().map((summary) => ({
    summary,
    coverage: summary.match(
      /coverage statements=(\d+(?:\.\d+)?)% branches=(\d+(?:\.\d+)?)% functions=(\d+(?:\.\d+)?)% lines=(\d+(?:\.\d+)?)%/u,
    ),
    tests: summary.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/u),
  })).find((item) => item.coverage || item.tests);
  if (!measured) return value;
  const metrics = { ...value.metrics };
  if (measured.coverage) {
    metrics.statementCoverage = Number(measured.coverage[1]) / 100;
    metrics.branchCoverage = Number(measured.coverage[2]) / 100;
    metrics.functionCoverage = Number(measured.coverage[3]) / 100;
    metrics.lineCoverage = Number(measured.coverage[4]) / 100;
  }
  if (measured.tests) {
    const passed = Number(measured.tests[1]);
    const total = Number(measured.tests[2]);
    metrics.testCasePassRate = total > 0 ? passed / total : 0;
  }
  return {
    ...value,
    metrics,
    evidence: [...new Set([...value.evidence, measured.summary])],
  };
}

export function renderAttemptRetryFeedback(
  log: DomainLog,
  phase: ExecutionStep['phase'],
): string {
  const failureLog = typeof log.data.failureLog === 'string'
    ? log.data.failureLog
    : log.message;
  const brief = buildDebugBrief({
    reason: log.message,
    failureLog,
    phase,
    targetPhase: phase,
  });
  const evidence = compactFailureEvidence({
    reason: log.message,
    failureLog,
    phase,
    targetPhase: phase,
    maxChars: 2600,
    maxLines: 36,
  });
  return [
    '## latest failed attempt',
    'The previous attempt for this same Ticket failed and its file changes were rolled back.',
    'Continue from the accepted baseline, diagnose this evidence, and do not repeat the failed approach unchanged.',
    renderDebugBriefForPrompt(brief),
    ...(evidence ? ['## compact failure evidence', '```text', evidence, '```'] : []),
  ].join('\n');
}

export function resolveAttemptVerificationScope(
  plan: Plan,
  executionStep: ExecutionStep,
  ticket: Ticket,
): AttemptVerificationScope {
  const currentTestArgs = pairedTestAssetPaths(plan.steps, executionStep, plan.language);
  const verificationStepId = ticket.type === 'bug'
    ? ticket.failure.verificationStepId
    : ticket.type === 'enhancement'
      ? ticket.verificationStepId
      : undefined;
  const targetStepId = ticket.type === 'bug'
    ? ticket.failure.targetStepId
    : ticket.type === 'enhancement'
      ? ticket.targetStepId
      : undefined;
  const inheritedFromTicket =
    verificationStepId !== undefined &&
    targetStepId === executionStep.id &&
    (ticket.type !== 'bug' || ticket.failure.failedStepId !== ticket.failure.targetStepId) &&
    verificationStepId !== executionStep.id;
  if (!inheritedFromTicket) {
    return {
      testArgs: currentTestArgs,
      inheritedFromTicket: false,
      verificationStepId: isVerificationPhase(executionStep.phase) ? executionStep.id : undefined,
      verificationPhase: isVerificationPhase(executionStep.phase) ? executionStep.phase : undefined,
    };
  }
  const verificationStep = plan.steps.find((step) => step.id === verificationStepId);
  if (!verificationStep) {
    return {
      testArgs: currentTestArgs,
      inheritedFromTicket: false,
    };
  }
  return {
    testArgs: pairedTestAssetPaths(plan.steps, verificationStep, plan.language),
    inheritedFromTicket: true,
    verificationStepId: verificationStep.id,
    verificationPhase: verificationStep.phase,
  };
}

export class DomainAttemptRunner {
  private readonly registry: ToolRegistry;
  private readonly skills: SkillRegistry;
  private readonly quality: QualityAssessmentService;
  private readonly wiki: DebugWiki;
  private readonly profile: LanguageProfile;
  private readonly traces: DomainAuditTrail;

  constructor(private readonly options: AttemptRunnerOptions, language: Plan['language']) {
    this.registry = options.registry ?? buildDefaultRegistry();
    this.skills = options.skills ?? buildDefaultSkills();
    this.quality = new QualityAssessmentService(options.repository);
    this.traces = new DomainAuditTrail(options.repository);
    this.wiki = new DebugWiki(options.debugWikiPath ?? defaultDebugWikiPath(options.workspace.root));
    this.profile = getLanguageProfile(language);
  }

  async initialize(): Promise<void> {
    await this.wiki.load();
    this.options.plugins.applyExtensions({ tools: this.registry, skills: this.skills });
  }

  async synchronizeVerifiedBugResolutions(projectId: Step['projectId']): Promise<void> {
    const tickets = await this.options.repository.list({ objectType: 'ticket', projectId });
    for (const ticket of tickets) {
      if (
        ticket.objectType === 'ticket' &&
        ticket.type === 'bug' &&
        ticket.state === 'closed' &&
        ticket.solution?.status === 'verified' &&
        ticket.debugWikiResolutionEntryIds.length === 0
      ) {
        await this.recordVerifiedBugResolution(ticket.id);
      }
    }
  }

  async recordVerifiedBugResolution(ticketId: BugTicket['id']): Promise<void> {
    const object = await this.options.repository.read(ticketId);
    if (object.objectType !== 'ticket' || object.type !== 'bug') {
      throw new Error(`Ticket ${ticketId} is not a Bug`);
    }
    if (object.state !== 'closed' || object.solution?.status !== 'verified') {
      throw new Error(`Bug ${object.name} must be closed with a verified solution before debug-wiki persistence`);
    }
    if (object.debugWikiResolutionEntryIds.length > 0) return;
    const target = await this.options.repository.read(object.failure.targetStepId);
    if (target.objectType !== 'step') {
      throw new Error(`Bug ${object.name} target ${object.failure.targetStepId} is not a Step`);
    }
    const assessment = target.qualityAssessmentId
      ? await this.options.repository.read(target.qualityAssessmentId)
      : undefined;
    const phase = executionPhaseFor(target.type);
    const brief = buildDebugBrief({
      reason: object.failure.summary,
      failureLog: object.failure.message,
      phase,
      targetPhase: phase,
    });
    const persisted = await this.wiki.recordResolution({
      brief,
      ticketId: object.id,
      stepId: target.id,
      phase,
      targetPhase: phase,
      language: this.profile.id,
      resolutionPlan: object.solution.approach,
      solution: object.solution.approach,
      evidence: [
        ...object.solution.verification,
        ...(assessment?.objectType === 'quality-assessment' ? assessment.evidence : []),
      ],
      repairFiles: object.solution.changes.filter((item) => !item.startsWith('commit:')),
      usedEntryIds: object.debugWikiCandidateEntryIds,
    });
    const entryIds = persisted.created ? [persisted.created] : persisted.updated;
    const updated = TicketSchema.parse({
      ...object,
      ...reviseObjectEnvelope(object),
      debugWikiResolutionEntryIds: entryIds,
    });
    await this.options.repository.update(updated, updated.state);
  }

  async run(input: AttemptInput): Promise<AttemptResult> {
    const baseline = await this.options.git.snapshot(input.domainStep.id, input.domainStep.attempts, 'attempt baseline');
    let wikiMatches: DebugWikiMatch[] = [];
    try {
      if (isVerification(input.domainStep)) {
        const inspection = await this.testValidator().inspect(input.plan, input.executionStep);
        if (!inspection.ok) {
          return await this.failAndRollback(baseline, input, {
            reason: `${input.domainStep.type} test assets are incomplete`,
            failureLog: inspection.failureLog,
          });
        }
      }

      const debugContext = input.ticket.type === 'bug'
        ? await this.buildDebugContext(input.ticket, input.executionStep)
        : undefined;
      wikiMatches = debugContext?.matches ?? [];
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

      const environment = await this.buildEnvironment(input, debugContext?.suggestions);
      const result = await environment.executor.run({
        step: input.executionStep,
        stepName: input.domainStep.name,
        executionRole: input.mode === 'debug' ? 'Debugger' : input.domainStep.agent,
        tools: environment.tools,
        ctx: environment.context,
        contextSnippets: environment.snippets,
        ticket: input.ticket,
        changeRequest: input.ticket.type === 'change-request' ? input.ticket : undefined,
        enhancement: input.ticket.type === 'enhancement' ? input.ticket : undefined,
        skillHints: environment.hints,
        debugContext: input.ticket.type === 'bug' ? {
          bugTicketId: input.ticket.id,
          reason: input.ticket.failure.summary,
          failureLog: input.ticket.failure.message,
          debugBrief: debugContext?.brief.summary,
          suggestions: debugContext?.suggestions,
          repairRequired: true,
          verificationScope: environment.verificationScope.inheritedFromTicket
            ? {
                stepId: environment.verificationScope.verificationStepId!,
                phase: environment.verificationScope.verificationPhase!,
                testArgs: environment.verificationScope.testArgs,
              }
            : undefined,
        } : undefined,
        globalPrompt: input.plan.globalPrompt,
        languageProfile: this.profile,
      });
      if (!result.success) {
        const failureKind = classifyAttemptFailure(result.error);
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
        return await this.failAndRollback(baseline, input, {
          reason: result.error ?? 'Step executor did not complete',
          failureLog: renderExecutorFailure(result),
          failureKind,
          executor: result,
          wikiEntryIds: wikiMatches.map((match) => match.entry.id),
        });
      }

      const assessment = await this.recordAssessment(
        input.domainStep,
        reconcileMeasuredQualityAssessment(result.qualityAssessment, result.toolCalls),
      );
      if (!assessment.passed) {
        return await this.failAndRollback(baseline, input, {
          reason: `Quality gate failed: ${assessment.gaps.join('; ')}`,
          failureLog: assessment.gaps.join('\n'),
          assessment,
          executor: result,
          wikiEntryIds: wikiMatches.map((match) => match.entry.id),
        });
      }
      const status = await this.options.git.raw().status();
      const changedFiles = status.files.map((file) => normalizeGitPath(file.path));
      const changes = status.files.map((file) => ({
        path: normalizeGitPath(file.path),
        operation: gitChangeOperation(file.index, file.working_dir),
      }));
      const commit = await this.options.git.snapshot(input.domainStep.id, input.domainStep.attempts, 'verified change');
      return {
        ok: true,
        assessment,
        changedFiles,
        changes,
        commit,
        solutionPlan: result.bugResolutionPlan ?? result.finalThought,
        wikiEntryIds: wikiMatches.map((match) => match.entry.id),
        executor: result,
      };
    } catch (error) {
      return this.failAndRollback(baseline, input, {
        reason: error instanceof Error ? error.message : String(error),
        failureLog: error instanceof Error ? error.stack ?? error.message : String(error),
        failureKind: classifyAttemptFailure(error),
        wikiEntryIds: wikiMatches.map((match) => match.entry.id),
      });
    }
  }

  private async buildEnvironment(input: AttemptInput, debugSuggestions?: string) {
    const incremental = input.mode !== 'normal';
    const verificationScope = resolveAttemptVerificationScope(
      input.plan,
      input.executionStep,
      input.ticket,
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
      verificationScope.inheritedFromTicket &&
      verificationScope.testArgs.length > 0 &&
      this.registry.get('run_tests')
    ) {
      resolvedToolNames.push('run_tests');
    }
    const toolNames = [...new Set(resolvedToolNames)].filter((name) =>
      !verificationScope.inheritedFromTicket || name !== 'run_program'
    );
    const baseWrites = incremental
      ? computeDebugAllowedWrites(input.plan, input.executionStep, this.profile)
      : computeStepAllowedWrites(input.executionStep);
    const affected = input.ticket.type === 'change-request'
      ? input.ticket.contractDelta.affectedArtifacts
      : [];
    const allowedWrites = [...new Set([...baseWrites, ...affected])]
      .filter((candidate) => !isVerification(input.domainStep) || !isTestFilePath(candidate));
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
      configuredWriteChunkBytes: this.options.maxWriteChunkBytes ?? 'auto',
    });
    const guard = new EditGuard({
      ws: this.options.workspace,
      stepId: input.domainStep.id,
      maxLines: this.options.maxEditLinesPerStep ?? 'auto',
      budgetContext,
    });
    const tools = this.registry.pick(toolNames).map((tool) => {
      const guarded = guard.wrap(tool);
      return this.options.plugins.size > 0 ? this.options.plugins.wrapTool(guarded) : guarded;
    });
    const context: ToolContext = {
      ws: this.options.workspace,
      sandbox: this.options.sandbox,
      audit: this.options.audit,
      allowedWrites,
      stepId: input.domainStep.id,
      language: input.plan.language,
      contextWindowTokens: window.contextWindowTokens,
      responseTokenBudget: window.responseTokenBudget,
      feedbackCharBudget: window.feedbackCharBudget,
      readChunkBytes: window.readChunkBytes,
      writeChunkBytes: resolveWriteChunkBytes(this.options.maxWriteChunkBytes ?? 'auto', budgetContext),
      defaultTestArgs: resolveAttemptTestArgs(verificationScope, input.plan.language),
      preserveExistingFiles: input.mode === 'enhancement' || input.mode === 'change-request',
      requestPermission: this.options.requestPermission,
      onToolEvent: this.options.onToolEvent,
    };
    const snippets = await this.contextSnippets(input);
    const rounds = resolveAttemptRoundLimit(
      input.mode,
      this.options.maxRoundsPerStep ?? 6,
      this.options.maxDebugRoundsPerStep,
    );
    return {
      executor: new StepExecutor({
        llm: this.options.router.for(input.mode === 'debug' ? 'Debugger' : input.domainStep.agent),
        streamOutput: this.options.terminalOutput === true,
        maxRounds: rounds,
        maxWriteChunkBytes: this.options.maxWriteChunkBytes ?? 'auto',
      }),
      tools,
      context,
      snippets,
      hints: expanded.hints,
      verificationScope,
    };
  }

  private async contextSnippets(input: AttemptInput): Promise<Array<{ path: string; content: string }>> {
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
    const retryFeedback = await this.latestAttemptFailure(input);
    if (retryFeedback) {
      snippets.push({
        path: `.xcompiler/retry/${input.ticket.name}.md`,
        content: retryFeedback,
      });
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
      if (!candidate || candidate.endsWith('/') || !(await this.options.workspace.exists(candidate))) continue;
      snippets.push({ path: candidate, content: await this.options.workspace.readFile(candidate) });
    }
    return snippets;
  }

  private async latestAttemptFailure(input: AttemptInput): Promise<string | undefined> {
    for (const logId of [...input.ticket.logIds].reverse()) {
      const object = await this.options.repository.read(logId);
      if (object.objectType !== 'log' || object.level !== 'error') continue;
      if (object.data.stepId !== input.domainStep.id) continue;
      return renderAttemptRetryFeedback(object, input.executionStep.phase);
    }
    return undefined;
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
      evidence: value?.evidence ?? [],
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
    });
  }

  private async buildDebugContext(ticket: BugTicket, step: ExecutionStep) {
    const brief = buildDebugBrief({
      reason: ticket.failure.summary,
      failureLog: ticket.failure.message,
      phase: step.phase,
      targetPhase: step.phase,
    });
    const matches = await this.wiki.search(brief, { language: this.profile.id, limit: 3 });
    const suggestions = matches.length === 0 ? undefined : [
      'Relevant debug-wiki entries (validate before applying):',
      ...matches.map((match) => `- ${match.entry.id}: ${match.entry.solution}`),
    ].join('\n');
    return { brief, matches, suggestions };
  }

  private testValidator(): TestPhaseValidator {
    return new TestPhaseValidator(
      this.options.workspace,
      this.options.sandbox,
      this.options.audit,
      async (request) => this.options.requestPermission
        ? this.options.requestPermission(request)
        : { approved: true },
      (message) => {
        if (this.options.terminalOutput) console.log(message);
      },
    );
  }

  private async failAndRollback(
    baseline: string,
    input: AttemptInput,
    failure: Omit<AttemptResult, 'ok' | 'changedFiles' | 'wikiEntryIds'> & { wikiEntryIds?: string[] },
  ): Promise<AttemptResult> {
    await this.options.git.revertTo(baseline);
    const brief = buildDebugBrief({
      reason: failure.reason,
      failureLog: failure.failureLog,
      phase: input.executionStep.phase,
      targetPhase: input.executionStep.phase,
    });
    const failureSignature = createHash('sha256').update(JSON.stringify({
      category: brief.category,
      primaryError: brief.primaryError,
      failedTests: brief.failedTests,
      toolFailures: brief.toolFailures,
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
        failureSignature,
      },
      correlationId: input.ticket.source.correlationId,
      causationId: input.ticket.source.causationId,
    });
    return { ok: false, changedFiles: [], wikiEntryIds: [], ...failure };
  }
}

function isVerification(step: Step): boolean {
  return ['UNIT_TEST', 'INTEGRATION_TEST', 'SYSTEM_TEST', 'ACCEPTANCE_TEST'].includes(step.type);
}

function isVerificationPhase(phase: ExecutionStep['phase']): boolean {
  return ['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(phase);
}

function renderExecutorFailure(result: ExecutorRunResult): string {
  return [
    result.error ?? 'Executor failed.',
    ...result.toolCalls.filter((call) => !call.ok).map((call) => `${call.tool}: ${call.error ?? call.summary ?? 'failed'}`),
  ].join('\n');
}

export function changelistEntries(files: readonly string[]) {
  return [...new Set(files)].map((file) => ({
    path: file,
    operation: 'update' as const,
  }));
}

function gitChangeOperation(index: string, workingDirectory: string): Changelist['entries'][number]['operation'] {
  const status = `${index}${workingDirectory}`;
  if (status.includes('D')) return 'delete';
  if (status.includes('R')) return 'rename';
  if (status.includes('A') || status.includes('?')) return 'create';
  return 'update';
}
