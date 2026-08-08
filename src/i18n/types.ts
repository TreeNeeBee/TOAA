import type { LanguageProfile } from '../core/language.js';

/**
 * Locale code (ISO 639-1 lowercase). Currently only 'en' (default) and 'zh'.
 * The CLI flag uses ISO 3166-1 Alpha-2 country codes (EN / CN) but normalises
 * to the language code at the boundary — see `src/i18n/index.ts`.
 */
export type Locale = 'en' | 'zh';

export interface SkillPrompt {
  patcher: string;
  author: string;
  tester: string;
  dep_resolver: string;
  debugger: string;
  refactorer: string;
}

export interface Messages {
  // ───────── shared LLM role guidance ─────────
  llm: {
    coderDebuggerSameModel: (model: string, coderProvider: string, debuggerProvider: string) => string;
    invalidBaseUrl: (raw: string, fallback: string) => string;
    providerValidationFailed: (role: string, model: string) => string;
    providerValidationRetry: (role: string, model: string) => string;
    providerValidationRepairPrompt: (error: string) => string;
    providerCallFailed: (role: string, model: string) => string;
    scoreReadFailed: (path: string, message: string) => string;
    scoreChanged: (provider: string, score: string, previous: string) => string;
    scorePersistFailed: (message: string) => string;
    preflightOllamaReachable: (baseUrl: string, models: number) => string;
    preflightOllamaUnreachable: (baseUrl: string, message: string) => string;
    preflightAutoAdded: (providers: number, roles: string) => string;
    scoreFileHeader: string;
    scoreFileSemantics: string;
  };

  system: {
    configEnvMissing: (names: string) => string;
    unhandledError: (message: string) => string;
    unsupportedSubprocessNetworkOff: string;
    dockerInsideContainerUnsupported: string;
    firejailUnsupported: string;
    smokeHeader: (baseUrl: string) => string;
    smokeOk: (model: string, totalMs: number, firstTokenMs: number, chunks: number, preview: string) => string;
    smokeFail: (model: string, message: string) => string;
  };

  plugins: {
    invalidId: (id: string) => string;
    duplicateId: (id: string) => string;
    invalidVersion: (plugin: string, version: string) => string;
    invalidCoreVersion: (version: string) => string;
    apiVersionMismatch: (plugin: string, actual: number, expected: number) => string;
    invalidMinimumVersion: (plugin: string, version: string) => string;
    coreVersionTooOld: (plugin: string, minimum: string, actual: string) => string;
    loaded: (plugin: string, version: string) => string;
    extensionConflict: (plugin: string, kind: string, name: string) => string;
    hookFailed: (plugin: string, stage: string, message: string) => string;
    manifestReadFailed: (path: string, message: string) => string;
    moduleLoadFailed: (plugin: string, path: string, message: string) => string;
    exportInvalid: (plugin: string, exportName: string) => string;
    manifestMismatch: (plugin: string) => string;
  };

  audit: {
    processLogTitle: string;
    processLogPreamble: string;
    sessionStart: (ts: string, command: string) => string;
    sessionEnd: (ts: string) => string;
    eventSessionStart: (command: string) => string;
    eventSessionEnd: (command: string) => string;
    userInput: (label: string) => string;
    llmRequest: (role: string, model: string) => string;
    llmResponse: (role: string, model: string) => string;
    executorTurn: (stepId: string, round: number, role: string, provider: string, actions: number, done: boolean) => string;
    thoughtsLabel: string;
    actionsLabel: string;
    noThoughts: string;
    plannerThought: (stage: string, provider: string) => string;
    markdownAppendFailed: (message: string) => string;
    jsonlAppendFailed: (message: string) => string;
    traceLine: (kind: string, message: string) => string;
    autoFixedSrcImport: (path: string) => string;
    wroteFile: (path: string) => string;
    userDecision: (label: string, value: string) => string;
    eventLlmRequest: (role: string, model: string) => string;
    eventLlmResponse: (role: string, model: string) => string;
    eventLlmError: (role: string, model: string, message: string) => string;
    eventExecutorTurn: (stepId: string, round: number, role: string, provider: string) => string;
    eventPlannerThought: (stage: string, provider: string) => string;
    llmChatFailedThought: (message: string) => string;
    llmChatAborted: (stepId: string, round: number, chars: number, message: string) => string;
    toolDenied: (tool: string) => string;
    toolCalled: (tool: string) => string;
    toolResult: (tool: string, ok: boolean, detail: string) => string;
    documentArchived: (from: string, to: string) => string;
    documentArchiveFailed: (path: string, message: string) => string;
    httpFetchSaved: (method: string, url: string, path: string, bytes: number) => string;
    httpFetchResponse: (method: string, url: string, status: number, bytes: number) => string;
    partialFailureHeader: (message: string) => string;
    streamLength: (chars: number) => string;
  };

  stream: {
    resolvingModel: string;
    waiting: string;
    streaming: string;
    done: string;
    failed: string;
    chars: (n: number) => string;
    toolRunner: string;
    toolExecution: (stepId: string, tool: string) => string;
  };

  sandboxLog: {
    subprocessBuilt: (hasDependencies: boolean) => string;
    subprocessNodeBuilt: string;
    dockerBuilt: (hasDependencies: boolean) => string;
    dockerNodeBuilt: string;
    command: (runtime: string, command: string) => string;
  };

  // ───────── CLI: shared option / argument descriptions ─────────
  cli: {
    rootDescription: string;
    compileDescription: string;
    runDescription: string;
    loadDescription: string;
    appendDescription: string;
    lsDescription: string;
    showDescription: string;
    optWorkspace: string;
    optOutput: string;
    optConfig: string;
    optInput: string;
    optTopic: string;
    optPlanOut: string;
    optBaseDir: string;
    optName: string;
    optYes: string;
    optForce: string;
    optDryRun: string;
    optMaxDepth: string;
    optTail: string;
    optPlan: string;
    optLang: string;
    optIntent: string;
    optBaselinePlan: string;
    optProjectFile: string;
    optDebugWikiPath: string;
    optRecordReplay: string;
    optRecordReplayPath: string;
    argPlan: string;
    argProjectFile: string;
    argStepId: string;
    evolveDescription: string;
    bootstrapDescription: string;
    optRepository: string;
    optPromote: string;
    optCleanup: string;
    optDockerQualification: string;
    invalidLocale: (value: string) => string;
    invalidIntent: (value: string, allowed: string) => string;
    invalidPhase: (value: string, allowed: string) => string;
    invalidStepId: (value: string) => string;
    invalidNonNegativeInteger: (value: string) => string;
    invalidRecordReplayMode: (value: string, allowed: string) => string;
    helpUsage: string;
    helpArguments: string;
    helpOptions: string;
    helpCommands: string;
    helpOption: string;
    versionOption: string;
    defaultValue: (value: string) => string;
  };

  bootstrap: {
    notGitRepository: (path: string) => string;
    dirtyRepository: (files: string) => string;
    worktreeReady: (path: string, branch: string) => string;
    compileStarted: string;
    compileFailed: (exitCode: number, message: string) => string;
    compileCancelled: string;
    executeStarted: string;
    executeFailed: (status: string) => string;
    qualificationStarted: string;
    qualificationDockerExperimental: string;
    missingScript: (name: string) => string;
    missingBin: string;
    checkPassed: (name: string, durationMs: number) => string;
    checkFailed: (name: string, exitCode: number) => string;
    reportWritten: (path: string) => string;
    candidateReady: (branch: string) => string;
    promoted: (branch: string) => string;
    cleanupDone: (path: string) => string;
    promotionBlocked: string;
    hostHeadChanged: string;
    candidateDirty: (files: string) => string;
    candidateStatusUnknown: string;
    candidateMoved: (expected: string, actual: string) => string;
    candidateNotBasedOnBase: (candidate: string, base: string) => string;
    promotionVerificationFailed: (expected: string, actual: string) => string;
    reportTitle: string;
    reportNone: string;
    reportNextQualified: (repository: string, candidateCommit: string) => string;
    reportNextPromoted: string;
    reportNextFailed: string;
    reportLabels: {
      status: string;
      repository: string;
      baseCommit: string;
      candidateCommit: string;
      branch: string;
      worktree: string;
      createdAt: string;
      checks: string;
      changedFiles: string;
      nextStep: string;
    };
  };

  // ───────── compile (xcompiler build) ─────────
  compile: {
    workspaceReady: (path: string) => string;
    forceOverride: string;
    topicInputConflict: string;
    auditTopicInput: string;
    auditOriginalRequirement: string;
    auditUserAddenda: string;
    auditEditedTopic: string;
    auditTopicPersisted: (path: string) => string;
    auditDecomposeFailed: string;
    lintIssue: (stepId: string, message: string) => string;
    planPreviewTruncated: string;
    auditPlanPersisted: (path: string) => string;
    projectFileWritten: (path: string) => string;
    nextCommand: (command: string) => string;
    topicEmptyExit: string;
    topicLoaded: (path: string) => string;
    requirementEmptyExit: string;
    requirementInputHint: string;
    spinClarify: string;
    clarifySucceed: (n: number) => string;
    clarifyFail: string;
    clarifyChoiceHint: (range: string) => string;
    addendaConfirm: string;
    addendaEditorMsg: string;
    auditClarifyAnswer: (qid: string, q: string) => string;
    spinDecompose: string;
    decomposeFail: string;
    plannerInvalidPlan: string;
    plannerInvalidPlanHint1: string;
    plannerInvalidPlanHint2: string;
    plannerTransportFailureHint1: string;
    plannerTransportFailureHint2: string;
    decomposeSucceed: (n: number) => string;
    schemaFail: string;
    schemaInvalidSavedAt: (path: string) => string;
    lintFail: (n: number) => string;
    topicPreviewHeader: string;
    topicPreviewFooter: string;
    gate1Confirm: string;
    gate1ChoiceConfirm: string;
    gate1ChoiceEdit: string;
    gate1ChoiceCancel: string;
    gate1AuditLabel: string;
    gate1Cancelled: string;
    editTopicMsg: string;
    topicWritten: (path: string) => string;
    planWritten: (path: string) => string;
    phasePlanWritten: (path: string) => string;
    planPreviewHeader: string;
    planPreviewFooter: string;
    gate2Confirm: string;
    gate2AuditLabel: string;
    gate2Rejected: string;
    baselineLoaded: (kind: string, sources: string) => string;
    baselineMissing: (workspace: string) => string;
    baselineLanguageOverride: (baseline: string, source: string, configured: string) => string;
    topicTitle: string;
    topicPreamble: string;
    topicSecRequirement: string;
    topicSecClarify: string;
    topicSecAddenda: string;
    topicSecBaseline: string;
  };

  // ───────── inspect (xcompiler ls / show) ─────────
  inspect: {
    noPlanFound: string;
    digestLabel: string;
    stepNotFound: (id: string) => string;
    secDescription: string;
    secAcceptance: string;
    secSubtasks: string;
    secSystemPrompt: string;
    secOutputs: string;
    secRecentAudit: (n: number) => string;
    planHeader: (path: string, language: string) => string;
    planStatusSummary: (total: number, done: number, ready: number, blocked: number, running: number) => string;
    planReadFailed: (path: string, message: string) => string;
    stepHeader: (id: string, phase: string, title: string, state: string, attempts: number, maxAttempts: number) => string;
    stepRoleTools: (role: string, tools: string) => string;
    stepDependsOn: (ids: string) => string;
    outputStatus: (exists: boolean, path: string) => string;
    auditEntry: (ts: string, kind: string, message: string) => string;
  };

  // ───────── execute (xcompiler run) ─────────
  execute: {
    forceLockOverride: string;
    manifestRecalibrated: (path: string) => string;
    manifestSeeded: (path: string) => string;
    auditPlanLoaded: (path: string) => string;
    planLoaded: (path: string) => string;
    planSummary: (language: string, steps: number) => string;
    preflightModelMissing: (names: string) => string;
    preflightAutoAdded: (n: number) => string;
    runInterrupted: (failedStepId: string, executed: number, total: number) => string;
    runReasonLabel: string;
    runFailureLogHeader: string;
    runAllDone: (executed: number, total: number) => string;
    projectAuditSummary: (errors: number, warnings: number) => string;
    projectMemoryRefreshFailed: (message: string) => string;
    projectAuditCheck: (name: string, summary: string) => string;
    auditDocPresent: (path: string) => string;
    auditDocMissing: (path: string) => string;
    auditDeliveryDocPresent: string;
    auditDeliveryDocMissing: string;
    auditTestFilesFound: (count: number) => string;
    auditTestFilesMissing: string;
    auditEntrypointOk: (command: string) => string;
    auditEntrypointFailed: (command: string) => string;
    auditPackageJsonMissing: string;
    auditScriptMissing: (name: string) => string;
    auditCommandOk: (name: string) => string;
    auditCommandFailed: (name: string, exitCode: number, timedOut: boolean) => string;
  };

  // ───────── engine ─────────
  engine: {
    cachedTestGateStart: (id: string, testArgs: string[]) => string;
    cachedTestGatePassed: (id: string) => string;
    cachedTestGateFailed: (id: string, exitCode: number, timedOut: boolean) => string;
    cachedTestArtifactsIncomplete: (id: string, missing: string[]) => string;
    missingPythonEntrypoint: string;
    missingTypeScriptEntrypoint: string;
    invalidPythonEntrypointSource: (path: string) => string;
    entrypointHelpOutputMissing: (command: string) => string;
  };

  // ───────── render (plan.md / topic.md headers) ─────────
  render: {
    sectionGlobalPrompt: string;
    sectionDependencies: (manifestFile: string) => string;
    sectionBaselineSummary: string;
    labelSystemPrompt: string;
  };

  // ───────── Agent system prompts (large blocks) ─────────
  prompts: {
    plannerSystem: (profile: LanguageProfile) => string;
    plannerPhasePlanSystem: (profile: LanguageProfile) => string;
    plannerPhaseDecomposeSystem: (profile: LanguageProfile) => string;
    plannerClarify: (
      rawRequirement: string,
      opts?: {
        intent?: 'greenfield' | 'feature' | 'refactor' | 'self';
        hasBaseline?: boolean;
        complex?: boolean;
        projectShapeAmbiguous?: boolean;
        languageAmbiguous?: boolean;
      },
    ) => string;
    plannerDecompose: (
      rawRequirement: string,
      qa: string,
      addenda: string,
      opts?: { intent?: 'greenfield' | 'feature' | 'refactor' | 'self'; baseline?: string },
    ) => string;
    plannerPhasePlan: (
      rawRequirement: string,
      qa: string,
      addenda: string,
      opts?: { intent?: 'greenfield' | 'feature' | 'refactor' | 'self'; baseline?: string },
    ) => string;
    plannerPhaseDecompose: (
      rawRequirement: string,
      qa: string,
      addenda: string,
      opts: {
        intent?: 'greenfield' | 'feature' | 'refactor' | 'self';
        baseline?: string;
        phasePlan: string;
        phaseId: string;
      },
    ) => string;
    plannerClarifySystem: string;
    plannerSelfMode: string;
    executorSystem: (profile: LanguageProfile) => string;
    executorDebugBlock: (reason: string, suggestions?: string) => string;
    executorGlobalBlock: (globalPrompt: string) => string;
    executorContextBlock: (context: string) => string;
    executorRoleBlock: (identity: {
      rolePrompt: string;
      capabilityPrompt: string;
      prohibitions: readonly string[];
    }) => string;
    executorStepBlock: (stepSystemPrompt: string) => string;
    executorSkillBlock: (hints: string[]) => string;
    executorUserPromptOutro: string;
    executorFeedbackHeader: string;
    executorFeedbackVerifyOk: string;
    executorFeedbackVerifyMissing: (paths: string) => string;
    executorFeedbackReadOnlyLoopWarning: (rounds: number, targets: string) => string;
    executorFeedbackReadOnlyRecoveryRequired: string;
    executorFeedbackDiagnosticProbeAllowance: (
      remainingRounds: number,
      maxActionsPerRound: number,
    ) => string;
    executorFeedbackRepairEvidenceMissing: string;
    executorFeedbackBugResolutionPlanMissing: string;
    executorFeedbackPostMutationVerificationRequired: string;
  };

  // ───────── Skill prompts ─────────
  skills: SkillPrompt;

  // ───────── doctor (xcompiler doctor / startup env-check) ─────────
  doctor: {
    cliDescription: string;
    optStrict: string;
    header: string;
    sectionConfig: string;
    sectionLLM: string;
    sectionSandbox: string;
    sectionSkills: string;
    summaryOk: string;
    summaryWarn: (n: number) => string;
    summaryFail: (n: number) => string;
    configLoadOk: (path: string) => string;
    configLoadFail: (msg: string) => string;
    configLocale: (locale: string) => string;
    llmNoProviders: string;
    llmProviderListed: (n: number) => string;
    ollamaUnreachable: (baseUrl: string, msg: string) => string;
    ollamaReachable: (baseUrl: string, n: number) => string;
    ollamaModelMissing: (provider: string, model: string, baseUrl: string) => string;
    ollamaModelOk: (provider: string, model: string) => string;
    openaiKeyMissing: (provider: string) => string;
    openaiReachable: (provider: string, baseUrl: string) => string;
    openaiUnreachable: (provider: string, baseUrl: string, msg: string) => string;
    openaiModelListUnavailable: (provider: string, status: number) => string;
    openaiModelListMissing: (provider: string, model: string) => string;
    providerScoreZero: (provider: string) => string;
    roleNoLiveProvider: (role: string) => string;
    roleOk: (role: string, provider: string) => string;
    sandboxKind: (kind: string) => string;
    sandboxNetworkPolicy: (policy: string, ports: number[]) => string;
    sandboxFullNoPorts: string;
    sandboxNodeMissing: (detail: string) => string;
    sandboxNodeOk: (version: string) => string;
    sandboxNpmMissing: (detail: string) => string;
    sandboxNpmOk: (version: string) => string;
    sandboxNpxMissing: (detail: string) => string;
    sandboxNpxOk: (version: string) => string;
    sandboxPythonMissing: (detail: string) => string;
    sandboxPythonOk: (version: string) => string;
    sandboxVenvMissing: (detail: string) => string;
    sandboxVenvOk: string;
    sandboxDockerMissing: (bin: string) => string;
    sandboxDockerOk: (version: string) => string;
    sandboxDockerDaemonDown: (msg: string) => string;
    sandboxInContainerWarn: string;
    skillToolMissing: (skill: string, tool: string) => string;
    skillOk: (n: number, tools: number) => string;
  };
}
