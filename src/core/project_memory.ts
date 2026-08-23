import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { DOC_NAMES } from './docs.js';
import type { Language, PlanIntent, Step } from './plan.js';
import { DEFAULT_PHASE_PLAN_FILE } from './phase_plan.js';
import { loadPlanTarget } from './storage.js';

/**
 * Relative to the container state root, beside the PM projection.
 *
 * Project memory is a derived read model of the codebase, not authored knowledge: every run
 * recomputes it from the workspace, so it is rebuildable and needs no revision model. That is also
 * why it must not live inside a worktree — worktree-local state is never canonical and a parallel
 * worktree would each keep its own divergent copy.
 */
export const PROJECT_MEMORY_PATH = 'cache/project-memory.json';

export interface ProjectMemoryFile {
  path: string;
  kind: 'source' | 'test' | 'doc' | 'manifest';
  excerpt: string;
}

export interface ProjectMemoryModule {
  path: string;
  kind: 'source' | 'test';
  symbols: string[];
  relatedPaths: string[];
  summary: string;
}

export interface ProjectMemoryContract {
  kind: 'api' | 'invariant' | 'extension-point' | 'limitation' | 'integration';
  subject: string;
  detail: string;
  path?: string;
}

export interface ProjectMemory {
  version: '2';
  updatedAt: string;
  language?: Language;
  intent?: PlanIntent;
  planPath?: string;
  summary: string;
  keyFiles: ProjectMemoryFile[];
  modules: ProjectMemoryModule[];
  contracts: ProjectMemoryContract[];
}

/**
 * Scans `ws` — the code — and writes the result to `state` — the container. The two are distinct
 * workspaces under the container/worktree split and must not be conflated.
 */
export async function refreshProjectMemory(
  ws: Workspace,
  state: Workspace,
  opts: { planPath?: string; language?: Language; intent?: PlanIntent; maxChars?: number } = {},
): Promise<ProjectMemory> {
  const memory = await buildProjectMemory(ws, opts);
  await state.writeFile(PROJECT_MEMORY_PATH, JSON.stringify(memory, null, 2) + '\n');
  return memory;
}

export async function loadProjectMemory(state: Workspace): Promise<ProjectMemory | null> {
  try {
    const raw = await state.readFile(PROJECT_MEMORY_PATH);
    const parsed = JSON.parse(raw) as ProjectMemory;
    if (!parsed || parsed.version !== '2' || typeof parsed.summary !== 'string' || !Array.isArray(parsed.keyFiles)) {
      return null;
    }
    if (!Array.isArray(parsed.modules)) parsed.modules = [];
    if (!Array.isArray(parsed.contracts)) parsed.contracts = [];
    return parsed;
  } catch {
    return null;
  }
}

export async function buildProjectMemory(
  ws: Workspace,
  opts: { planPath?: string; language?: Language; intent?: PlanIntent; maxChars?: number } = {},
): Promise<ProjectMemory> {
  const sections: string[] = [];
  const keyFiles: ProjectMemoryFile[] = [];
  const maxChars = opts.maxChars ?? 18_000;

  const planSummary = await readPlanMetadata(ws, opts.planPath);
  let language = opts.language ?? planSummary?.language;
  const intent = opts.intent ?? planSummary?.intent;

  sections.push('## Project memory');
  sections.push(`- language: ${language ?? '(unknown)'}`);
  sections.push(`- intent: ${intent ?? '(unknown)'}`);
  if (opts.planPath) sections.push(`- planPath: ${path.resolve(opts.planPath)}`);
  sections.push('');

  const projectDocs = [
    DOC_NAMES.topic,
    DOC_NAMES.requirementAnalysis,
    DOC_NAMES.highLevelDesign,
    DOC_NAMES.detailedDesign,
    DOC_NAMES.functionalTestPlan,
    DOC_NAMES.integrationTestPlan,
    DOC_NAMES.moduleTestPlan,
    DOC_NAMES.unitTestPlan,
    DOC_NAMES.unitTest,
    DOC_NAMES.integrationTest,
    DOC_NAMES.moduleTest,
    DOC_NAMES.functionalTest,
    DOC_NAMES.delivery,
    ...(intent === 'self'
      ? [
          'docs/XCompiler_design.md',
          'docs/self_bootstrap.md',
          'docs/implementation_plan.md',
          'docs/plugin_api.md',
        ]
      : []),
  ];
  for (const rel of projectDocs) {
    const doc = await readWorkspaceText(ws, rel, 1600);
    if (!doc) continue;
    keyFiles.push({ path: rel, kind: 'doc', excerpt: doc });
    sections.push(`## ${rel}`);
    sections.push(doc);
    sections.push('');
  }

  const manifest = await buildManifestMemory(ws);
  if (manifest) {
    if (!language) {
      language = manifest.path === 'package.json' ? 'typescript' : 'python';
    }
    keyFiles.push(manifest);
    sections.push(`## ${manifest.path}`);
    sections.push(manifest.excerpt);
    sections.push('');
  }

  const implementationFiles = await selectKeyImplementationFiles(ws.root, 10);
  const modules = await buildModuleFacts(ws.root, implementationFiles);
  const contracts = await buildContractFacts(ws, modules);
  if (modules.length > 0) {
    sections.push('## Module map');
    for (const module of modules.slice(0, 10)) {
      sections.push(`- ${module.path}: ${module.summary}`);
    }
    sections.push('');
  }
  if (contracts.length > 0) {
    sections.push('## Contracts');
    for (const contract of contracts.slice(0, 14)) {
      sections.push(`- [${contract.kind}] ${contract.subject}: ${contract.detail}`);
    }
    sections.push('');
  }
  if (implementationFiles.length > 0) {
    sections.push('## Key implementation snippets');
    sections.push('');
  }
  for (const file of implementationFiles) {
    const excerpt = await readAbsoluteText(path.join(ws.root, file), 1200);
    if (!excerpt) continue;
    keyFiles.push({
      path: file,
      kind: file.startsWith('tests/') ? 'test' : 'source',
      excerpt,
    });
    sections.push(`### ${file}`);
    sections.push('```text');
    sections.push(excerpt);
    sections.push('```');
    sections.push('');
  }

  return {
    version: '2',
    updatedAt: new Date().toISOString(),
    language,
    intent,
    planPath: opts.planPath ? path.resolve(opts.planPath) : undefined,
    summary: joinCappedSections(sections, maxChars),
    keyFiles: dedupFiles(keyFiles).slice(0, 18),
    modules,
    contracts,
  };
}

export function selectMemorySnippetsForStep(
  memory: ProjectMemory | null,
  step: Step,
  maxSnippets: number = 4,
): Array<{ path: string; content: string }> {
  if (!memory || memory.keyFiles.length === 0) return [];
  const query = `${step.title}\n${step.description}\n${step.acceptance}\n${step.inputs.join('\n')}\n${step.outputs.join('\n')}`;
  const tokens = tokenize(query);
  const modules = new Map(memory.modules.map((module) => [module.path, module]));
  const ranked = memory.keyFiles
    .map((file) => ({ file, score: scoreMemoryFile(file, tokens, step, modules.get(file.path)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, maxSnippets)
    .map((item) => ({ path: item.file.path, content: item.file.excerpt }));
  return ranked;
}

export function selectMemoryContractsForStep(
  memory: ProjectMemory | null,
  step: Step,
  maxContracts: number = 6,
): ProjectMemoryContract[] {
  if (!memory || memory.contracts.length === 0) return [];
  const query = `${step.title}\n${step.description}\n${step.acceptance}\n${step.inputs.join('\n')}\n${step.outputs.join('\n')}`;
  const tokens = tokenize(query);
  return memory.contracts
    .map((contract) => ({ contract, score: scoreContract(contract, tokens, step) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.contract.subject.localeCompare(b.contract.subject))
    .slice(0, maxContracts)
    .map((item) => item.contract);
}

async function readPlanMetadata(
  ws: Workspace,
  planPath?: string,
): Promise<{ language?: Language; intent?: PlanIntent } | null> {
  const full = planPath ? path.resolve(planPath) : await defaultPlanMetadataPath(ws.root);
  try {
    const loaded = await loadPlanTarget(full);
    return { language: loaded.plan.language, intent: loaded.plan.intent };
  } catch {
    return null;
  }
}

async function defaultPlanMetadataPath(root: string): Promise<string> {
  return path.join(root, DEFAULT_PHASE_PLAN_FILE);
}

async function buildManifestMemory(ws: Workspace): Promise<ProjectMemoryFile | null> {
  if (await ws.exists('package.json')) {
    const text = await readWorkspaceText(ws, 'package.json', 1600);
    if (text) return { path: 'package.json', kind: 'manifest', excerpt: text };
  }
  if (await ws.exists('requirements.txt')) {
    const text = await readWorkspaceText(ws, 'requirements.txt', 1200);
    if (text) return { path: 'requirements.txt', kind: 'manifest', excerpt: text };
  }
  return null;
}

async function readWorkspaceText(ws: Workspace, rel: string, maxChars: number): Promise<string> {
  try {
    const raw = await ws.readFile(rel);
    const text = rel === DOC_NAMES.topic ? stripGeneratedBaselineSection(raw) : raw;
    return truncate(text, maxChars);
  } catch {
    return '';
  }
}

async function readAbsoluteText(fullPath: string, maxChars: number): Promise<string> {
  try {
    const raw = await fs.readFile(fullPath, 'utf8');
    return truncate(raw, maxChars);
  } catch {
    return '';
  }
}

async function selectKeyImplementationFiles(root: string, maxFiles: number): Promise<string[]> {
  const all = await listProjectFiles(root);
  const ranked = all
    .filter((file) => /\.(py|ts|tsx)$/u.test(file))
    .map((file) => ({ file, score: scoreProjectFile(file) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxFiles)
    .map((item) => item.file);
  return ranked;
}

async function listProjectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const base of ['src', 'tests']) {
    await walk(path.join(root, base), base, out, 0);
  }
  return out;
}

async function walk(abs: string, rel: string, out: string[], depth: number): Promise<void> {
  if (depth > 6 || out.length >= 160) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= 160) break;
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

function scoreProjectFile(file: string): number {
  const depth = file.split('/').length;
  let score = file.startsWith('src/') ? 80 : 50;
  score += Math.max(0, 20 - depth * 3);
  if (/main|index|app|server|api|cli|router|controller|service|model|parser|schema|types|core|engine/i.test(file)) score += 25;
  if (/test|spec/i.test(file)) score += 10;
  return score;
}

function scoreMemoryFile(
  file: ProjectMemoryFile,
  tokens: Set<string>,
  step: Step,
  module?: ProjectMemoryModule,
): number {
  const haystack = [
    file.path,
    file.excerpt,
    module?.summary ?? '',
    ...(module?.symbols ?? []),
    ...(module?.relatedPaths ?? []),
  ].join('\n').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 4;
  }
  if (file.kind === 'manifest') score += step.phase === 'HIGH_LEVEL_DESIGN' ? 20 : 4;
  if (file.kind === 'doc') score += ['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'FUNCTIONAL_TEST'].includes(step.phase) ? 16 : 6;
  if (file.kind === 'source') score += ['CODE', 'UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(step.phase) ? 14 : 2;
  if (file.kind === 'test') score += ['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(step.phase) ? 14 : 2;
  if (step.inputs.includes(file.path)) score += 24;
  if (step.outputs.includes(file.path)) score += 20;
  if (module) {
    score += Math.min(18, module.symbols.length * 3);
    if (module.relatedPaths.some((rel) => step.inputs.includes(rel) || step.outputs.includes(rel))) score += 16;
  }
  return score;
}

function scoreContract(
  contract: ProjectMemoryContract,
  tokens: Set<string>,
  step: Step,
): number {
  const haystack = `${contract.subject}\n${contract.detail}\n${contract.path ?? ''}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 4;
  }
  if (contract.kind === 'api') score += ['CODE', 'UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(step.phase) ? 12 : 4;
  if (contract.kind === 'invariant') score += ['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(step.phase) ? 12 : 6;
  if (contract.kind === 'extension-point') score += ['HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE'].includes(step.phase) ? 10 : 4;
  if (contract.kind === 'limitation') score += step.phase === 'FUNCTIONAL_TEST' ? 10 : 3;
  if (contract.kind === 'integration') score += ['HIGH_LEVEL_DESIGN', 'CODE', 'INTEGRATION_TEST', 'FUNCTIONAL_TEST'].includes(step.phase) ? 10 : 4;
  if (contract.path && (step.inputs.includes(contract.path) || step.outputs.includes(contract.path))) score += 16;
  return score;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\n... [truncated]` : normalized;
}

function stripGeneratedBaselineSection(text: string): string {
  const idx = text.search(/^##\s+(Existing project baseline|现有工程基线)\s*$/m);
  if (idx < 0) return text;
  return text.slice(0, idx).trimEnd();
}

function joinCappedSections(sections: string[], maxChars: number): string {
  let out = '';
  for (const sec of sections.filter(Boolean)) {
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

function dedupFiles(files: ProjectMemoryFile[]): ProjectMemoryFile[] {
  const seen = new Set<string>();
  const out: ProjectMemoryFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}

async function buildModuleFacts(root: string, files: string[]): Promise<ProjectMemoryModule[]> {
  const modules: ProjectMemoryModule[] = [];
  for (const file of files) {
    const text = await readAbsoluteText(path.join(root, file), 4000);
    if (!text) continue;
    const symbols = extractSymbols(text, file);
    const relatedPaths = inferRelatedPaths(file, files, text);
    modules.push({
      path: file,
      kind: file.startsWith('tests/') ? 'test' : 'source',
      symbols,
      relatedPaths,
      summary: summarizeModule(file, symbols, relatedPaths),
    });
  }
  return modules;
}

async function buildContractFacts(
  ws: Workspace,
  modules: ProjectMemoryModule[],
): Promise<ProjectMemoryContract[]> {
  const contracts: ProjectMemoryContract[] = [];
  for (const module of modules) {
    if (module.kind === 'source' && module.symbols.length > 0) {
      contracts.push({
        kind: 'api',
        subject: module.path,
        path: module.path,
        detail: `Exports / public surface: ${module.symbols.slice(0, 8).join(', ')}`,
      });
    }
    if (module.relatedPaths.length > 0) {
      contracts.push({
        kind: 'integration',
        subject: module.path,
        path: module.path,
        detail: `Coordinates with: ${module.relatedPaths.slice(0, 5).join(', ')}`,
      });
    }
  }
  for (const rel of [
    DOC_NAMES.highLevelDesign,
    DOC_NAMES.detailedDesign,
    DOC_NAMES.integrationTestPlan,
    DOC_NAMES.moduleTestPlan,
    DOC_NAMES.functionalTest,
  ]) {
    const text = await readWorkspaceText(ws, rel, 2200);
    if (!text) continue;
    contracts.push(...extractContractsFromDoc(rel, text));
  }
  return dedupContracts(contracts).slice(0, 32);
}

function summarizeModule(file: string, symbols: string[], relatedPaths: string[]): string {
  const parts: string[] = [];
  parts.push(file.startsWith('tests/') ? 'test module' : 'source module');
  parts.push(symbols.length > 0 ? `symbols: ${symbols.slice(0, 6).join(', ')}` : 'symbols: (none detected)');
  if (relatedPaths.length > 0) parts.push(`related: ${relatedPaths.slice(0, 4).join(', ')}`);
  return parts.join('; ');
}

function extractSymbols(text: string, file: string): string[] {
  const symbols = new Set<string>();
  const patterns = file.endsWith('.py')
    ? [
        /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gmu,
        /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|:)/gmu,
      ]
    : [
        /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gmu,
        /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*/gmu,
        /^\s*export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gmu,
      ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
    }
  }
  return [...symbols].slice(0, 12);
}

function inferRelatedPaths(file: string, files: string[], text: string): string[] {
  const related = new Set<string>();
  const stem = canonicalStem(file);
  for (const candidate of files) {
    if (candidate === file) continue;
    if (canonicalStem(candidate) === stem) related.add(candidate);
  }
  for (const imported of extractImportedStems(text)) {
    for (const candidate of files) {
      if (candidate === file) continue;
      if (canonicalStem(candidate).endsWith(imported) || canonicalStem(candidate) === imported) {
        related.add(candidate);
      }
    }
  }
  return [...related].slice(0, 6);
}

function canonicalStem(file: string): string {
  return file
    .replace(/^src\//u, '')
    .replace(/^tests\//u, '')
    .replace(/\.(test|spec)\./u, '.')
    .replace(/\.(py|ts|tsx)$/u, '');
}

function extractImportedStems(text: string): string[] {
  const stems = new Set<string>();
  const tsPatterns = [
    /from\s+['"](\.[^'"]+)['"]/gmu,
    /import\s+['"](\.[^'"]+)['"]/gmu,
  ];
  for (const pattern of tsPatterns) {
    for (const match of text.matchAll(pattern)) {
      const stem = normalizeImportStem(match[1] ?? '');
      if (stem) stems.add(stem);
    }
  }
  for (const match of text.matchAll(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gmu)) {
    const stem = (match[1] ?? '').replace(/^src\./u, '').replace(/\./g, '/');
    if (stem) stems.add(stem);
  }
  return [...stems];
}

function normalizeImportStem(value: string): string {
  return value
    .replace(/^\.\//u, '')
    .replace(/^\.\.\//u, '')
    .replace(/\.(js|ts|tsx|py)$/u, '')
    .replace(/\/index$/u, '')
    .trim();
}

function extractContractsFromDoc(path: string, text: string): ProjectMemoryContract[] {
  const contracts: ProjectMemoryContract[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^[-*#\d.\s]+/u, '').trim();
    if (line.length < 18) continue;
    const lower = line.toLowerCase();
    if (INVARIANT_RE.test(lower)) {
      contracts.push({ kind: 'invariant', subject: path, path, detail: trimContractLine(line) });
    } else if (LIMITATION_RE.test(lower)) {
      contracts.push({ kind: 'limitation', subject: path, path, detail: trimContractLine(line) });
    } else if (EXTENSION_RE.test(lower)) {
      contracts.push({ kind: 'extension-point', subject: path, path, detail: trimContractLine(line) });
    } else if (INTEGRATION_RE.test(lower)) {
      contracts.push({ kind: 'integration', subject: path, path, detail: trimContractLine(line) });
    }
  }
  return contracts;
}

function trimContractLine(line: string): string {
  return line.length > 220 ? `${line.slice(0, 220)}...` : line;
}

const INVARIANT_RE = /\b(must|must not|preserve|should|required|forbid|forbidden|禁止|必须|不得|保持|兼容|不可)\b/u;
const LIMITATION_RE = /\b(limit|limitation|known issue|known limitation|todo|unsupported|not support|暂不|未支持|限制|已知)\b/u;
const EXTENSION_RE = /\b(extension|extend|hook|plugin|future|later|follow-up|扩展|插件|后续|预留)\b/u;
const INTEGRATION_RE = /\b(api|http|cli|database|storage|queue|webhook|github|slack|router|service|集成|接口|命令|数据库)\b/u;

function dedupContracts(contracts: ProjectMemoryContract[]): ProjectMemoryContract[] {
  const seen = new Set<string>();
  const out: ProjectMemoryContract[] = [];
  for (const contract of contracts) {
    const key = `${contract.kind}::${contract.subject}::${contract.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(contract);
  }
  return out;
}
