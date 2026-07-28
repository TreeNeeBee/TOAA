import type { AuditLogger } from '../../audit/audit.js';
import { StepExecutor } from '../../agents/executor.js';
import {
  designPhaseDebugAdvisoryFailureRules,
} from './attempt_policy.js';
import {
  buildContextSnippets,
  computeDebugAllowedWrites,
  computeStepAllowedWrites,
  stepContextChars,
  type ContextDebugInput,
} from './context.js';
import { isDesignSourcePhase, normalizeGitPath } from './v_model_policy.js';
import type { LLMRouter } from '../../llm/router.js';
import { resolveSkillOperationWindow } from '../../llm/window.js';
import { PluginHost } from '../../plugins/host.js';
import type { Sandbox } from '../../sandbox/types.js';
import { SkillRegistry } from '../../skills/skill.js';
import {
  EditGuard,
  resolveWriteChunkBytes,
  type Tool,
  type ToolContext,
  type ToolExecutionReporter,
  type ToolPermissionRequester,
  type ToolRegistry,
  type WriteChunkBytes,
} from '../../tools/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import { ensureEssentialToolRefs } from '../../agents/calibration.js';
import {
  V_MODEL_TEST_PHASES,
  type Plan,
  type Step,
} from '../plan.js';
import type { ProjectMemory } from '../project_memory.js';
import { pairedTestAssetPaths } from '../test_assets.js';
import type { ChangeRequestTicket, TicketStore } from '../ticket.js';
import type { LanguageProfile } from '../language.js';

export interface AttemptEnvironmentDebug extends ContextDebugInput {
  extraAllowedWrites?: string[];
  testScopeArgs?: string[];
}

export interface AttemptEnvironment {
  executor: StepExecutor;
  tools: Tool[];
  context: ToolContext;
  contextSnippets: Array<{ path: string; content: string }>;
  skillHints: string[];
  toolNames: string[];
}

export async function buildAttemptEnvironment(input: {
  workspace: Workspace;
  sandbox: Sandbox;
  audit: AuditLogger;
  router: LLMRouter;
  registry: ToolRegistry;
  skills: SkillRegistry;
  plugins: PluginHost;
  tickets: TicketStore;
  projectMemory: ProjectMemory | null;
  profile: LanguageProfile;
  plan: Plan;
  step: Step;
  role: Step['role'];
  debug?: AttemptEnvironmentDebug;
  changeRequest?: ChangeRequestTicket;
  terminalOutput: boolean;
  maxRoundsPerStep?: number;
  maxDebugRoundsPerStep?: number;
  maxEditLinesPerStep?: number | 'auto';
  maxWriteChunkBytes?: WriteChunkBytes;
  requestPermission?: ToolPermissionRequester;
  onToolEvent?: ToolExecutionReporter;
}): Promise<AttemptEnvironment> {
  const effectiveToolRefs = ensureEssentialToolRefs(input.step);
  const { resolvedToolNames, hints } = input.skills.resolve(effectiveToolRefs);
  let extraNames: string[] = [];
  if (input.debug) {
    const debuggerSkill = input.skills.get('debugger');
    if (debuggerSkill) {
      extraNames = debuggerSkill.tools;
      hints.push(`[debugger] ${debuggerSkill.prompt}`);
    }
  }
  const toolNames = dedup([...resolvedToolNames, ...extraNames]);
  const baseTools = input.registry.pick(toolNames);
  const allowedWrites = input.debug
    ? dedup([
        ...computeDebugAllowedWrites(input.plan, input.step, input.profile),
        ...(input.debug.extraAllowedWrites ?? []),
      ])
    : computeStepAllowedWrites(input.step);
  const augmentedWrites = input.debug && !isVModelTestPhase(input.step.phase)
    ? dedup([...allowedWrites, 'tests/fixtures'])
    : allowedWrites;

  const budgetContext = {
    phase: input.step.phase,
    role: input.role,
    debug: !!input.debug,
    tools: toolNames,
    outputs: input.step.outputs,
    allowedWrites: augmentedWrites,
    contextChars: stepContextChars(input.plan, input.step),
    contextWindowTokens: input.router.primaryContextWindow?.(input.role),
  };
  const guard = new EditGuard({
    ws: input.workspace,
    stepId: input.step.id,
    maxLines: input.maxEditLinesPerStep ?? 'auto',
    budgetContext,
  });
  const operationWindow = resolveSkillOperationWindow({
    contextWindowTokens: budgetContext.contextWindowTokens,
    promptChars: budgetContext.contextChars,
    configuredWriteChunkBytes: input.maxWriteChunkBytes ?? 'auto',
  });
  const writeChunkBytes = resolveWriteChunkBytes(
    input.maxWriteChunkBytes ?? 'auto',
    budgetContext,
  );
  const tools = baseTools.map((tool) => {
    const guarded = guard.wrap(tool);
    return input.plugins.size > 0 ? input.plugins.wrapTool(guarded) : guarded;
  });
  const context: ToolContext = {
    ws: input.workspace,
    sandbox: input.sandbox,
    audit: input.audit,
    allowedWrites: augmentedWrites,
    stepId: input.step.id,
    language: input.plan.language,
    contextWindowTokens: operationWindow.contextWindowTokens,
    responseTokenBudget: operationWindow.responseTokenBudget,
    feedbackCharBudget: operationWindow.feedbackCharBudget,
    readChunkBytes: operationWindow.readChunkBytes,
    writeChunkBytes,
    defaultTestArgs: input.debug?.testScopeArgs?.length
      ? input.debug.testScopeArgs
      : testGateArgs(input.plan, input.step),
    requestPermission: input.requestPermission,
    onToolEvent: input.onToolEvent,
  };

  const baseRounds = input.maxRoundsPerStep ?? 6;
  const debugRounds = input.maxDebugRoundsPerStep ?? Math.max(8, baseRounds);
  const rounds = input.debug ? debugRounds : baseRounds;
  const hasRunTests = toolNames.includes('run_tests');
  const advisoryFailureTools =
    input.debug && isDesignSourcePhase(input.step.phase) && hasRunTests
      ? ['run_tests']
      : undefined;
  const advisoryFailureRules = input.debug && isDesignSourcePhase(input.step.phase)
    ? designPhaseDebugAdvisoryFailureRules()
    : undefined;
  const maxFailedTestRuns =
    (isVModelTestPhase(input.step.phase) || (input.debug && !advisoryFailureTools)) &&
    hasRunTests
      ? Math.max(1, Math.min(3, Math.ceil(rounds / 3)))
      : undefined;
  const executor = new StepExecutor({
    llm: input.router.for(input.role),
    streamOutput: input.terminalOutput,
    maxRounds: rounds,
    maxFailedTestRuns,
    advisoryFailureTools,
    advisoryFailureRules,
    maxWriteChunkBytes: input.maxWriteChunkBytes ?? 'auto',
  });
  const contextSnippets = await buildContextSnippets({
    workspace: input.workspace,
    plan: input.plan,
    step: input.step,
    debug: input.debug,
    changeRequest: input.changeRequest,
    tickets: input.tickets,
    projectMemory: input.projectMemory,
    profile: input.profile,
    contextWindowTokens:
      input.router.primaryContextWindow?.(input.role) ?? 128 * 1024,
  });
  return {
    executor,
    tools,
    context,
    contextSnippets,
    skillHints: hints,
    toolNames,
  };
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
