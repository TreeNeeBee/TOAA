import { promises as fs, constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  LANGUAGES,
  PHASES,
  PLAN_INTENTS,
  STEP_STATUSES,
  type Phase,
  type Plan,
  type PlanIntent,
  type StepStatus,
} from './plan.js';
import { loadPlanTarget } from './storage.js';

export const XCOMPILER_PROJECT_KIND = 'xcompiler.project';
export const XCOMPILER_PROJECT_VERSION = '1';
export const XCOMPILER_PROJECT_FILE_EXTENSION = '.xc';

const StepProgressSchema = z.object({
  id: z.string(),
  iterationId: z.string().default('P1'),
  phase: z.enum(PHASES),
  title: z.string(),
  status: z.enum(STEP_STATUSES),
  retries: z.number().int().nonnegative(),
  maxRetries: z.number().int().positive(),
});

const ProjectProgressSchema = z.object({
  status: z.enum(['planned', 'running', 'failed', 'complete', 'partial']),
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
  currentStepId: z.string().optional(),
  failedStepId: z.string().optional(),
  steps: z.array(StepProgressSchema),
});

const ProjectHistoryEntrySchema = z.object({
  at: z.string(),
  command: z.string(),
  intent: z.enum(PLAN_INTENTS).optional(),
  planPath: z.string(),
  requirementFile: z.string().optional(),
  topicFile: z.string().optional(),
  status: z.string().optional(),
});

export const XCompilerProjectFileSchema = z.object({
  kind: z.literal(XCOMPILER_PROJECT_KIND),
  version: z.literal(XCOMPILER_PROJECT_VERSION),
  name: z.string().min(1),
  workspace: z.string().min(1),
  planPath: z.string().min(1),
  configPath: z.string().nullable().optional(),
  language: z.enum(LANGUAGES).optional(),
  intent: z.enum(PLAN_INTENTS).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastCommand: z.string().optional(),
  progress: ProjectProgressSchema.optional(),
  history: z.array(ProjectHistoryEntrySchema).default([]),
});

export type XCompilerProjectFile = z.infer<typeof XCompilerProjectFileSchema>;
export type XCompilerProjectProgress = z.infer<typeof ProjectProgressSchema>;

export interface UpdateProjectFileOptions {
  workspace: string;
  planPath: string;
  configPath?: string;
  projectFilePath?: string;
  command?: string;
  intent?: PlanIntent;
  plan?: Plan;
  requirementFile?: string;
  topicFile?: string;
  recordHistory?: boolean;
}

export interface LoadedXCompilerProject {
  filePath: string;
  data: XCompilerProjectFile;
  workspace: string;
  planPath: string;
  configPath?: string;
}

export function defaultProjectFilePath(workspace: string, name?: string): string {
  const ws = path.resolve(workspace);
  const rawName = name?.trim() || path.basename(ws) || 'project';
  return path.join(ws, `${sanitizeProjectName(rawName)}${XCOMPILER_PROJECT_FILE_EXTENSION}`);
}

export async function findProjectFile(workspace: string): Promise<string | undefined> {
  const ws = path.resolve(workspace);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(ws, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(XCOMPILER_PROJECT_FILE_EXTENSION))
    .map((entry) => path.join(ws, entry.name))
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return undefined;
  const preferred = defaultProjectFilePath(ws);
  return files.find((file) => path.resolve(file) === preferred) ?? files[0];
}

export async function loadXCompilerProject(projectFilePath: string): Promise<LoadedXCompilerProject> {
  const filePath = path.resolve(projectFilePath);
  assertProjectFileExtension(filePath);
  const raw = await fs.readFile(filePath, 'utf8');
  const data = XCompilerProjectFileSchema.parse(JSON.parse(raw));
  const base = path.dirname(filePath);
  const workspace = path.resolve(base, data.workspace);
  await assertSafeProjectWorkspace(filePath, workspace);
  const planPath = path.resolve(base, data.planPath);
  const configPath = data.configPath ? path.resolve(base, data.configPath) : undefined;
  return { filePath, data, workspace, planPath, configPath };
}

/**
 * 校验 .xc 里记录的（绝对）workspace 路径，防止两类风险：
 * 1. 写入泄漏：项目目录被移动/复制后，.xc 中陈旧的绝对路径仍指向旧位置，
 *    继续执行会把生成物写进无关目录。要求 .xc 文件自身必须位于其声明的 workspace 内。
 * 2. 权限错配：workspace 存在但当前用户不可写（例如 root/容器里创建后回到普通用户）。
 */
async function assertSafeProjectWorkspace(projectFilePath: string, workspace: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(workspace);
  } catch {
    throw new Error(
      `XCompiler project workspace does not exist: ${workspace}\n` +
        `The workspace path stored in ${projectFilePath} is stale (project moved or renamed?). ` +
        `Update the "workspace" field to the project's current absolute path, or delete the .xc file and rerun xcompiler build.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`XCompiler project workspace is not a directory: ${workspace}`);
  }
  const realWorkspace = await fs.realpath(workspace).catch(() => workspace);
  const realProjectDir = await fs.realpath(path.dirname(projectFilePath)).catch(() => path.dirname(projectFilePath));
  if (realProjectDir !== realWorkspace && !realProjectDir.startsWith(realWorkspace + path.sep)) {
    throw new Error(
      `XCompiler project file ${projectFilePath} is not inside its declared workspace ${workspace}.\n` +
        `Refusing to run: executing against a workspace that does not contain the project file would leak writes ` +
        `into an unrelated directory (stale absolute path after moving/copying the project?). ` +
        `Fix the "workspace" field or delete the .xc file and rerun xcompiler build.`,
    );
  }
  try {
    await fs.access(workspace, fsConstants.W_OK);
  } catch {
    throw new Error(
      `XCompiler project workspace is not writable by the current user: ${workspace}\n` +
        `Permission mismatch (workspace created by another user / root / container?). ` +
        `Fix ownership or permissions before running XCompiler.`,
    );
  }
}

export async function updateProjectFile(opts: UpdateProjectFileOptions): Promise<string> {
  const workspace = path.resolve(opts.workspace);
  const projectFilePath =
    opts.projectFilePath ??
    (await findProjectFile(workspace)) ??
    defaultProjectFilePath(workspace);
  const filePath = path.resolve(projectFilePath);
  assertProjectFileExtension(filePath);
  const base = path.dirname(filePath);
  const planPath = path.resolve(opts.planPath);
  const now = new Date().toISOString();
  const existing = await readExistingProjectFile(filePath);
  const plan = opts.plan ?? (await tryLoadPlan(planPath));
  const progress = plan ? buildProjectProgress(plan) : existing?.progress;
  const history = existing?.history ?? [];
  const shouldRecord = opts.recordHistory ?? false;
  const nextHistory = shouldRecord
    ? [
        ...history,
        {
          at: now,
          command: opts.command ?? existing?.lastCommand ?? 'update',
          intent: opts.intent ?? plan?.intent ?? existing?.intent,
          planPath: relativeFrom(base, planPath),
          requirementFile: opts.requirementFile ? relativeFrom(base, path.resolve(opts.requirementFile)) : undefined,
          topicFile: opts.topicFile ? relativeFrom(base, path.resolve(opts.topicFile)) : undefined,
          status: progress?.status,
        },
      ].slice(-40)
    : history;

  const data: XCompilerProjectFile = {
    kind: XCOMPILER_PROJECT_KIND,
    version: XCOMPILER_PROJECT_VERSION,
    name: existing?.name ?? sanitizeProjectName(path.basename(workspace) || 'project'),
    // workspace 始终写绝对路径；加载时由 assertSafeProjectWorkspace 校验陈旧路径/权限。
    workspace,
    planPath: relativeFrom(base, planPath),
    configPath:
      opts.configPath !== undefined
        ? relativeFrom(base, path.resolve(opts.configPath))
        : existing?.configPath ?? null,
    language: plan?.language ?? existing?.language,
    intent: opts.intent ?? plan?.intent ?? existing?.intent,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastCommand: opts.command ?? existing?.lastCommand,
    progress,
    history: nextHistory,
  };

  XCompilerProjectFileSchema.parse(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return filePath;
}

export function buildProjectProgress(plan: Plan): XCompilerProjectProgress {
  const counts: Record<StepStatus, number> = {
    PENDING: 0,
    RUNNING: 0,
    DONE: 0,
    FAILED: 0,
  };
  const steps = plan.steps.map((step) => {
    counts[step.status]++;
    return {
      id: step.id,
      iterationId: step.iterationId ?? 'P1',
      phase: step.phase as Phase,
      title: step.title,
      status: step.status,
      retries: step.retries,
      maxRetries: step.maxRetries,
    };
  });
  const total = plan.steps.length;
  const currentStep =
    steps.find((step) => step.status === 'RUNNING') ??
    steps.find((step) => step.status === 'FAILED') ??
    steps.find((step) => step.status === 'PENDING');
  const failedStep = steps.find((step) => step.status === 'FAILED');
  const status =
    counts.FAILED > 0
      ? 'failed'
      : counts.RUNNING > 0
        ? 'running'
        : total > 0 && counts.DONE === total
          ? 'complete'
          : counts.DONE > 0
            ? 'partial'
            : 'planned';
  return {
    status,
    total,
    done: counts.DONE,
    pending: counts.PENDING,
    running: counts.RUNNING,
    failed: counts.FAILED,
    percent: total === 0 ? 0 : Math.round((counts.DONE / total) * 100),
    currentStepId: currentStep?.id,
    failedStepId: failedStep?.id,
    steps,
  };
}

async function readExistingProjectFile(filePath: string): Promise<XCompilerProjectFile | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return XCompilerProjectFileSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function tryLoadPlan(planPath: string): Promise<Plan | undefined> {
  try {
    return (await loadPlanTarget(planPath)).plan;
  } catch {
    return undefined;
  }
}

function relativeFrom(base: string, target: string): string {
  const rel = path.relative(base, target).replace(/\\/g, '/');
  if (!rel) return '.';
  return rel.startsWith('..') ? target : rel;
}

function sanitizeProjectName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return cleaned || 'project';
}

function assertProjectFileExtension(filePath: string): void {
  if (!filePath.endsWith(XCOMPILER_PROJECT_FILE_EXTENSION)) {
    throw new Error(`XCompiler project files must use the ${XCOMPILER_PROJECT_FILE_EXTENSION} suffix: ${filePath}`);
  }
}
