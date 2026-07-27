import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DEFAULT_PHASE_PLAN_FILE } from '../core/phase_plan.js';
import { loadPlanTarget } from '../core/storage.js';
import type { Plan, Step } from '../core/plan.js';

export interface LsOptions {
  workspace: string;
  /** Maximum depth for recursively finding phasePlan.json files. Defaults to 4. */
  maxDepth?: number;
}

export interface PlanSummary {
  total: number;
  done: number;
  failed: number;
  pending: number;
  running: number;
}

export interface LsPlanEntry {
  path: string;
  relativePath: string;
  language?: string;
  summary?: PlanSummary;
  requirementDigestLine?: string;
  error?: string;
}

export interface LsResult {
  root: string;
  plans: LsPlanEntry[];
}

export async function runLsCommand(opts: LsOptions): Promise<LsResult> {
  const root = path.resolve(opts.workspace);
  const found = await findPlans(root, opts.maxDepth ?? 4);
  const plans: LsPlanEntry[] = [];
  for (const file of found) {
    const relativePath = path.relative(root, file) || file;
    try {
      const loaded = await loadPlanTarget(file);
      const plan = loaded.plan;
      const digest = plan.requirementDigest?.split('\n')[0]?.slice(0, 100);
      plans.push({
        path: file,
        relativePath,
        language: plan.language,
        summary: summarizePlan(plan),
        requirementDigestLine: digest || undefined,
      });
    } catch (err) {
      plans.push({
        path: file,
        relativePath,
        error: (err as Error).message,
      });
    }
  }
  return { root, plans };
}

export interface ShowOptions {
  workspace: string;
  stepId: string;
  planPath?: string;
  /** Number of recent matching audit jsonl events. Defaults to 10. */
  auditTail?: number;
}

export interface ShowOutputStatus {
  path: string;
  exists: boolean;
}

export interface AuditLine {
  ts: string;
  kind: string;
  msg?: string;
}

export interface ShowResult {
  root: string;
  planPath: string;
  stepId: string;
  step?: Step;
  outputs: ShowOutputStatus[];
  auditEvents: AuditLine[];
  exitCode: number;
}

export async function runShowCommand(opts: ShowOptions): Promise<ShowResult> {
  const root = path.resolve(opts.workspace);
  const requestedPlanPath = opts.planPath ? path.resolve(opts.planPath) : await defaultInspectPlanPath(root);
  const loaded = await loadPlanTarget(requestedPlanPath);
  const planPath = loaded.planPath;
  const plan = loaded.plan;
  const step = plan.steps.find((s) => s.id === opts.stepId);
  if (!step) {
    return {
      root,
      planPath: loaded.phasePlanPath ?? planPath,
      stepId: opts.stepId,
      outputs: [],
      auditEvents: [],
      exitCode: 1,
    };
  }

  const outputs: ShowOutputStatus[] = [];
  for (const out of step.outputs) {
    outputs.push({ path: out, exists: await fileExists(path.join(root, out)) });
  }
  const auditFile = path.join(root, '.xcompiler', 'audit.jsonl');
  const auditEvents = await readAuditFor(auditFile, opts.stepId, opts.auditTail ?? 10);
  return {
    root,
    planPath: loaded.phasePlanPath ?? planPath,
    stepId: opts.stepId,
    step,
    outputs,
    auditEvents,
    exitCode: 0,
  };
}

export function summarizePlan(plan: Plan): PlanSummary {
  const acc: PlanSummary = { total: plan.steps.length, done: 0, failed: 0, pending: 0, running: 0 };
  for (const s of plan.steps) {
    if (s.status === 'DONE') acc.done++;
    else if (s.status === 'FAILED') acc.failed++;
    else if (s.status === 'RUNNING') acc.running++;
    else acc.pending++;
  }
  return acc;
}

export async function findPlans(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.xcompiler', 'docs']);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && isInspectablePlanFile(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(root, 0);
  return out.sort();
}

async function defaultInspectPlanPath(root: string): Promise<string> {
  return path.join(root, DEFAULT_PHASE_PLAN_FILE);
}

function isInspectablePlanFile(fileName: string): boolean {
  return fileName === DEFAULT_PHASE_PLAN_FILE;
}

export async function readAuditFor(file: string, stepId: string, tail: number): Promise<AuditLine[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: AuditLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const data = ev.data as Record<string, unknown> | undefined;
    const msg = typeof ev.msg === 'string' ? ev.msg : '';
    const matches =
      msg.includes(stepId) ||
      (data && typeof data.stepId === 'string' && data.stepId === stepId) ||
      (data && typeof data.step === 'string' && data.step === stepId);
    if (matches) {
      out.push({
        ts: typeof ev.ts === 'string' ? ev.ts : '',
        kind: typeof ev.kind === 'string' ? ev.kind : '?',
        msg,
      });
    }
  }
  return out.slice(-tail);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export type InspectStep = Step;
