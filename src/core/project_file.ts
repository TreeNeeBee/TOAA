import { promises as fs, constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ObjectIdSchema, type ObjectId } from '../domain/identity/object_id.js';
import type { Project } from '../domain/projects/project.js';
import type { Step, StepState } from '../domain/steps/step.js';
import { DomainObjectRepository } from '../infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../workspace/workspace.js';
import type { PlanIntent } from './plan.js';

export const XCOMPILER_PROJECT_FILE_EXTENSION = '.xc';
export const XCOMPILER_PROJECT_MANIFEST_KIND = 'xcompiler.project-manifest';
export const XCOMPILER_PROJECT_MANIFEST_VERSION = 2;

const ProjectProgressStepSchema = z.object({
  id: ObjectIdSchema,
  name: z.string().min(1),
  phaseId: ObjectIdSchema,
  type: z.string().min(1),
  title: z.string().min(1),
  state: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
}).strict();

const ProjectProgressSchema = z.object({
  status: z.enum(['planned', 'running', 'pending', 'failed', 'complete', 'partial']),
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
  currentStepId: ObjectIdSchema.optional(),
  failedStepId: ObjectIdSchema.optional(),
  steps: z.array(ProjectProgressStepSchema),
}).strict();

const ProjectHistoryEntrySchema = z.object({
  at: z.string().datetime({ offset: true }),
  command: z.string().min(1),
  intent: z.enum(['greenfield', 'feature', 'refactor', 'self']).optional(),
  planPath: z.string().min(1),
  requirementFile: z.string().min(1).optional(),
  topicFile: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
}).strict();

/**
 * `.xc` is a launcher manifest, not a second Project aggregate. The canonical
 * Project and all lifecycle state live under `.xcompiler/objects` and are
 * addressed through `projectId`.
 */
export const XCompilerProjectFileSchema = z.object({
  kind: z.literal(XCOMPILER_PROJECT_MANIFEST_KIND),
  version: z.literal(XCOMPILER_PROJECT_MANIFEST_VERSION),
  projectId: ObjectIdSchema,
  name: z.string().min(1),
  workspace: z.string().min(1),
  planPath: z.string().min(1),
  configPath: z.string().nullable().optional(),
  lastCommand: z.string().optional(),
  progress: ProjectProgressSchema.optional(),
  history: z.array(ProjectHistoryEntrySchema).default([]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type XCompilerProjectFile = z.infer<typeof XCompilerProjectFileSchema>;
export type XCompilerProjectProgress = z.infer<typeof ProjectProgressSchema>;

export interface UpdateProjectFileOptions {
  workspace: string;
  planPath: string;
  configPath?: string;
  projectFilePath?: string;
  projectId?: ObjectId;
  command?: string;
  intent?: PlanIntent;
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
  project: Project;
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
  const data = XCompilerProjectFileSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
  const base = path.dirname(filePath);
  const workspace = path.resolve(base, data.workspace);
  await assertSafeProjectWorkspace(filePath, workspace);
  const repository = new DomainObjectRepository(new Workspace(workspace));
  await repository.load();
  const object = await repository.read(data.projectId);
  if (object.objectType !== 'project') {
    throw new Error(`Project manifest ${filePath} points to non-Project object ${data.projectId}`);
  }
  if (object.name !== data.name) {
    throw new Error(`Project manifest name ${data.name} does not match Project ${object.name}`);
  }
  return {
    filePath,
    data,
    workspace,
    planPath: path.resolve(base, data.planPath),
    configPath: data.configPath ? path.resolve(base, data.configPath) : undefined,
    project: object,
  };
}

export async function updateProjectFile(opts: UpdateProjectFileOptions): Promise<string> {
  const workspace = path.resolve(opts.workspace);
  const filePath = path.resolve(
    opts.projectFilePath ?? (await findProjectFile(workspace)) ?? defaultProjectFilePath(workspace),
  );
  assertProjectFileExtension(filePath);
  const base = path.dirname(filePath);
  if (base !== workspace && !base.startsWith(workspace + path.sep)) {
    throw new Error(`XCompiler project file must be inside its workspace: ${filePath}`);
  }
  const existing = await readExistingProjectFile(filePath);
  const repository = new DomainObjectRepository(new Workspace(workspace));
  await repository.load();
  const project = opts.projectId
    ? await requireProject(repository, opts.projectId)
    : existing
      ? await requireProject(repository, existing.projectId)
      : await repository.findProject();
  if (!project) {
    throw new Error('Canonical Project is missing; run xcompiler build to rebuild this workspace.');
  }
  if (existing && existing.projectId !== project.id && !opts.projectId) {
    throw new Error(`Project manifest cannot switch from ${existing.projectId} to ${project.id}`);
  }
  const steps = (await repository.list({ objectType: 'step', projectId: project.id }))
    .filter((object): object is Step => object.objectType === 'step');
  const progress = buildProjectProgress(project, steps);
  const now = new Date().toISOString();
  const planPath = path.resolve(opts.planPath);
  const history = existing?.history ?? [];
  const nextHistory = opts.recordHistory
    ? [...history, {
        at: now,
        command: opts.command ?? existing?.lastCommand ?? 'update',
        intent: opts.intent ?? project.intent,
        planPath: relativeFrom(base, planPath),
        requirementFile: opts.requirementFile ? relativeFrom(base, path.resolve(opts.requirementFile)) : undefined,
        topicFile: opts.topicFile ? relativeFrom(base, path.resolve(opts.topicFile)) : undefined,
        status: progress.status,
      }].slice(-40)
    : history;
  const data = XCompilerProjectFileSchema.parse({
    kind: XCOMPILER_PROJECT_MANIFEST_KIND,
    version: XCOMPILER_PROJECT_MANIFEST_VERSION,
    projectId: project.id,
    name: project.name,
    workspace,
    planPath: relativeFrom(base, planPath),
    configPath: opts.configPath !== undefined
      ? relativeFrom(base, path.resolve(opts.configPath))
      : existing?.configPath ?? null,
    lastCommand: opts.command ?? existing?.lastCommand,
    progress,
    history: nextHistory,
    updatedAt: now,
  });
  await new Workspace(workspace).writeFileAtomic(
    relativeFrom(workspace, filePath),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  return filePath;
}

export function buildProjectProgress(
  project: Project,
  steps: readonly Step[],
): XCompilerProjectProgress {
  const counts: Record<StepState, number> = {
    created: 0,
    in_progress: 0,
    pending: 0,
    delivered: 0,
    reopened: 0,
    closed: 0,
  };
  for (const step of steps) counts[step.state] += 1;
  const ordered = [...steps].sort((left, right) => left.name.localeCompare(right.name));
  const current = ordered.find((step) => step.state === 'in_progress') ??
    ordered.find((step) => step.state === 'pending' || step.state === 'reopened' || step.state === 'created');
  const done = counts.delivered + counts.closed;
  const status = project.state === 'closed' || project.state === 'delivered'
    ? 'complete'
    : counts.pending > 0
      ? 'failed'
      : counts.in_progress > 0
        ? 'running'
        : done > 0
          ? 'partial'
          : 'planned';
  return {
    status,
    total: ordered.length,
    done,
    pending: counts.created + counts.pending + counts.reopened,
    running: counts.in_progress,
    failed: counts.pending,
    percent: ordered.length === 0 ? 0 : Math.round((done / ordered.length) * 100),
    currentStepId: current?.id,
    failedStepId: ordered.find((step) => step.state === 'pending')?.id,
    steps: ordered.map((step) => ({
      id: step.id,
      name: step.name,
      phaseId: step.phaseId,
      type: step.type,
      title: step.title,
      state: step.state,
      attempts: step.attempts,
      maxAttempts: step.maxAttempts,
    })),
  };
}

async function requireProject(repository: DomainObjectRepository, id: ObjectId): Promise<Project> {
  const object = await repository.read(id);
  if (object.objectType !== 'project') throw new Error(`Object ${id} is not a Project`);
  return object;
}

async function readExistingProjectFile(filePath: string): Promise<XCompilerProjectFile | undefined> {
  try {
    return XCompilerProjectFileSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafeProjectWorkspace(projectFilePath: string, workspace: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(workspace);
  } catch {
    throw new Error(`XCompiler project workspace does not exist: ${workspace}`);
  }
  if (!stat.isDirectory()) throw new Error(`XCompiler project workspace is not a directory: ${workspace}`);
  const realWorkspace = await fs.realpath(workspace).catch(() => workspace);
  const realProjectDir = await fs.realpath(path.dirname(projectFilePath)).catch(() => path.dirname(projectFilePath));
  if (realProjectDir !== realWorkspace && !realProjectDir.startsWith(realWorkspace + path.sep)) {
    throw new Error(`XCompiler project file ${projectFilePath} is outside its declared workspace ${workspace}`);
  }
  try {
    await fs.access(workspace, fsConstants.W_OK);
  } catch {
    throw new Error(`XCompiler project workspace is not writable: ${workspace}`);
  }
}

function relativeFrom(base: string, target: string): string {
  const relative = path.relative(base, target).replace(/\\/gu, '/');
  if (!relative) return '.';
  return relative.startsWith('..') ? target : relative;
}

function sanitizeProjectName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'project';
}

function assertProjectFileExtension(filePath: string): void {
  if (!filePath.endsWith(XCOMPILER_PROJECT_FILE_EXTENSION)) {
    throw new Error(`XCompiler project files must use the ${XCOMPILER_PROJECT_FILE_EXTENSION} suffix: ${filePath}`);
  }
}
