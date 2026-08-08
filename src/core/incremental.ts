import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { PlanSchema, type Language, type PlanIntent } from './plan.js';
import { DEFAULT_PHASE_PLAN_FILE, PhasePlanSchema } from './phase_plan.js';
import { PROJECT_MEMORY_PATH, refreshProjectMemory } from './project_memory.js';
import { loadPlanTarget } from './storage.js';

export interface IncrementalBaseline {
  summary: string;
  sources: string[];
  language?: Language;
  languageSource?: string;
}

/**
 * 增量开发基线汇总：把现有 workspace 中的 topic / 计划 / 关键文档 / 代码树
 * 收敛成一段可直接拼进 Planner prompt 的文本，供 feature/refactor 计划使用。
 */
export async function loadIncrementalBaseline(
  ws: Workspace,
  state: Workspace,
  opts: { planPath?: string; maxChars?: number } = {},
): Promise<IncrementalBaseline> {
  const sections: string[] = [];
  const sources: string[] = [];
  const maxChars = opts.maxChars ?? 14_000;
  let language: Language | undefined;
  let languageSource: string | undefined;

  const planSource = opts.planPath ? path.resolve(opts.planPath) : await defaultBaselinePlanPath(ws.root);
  const relPlan = relInsideWorkspace(ws.root, planSource);
  const planLabel = relPlan ?? path.relative(ws.root, planSource).replace(/\\/g, '/');
  const plan = await loadPlanSummary(ws, planSource, planLabel || DEFAULT_PHASE_PLAN_FILE);
  if (plan) {
    sections.push(plan.text);
    sources.push(planLabel || DEFAULT_PHASE_PLAN_FILE);
    language = plan.language;
    languageSource = plan.language ? planLabel || DEFAULT_PHASE_PLAN_FILE : undefined;
  }

  const memory = await refreshProjectMemory(ws, state, {
    planPath: planSource,
    language,
    intent: plan?.intent,
    maxChars: Math.min(maxChars, 11_000),
  });
  if (memory.summary) {
    sections.push(`## Existing project memory\n${memory.summary}`);
    sources.push(...memory.keyFiles.map((file) => file.path));
    sources.push(PROJECT_MEMORY_PATH);
    if (!language && memory.language) {
      language = memory.language;
      languageSource = PROJECT_MEMORY_PATH;
    }
  }

  const manifestSummary = await loadManifestSummary(ws);
  if (!language && manifestSummary?.language) {
    language = manifestSummary.language;
    languageSource = manifestSummary.sources[0];
  }

  const tree = await listProjectFiles(ws.root);
  if (tree.length > 0) {
    sections.push(`## Current source/test tree\n${tree.map((p) => `- ${p}`).join('\n')}`);
    sources.push('src/**', 'tests/**');
  }
  if (!language) {
    language = inferLanguageFromTree(tree);
    languageSource = language ? 'src/**, tests/**' : undefined;
  }

  const summary = joinCappedSections(sections, maxChars);
  return { summary, sources: dedup(sources), language, languageSource };
}

function joinCappedSections(sections: string[], maxChars: number): string {
  let out = '';
  for (const sec of sections) {
    const next = out ? `${out}\n\n${sec}` : sec;
    if (next.length <= maxChars) {
      out = next;
      continue;
    }
    const remain = maxChars - out.length - (out ? 2 : 0);
    if (remain > 64) {
      out = out ? `${out}\n\n${sec.slice(0, remain)}\n... [truncated]` : `${sec.slice(0, remain)}\n... [truncated]`;
    }
    break;
  }
  return out.trim();
}

async function loadPlanSummary(
  _ws: Workspace,
  planPath: string,
  label: string,
): Promise<{ text: string; language?: Language; intent?: PlanIntent } | null> {
  try {
    const raw = await fs.readFile(planPath, 'utf8');
    const json = JSON.parse(raw);
    const phasePlanParsed = PhasePlanSchema.safeParse(json);
    if (phasePlanParsed.success) {
      try {
        const loaded = await loadPlanTarget(planPath);
        const phasePlan = phasePlanParsed.data;
        const currentPhase =
          phasePlan.phases.find((phase) => phase.id === phasePlan.currentPhaseId) ??
          phasePlan.phases.find((phase) => phase.status === 'current') ??
          phasePlan.phases[0];
        return {
          text: [
            '## Existing phase plan summary',
            `- path: ${label}`,
            `- language: ${phasePlan.language}`,
            `- intent: ${phasePlan.intent}`,
            `- phases: ${phasePlan.phases.length}`,
            `- currentPhase: ${phasePlan.currentPhaseId}`,
            currentPhase ? `- currentObjective: ${currentPhase.objective}` : '- currentObjective: (unknown)',
            `- currentPlan: ${path.relative(path.dirname(planPath), loaded.planPath).replace(/\\/g, '/') || path.basename(loaded.planPath)}`,
            `- currentSteps: ${loaded.plan.steps.length}`,
            `- requirementDigest: ${phasePlan.requirementDigest}`,
            `- updatedAt: ${phasePlan.updatedAt}`,
          ].join('\n'),
          language: loaded.plan.language,
          intent: loaded.plan.intent,
        };
      } catch {
        return {
          text: `## Existing phase plan summary\n- path: ${label}\n- status: current phase plan is unreadable`,
          language: phasePlanParsed.data.language,
          intent: phasePlanParsed.data.intent,
        };
      }
    }
    const parsed = PlanSchema.safeParse(json);
    if (!parsed.success) {
      return {
        text: `## Existing plan summary\n- path: ${label}\n- status: unreadable by current schema`,
      };
    }
    const plan = parsed.data;
    return {
      text: [
        '## Existing plan summary',
        `- path: ${label}`,
        `- language: ${plan.language}`,
        `- intent: ${plan.intent}`,
        `- steps: ${plan.steps.length}`,
        `- requirementDigest: ${plan.requirementDigest}`,
        `- generatedAt: ${plan.createdAt}`,
      ].join('\n'),
      language: plan.language,
      intent: plan.intent,
    };
  } catch {
    return null;
  }
}

async function defaultBaselinePlanPath(root: string): Promise<string> {
  return path.join(root, DEFAULT_PHASE_PLAN_FILE);
}

async function loadManifestSummary(
  ws: Workspace,
): Promise<{ text: string; sources: string[]; language?: Language } | null> {
  if (await ws.exists('package.json')) {
    try {
      const pkg = JSON.parse(await ws.readFile('package.json')) as Record<string, unknown>;
      const scripts =
        pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
          ? Object.entries(pkg.scripts as Record<string, string>)
              .slice(0, 8)
              .map(([k, v]) => `  - ${k}: ${v}`)
          : [];
      const deps = [
        ...Object.keys((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {}).map((d) => `${d} (dev)`),
      ].slice(0, 24);
      return {
        text: [
          '## Existing manifest: package.json',
          `- name: ${String(pkg.name ?? '(unknown)')}`,
          `- type: ${String(pkg.type ?? '(unset)')}`,
          deps.length > 0 ? `- dependencies: ${deps.join(', ')}` : '- dependencies: (none)',
          scripts.length > 0 ? '- scripts:' : '- scripts: (none)',
          ...scripts,
        ].join('\n'),
        sources: ['package.json'],
        language: 'typescript',
      };
    } catch {
      /* ignore */
    }
  }
  if (await ws.exists('requirements.txt')) {
    const text = await readTruncatedWorkspaceFile(ws, 'requirements.txt', 1200);
    if (text) {
      return {
        text: `## Existing manifest: requirements.txt\n${text}`,
        sources: ['requirements.txt'],
        language: 'python',
      };
    }
  }
  return null;
}

async function readTruncatedWorkspaceFile(ws: Workspace, rel: string, maxChars: number): Promise<string> {
  try {
    const raw = await ws.readFile(rel);
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... [truncated]` : raw;
  } catch {
    return '';
  }
}

async function listProjectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const base of ['src', 'tests']) {
    const abs = path.join(root, base);
    await walk(abs, base, out, 0);
  }
  return out.slice(0, 120);
}

async function walk(abs: string, rel: string, out: string[], depth: number): Promise<void> {
  if (depth > 6 || out.length >= 120) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= 120) break;
    if (entry.name.startsWith('.')) continue;
    const childRel = `${rel}/${entry.name}`;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      await walk(childAbs, childRel, out, depth + 1);
    } else {
      out.push(childRel);
    }
  }
}

function relInsideWorkspace(root: string, maybeAbs?: string): string | null {
  if (!maybeAbs) return null;
  const full = path.resolve(maybeAbs);
  const rel = path.relative(root, full).replace(/\\/g, '/');
  return rel.startsWith('..') ? null : rel || path.basename(full);
}

function dedup(values: string[]): string[] {
  return [...new Set(values)];
}

function inferLanguageFromTree(tree: string[]): Language | undefined {
  let python = 0;
  let typescript = 0;
  for (const entry of tree) {
    if (entry.endsWith('.py')) python++;
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) typescript++;
  }
  if (typescript > 0 && python === 0) return 'typescript';
  if (python > 0 && typescript === 0) return 'python';
  return undefined;
}

export function isIncrementalIntent(intent: PlanIntent): boolean {
  return intent !== 'greenfield';
}
