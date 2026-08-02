/** 无 Commander 副作用的程序化运行入口，供宿主应用和插件加载器使用。 */
export { XCOMPILER_VERSION, XCOMPILER_PLUGIN_API_VERSION } from './version.js';
export { runCompile, CompileExitError, type CompileOptions } from './runtime/build.js';
export { runExecute, type ExecuteOptions, type ExecuteResult } from './runtime/run.js';
export {
  runAppendCommand,
  runBuildCommand,
  runEvolveCommand,
  runLoadCommand,
  runRunCommand,
  type RuntimeAppendCommandOptions,
  type RuntimeAppendCommandResult,
  type RuntimeBuildCommandOptions,
  type RuntimeBuildCommandResult,
  type RuntimeEvolveCommandOptions,
  type RuntimeEvolveCommandResult,
  type RuntimeLoadCommandOptions,
  type RuntimeRunCommandOptions,
} from './runtime/commands.js';
export {
  silentRuntimeIO,
  type RuntimeEvent,
  type RuntimeIO,
  type RuntimeInteraction,
  type RuntimeLogEvent,
  type RuntimeLogLevel,
  type RuntimeFileChangedEvent,
  type RuntimePatchProposedEvent,
  type RuntimePermissionEvent,
  type RuntimeProgress,
  type RuntimeProgressEvent,
  type RuntimeResultEvent,
  type RuntimeSelectChoice,
  type RuntimeToolCallEvent,
  type RuntimeWorkflowEvent,
} from './runtime/io.js';
export type {
  ToolExecutionEvent,
  ToolExecutionReporter,
  ToolPermissionDecision,
  ToolPermissionOperation,
  ToolPermissionRequest,
  ToolPermissionRequester,
} from './tools/types.js';
export {
  TICKET_TYPES,
  TICKET_STATES,
  TICKET_PRIORITY,
  TICKET_PRIORITY_MIN,
  TICKET_PRIORITY_MAX,
  TicketSchema,
  BugTicketSchema,
  ChangeRequestTicketSchema,
  EnhancementTicketSchema,
  transitionTicket,
  isActiveTicket,
  type BugTicket,
  type ChangeRequestTicket,
  type EnhancementTicket,
  type Ticket,
  type TicketState,
  type TicketSolution,
  type TicketType,
  type WorkTicket,
} from './domain/tickets/ticket.js';
export {
  ProjectSchema,
  PhaseSchema,
  StepSchema,
  ProjectPlanSchema,
  PhasePlanSchema,
  QualityAssessmentSchema,
  type Project,
  type Phase as DomainPhase,
  type Step as DomainStep,
  type ProjectPlan,
  type PhasePlan as DomainPhasePlan,
  type QualityAssessment,
} from './domain/index.js';
export {
  defaultProjectName,
  resolveCompileWorkspace,
  resolveEvolveWorkspace,
  type WorkspaceOptions,
} from './runtime/workspace.js';
export {
  runBootstrap,
  type BootstrapOptions,
  type BootstrapResult,
} from './runtime/bootstrap.js';
export {
  runDoctor,
  runDoctorCommand,
  type CheckLevel,
  type DoctorOptions,
  type DoctorReport,
  type RuntimeDoctorOptions,
  type RuntimeDoctorResult,
} from './runtime/doctor.js';
export {
  findPlans,
  readAuditFor,
  runLsCommand,
  runShowCommand,
  summarizeProject,
  type AuditLine,
  type InspectStep,
  type LsOptions,
  type LsPlanEntry,
  type LsResult,
  type PlanSummary,
  type ShowOptions,
  type ShowOutputStatus,
  type ShowResult,
} from './runtime/inspect.js';
export { PluginHost } from './plugins/host.js';
export { checkPluginCompatibility } from './plugins/compatibility.js';
export type {
  PluginCompatibilityReport,
  PluginHostOptions,
  XCompilerPlugin,
  XCompilerPluginManifest,
} from './plugins/types.js';
import { runCompile, type CompileOptions } from './runtime/build.js';
import { runExecute, type ExecuteOptions } from './runtime/run.js';
import { runBootstrap, type BootstrapOptions } from './runtime/bootstrap.js';
import { runDoctorCommand, type RuntimeDoctorOptions } from './runtime/doctor.js';
import {
  runLsCommand,
  runShowCommand,
  type LsOptions,
  type ShowOptions,
} from './runtime/inspect.js';
import type { RuntimeIO } from './runtime/io.js';
import {
  runAppendCommand,
  runBuildCommand,
  runEvolveCommand,
  runLoadCommand,
  runRunCommand,
  type RuntimeAppendCommandOptions,
  type RuntimeBuildCommandOptions,
  type RuntimeEvolveCommandOptions,
  type RuntimeLoadCommandOptions,
  type RuntimeRunCommandOptions,
} from './runtime/commands.js';

export interface XCompilerRuntimeOptions {
  io?: RuntimeIO;
}

export class XCompilerRuntime {
  constructor(private readonly defaults: XCompilerRuntimeOptions = {}) {}

  build(opts: CompileOptions): ReturnType<typeof runCompile> {
    return runCompile(this.withDefaults(opts));
  }

  run(opts: ExecuteOptions): ReturnType<typeof runExecute> {
    return runExecute(this.withDefaults(opts));
  }

  buildCommand(opts: RuntimeBuildCommandOptions): ReturnType<typeof runBuildCommand> {
    return runBuildCommand(this.withDefaults(opts));
  }

  evolveCommand(opts: RuntimeEvolveCommandOptions): ReturnType<typeof runEvolveCommand> {
    return runEvolveCommand(this.withDefaults(opts));
  }

  runCommand(opts: RuntimeRunCommandOptions): ReturnType<typeof runRunCommand> {
    return runRunCommand(this.withDefaults(opts));
  }

  loadCommand(opts: RuntimeLoadCommandOptions): ReturnType<typeof runLoadCommand> {
    return runLoadCommand(this.withDefaults(opts));
  }

  appendCommand(opts: RuntimeAppendCommandOptions): ReturnType<typeof runAppendCommand> {
    return runAppendCommand(this.withDefaults(opts));
  }

  bootstrap(opts: BootstrapOptions): ReturnType<typeof runBootstrap> {
    return runBootstrap(this.withDefaults(opts));
  }

  doctor(opts: RuntimeDoctorOptions = {}): ReturnType<typeof runDoctorCommand> {
    return runDoctorCommand(opts);
  }

  ls(opts: LsOptions): ReturnType<typeof runLsCommand> {
    return runLsCommand(opts);
  }

  show(opts: ShowOptions): ReturnType<typeof runShowCommand> {
    return runShowCommand(opts);
  }

  private withDefaults<T extends { io?: RuntimeIO }>(opts: T): T {
    if (opts.io || !this.defaults.io) return opts;
    return { ...opts, io: this.defaults.io };
  }
}
