import path from 'node:path';
import { loadXCompilerProject } from '../core/project_file.js';
import { DEFAULT_PHASE_PLAN_FILE } from '../core/phase_plan.js';
import { runCompile, type CompileOptions } from './build.js';
import { runExecute, type ExecuteOptions, type ExecuteResult } from './run.js';
import {
  resolveCompileWorkspace,
  resolveEvolveWorkspace,
  type WorkspaceOptions,
} from './workspace.js';

export type RuntimeBuildCommandOptions = Omit<CompileOptions, 'workspace'> & WorkspaceOptions;

export interface RuntimeBuildCommandResult {
  workspace: string;
  planPath?: string;
}

export async function runBuildCommand(opts: RuntimeBuildCommandOptions): Promise<RuntimeBuildCommandResult> {
  const workspace = await resolveCompileWorkspace(opts);
  const result = await runCompile({
    ...opts,
    workspace,
    projectCommand: opts.projectCommand ?? 'build',
  });
  return { workspace, planPath: result.planPath };
}

export type RuntimeEvolveCommandOptions =
  Omit<CompileOptions, 'workspace' | 'outputFile' | 'projectCommand'> &
  WorkspaceOptions & {
    planOut?: string;
    cwd?: string;
    debugWikiPath?: string;
  };

export interface RuntimeEvolveCommandResult {
  workspace: string;
  planPath?: string;
  execution?: ExecuteResult;
}

export async function runEvolveCommand(opts: RuntimeEvolveCommandOptions): Promise<RuntimeEvolveCommandResult> {
  const workspace = await resolveEvolveWorkspace(opts, opts.cwd);
  const resolvedPlanPath = opts.planOut ? path.resolve(opts.planOut) : path.join(workspace, DEFAULT_PHASE_PLAN_FILE);
  const compiled = await runCompile({
    ...opts,
    workspace,
    outputFile: resolvedPlanPath,
    projectCommand: 'evolve',
  });
  if (!compiled.planPath) return { workspace };
  const execution = await runExecute({
    planPath: compiled.planPath,
    workspace,
    configPath: opts.configPath,
    force: !!opts.force,
    projectFilePath: opts.projectFilePath,
    projectCommand: 'evolve',
    recordProjectHistory: false,
    debugWikiPath: opts.debugWikiPath,
    io: opts.io,
    plugins: opts.plugins,
    pluginStrict: opts.pluginStrict,
  });
  return { workspace, planPath: compiled.planPath, execution };
}

export type RuntimeRunCommandOptions =
  Omit<ExecuteOptions, 'planPath' | 'workspace' | 'projectCommand'> & {
    planArg?: string;
    output?: string;
    workspace?: string;
    cwd?: string;
  };

export async function runRunCommand(opts: RuntimeRunCommandOptions): Promise<ExecuteResult> {
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.output ?? opts.workspace;
  const workspace = explicit
    ? path.resolve(explicit)
    : opts.planArg
      ? path.dirname(path.resolve(opts.planArg))
      : cwd;
  const planPath = opts.planArg ? path.resolve(opts.planArg) : await defaultRunnablePlanPath(workspace);
  return runExecute({
    ...opts,
    workspace,
    planPath,
    projectCommand: 'run',
  });
}

export type RuntimeLoadCommandOptions =
  Omit<ExecuteOptions, 'planPath' | 'workspace' | 'projectFilePath' | 'projectCommand'> & {
    projectFile: string;
  };

export async function runLoadCommand(opts: RuntimeLoadCommandOptions): Promise<ExecuteResult> {
  const project = await loadXCompilerProject(opts.projectFile);
  return runExecute({
    ...opts,
    planPath: project.planPath,
    workspace: project.workspace,
    configPath: opts.configPath ? path.resolve(opts.configPath) : project.configPath,
    projectFilePath: project.filePath,
    projectCommand: 'load',
  });
}

export type RuntimeAppendCommandOptions =
  Omit<CompileOptions, 'workspace' | 'baselinePlanFile' | 'outputFile' | 'projectFilePath' | 'projectCommand'> & {
    projectFile: string;
    planOut?: string;
    debugWikiPath?: string;
  };

export interface RuntimeAppendCommandResult {
  workspace: string;
  planPath?: string;
  execution?: ExecuteResult;
}

export async function runAppendCommand(opts: RuntimeAppendCommandOptions): Promise<RuntimeAppendCommandResult> {
  const project = await loadXCompilerProject(opts.projectFile);
  const configPath = opts.configPath ? path.resolve(opts.configPath) : project.configPath;
  const planPath = opts.planOut ? path.resolve(opts.planOut) : project.planPath;
  const compiled = await runCompile({
    ...opts,
    workspace: project.workspace,
    configPath,
    baselinePlanFile: project.planPath,
    outputFile: planPath,
    projectFilePath: project.filePath,
    projectCommand: 'append',
  });
  if (!compiled.planPath) return { workspace: project.workspace };
  const execution = await runExecute({
    planPath: compiled.planPath,
    workspace: project.workspace,
    configPath,
    force: !!opts.force,
    projectFilePath: project.filePath,
    projectCommand: 'append',
    recordProjectHistory: false,
    debugWikiPath: opts.debugWikiPath,
    io: opts.io,
    plugins: opts.plugins,
    pluginStrict: opts.pluginStrict,
  });
  return { workspace: project.workspace, planPath: compiled.planPath, execution };
}

async function defaultRunnablePlanPath(workspace: string): Promise<string> {
  return path.join(workspace, DEFAULT_PHASE_PLAN_FILE);
}
