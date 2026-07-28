import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { xcEnv } from '../config/env.js';
import { assertStateTransition, type StateTransitions } from '../util/state_machine.js';
import type { DebugBrief, DebugFailureCategory } from './debug_brief.js';
import type { Phase } from './plan.js';

export const DEFAULT_DEBUG_WIKI_REL_PATH = '.xcompiler/debug-wiki';
export const BUNDLED_DEBUG_WIKI_REL_PATH = 'debug-wiki';
export const DEBUG_WIKI_VERSION = 1;

export type DebugWikiLayer = 'system' | 'agent' | 'external';
export type DebugWikiEntryStatus = 'active' | 'needs_review' | 'superseded';

const DEBUG_WIKI_STATUS_TRANSITIONS: StateTransitions<DebugWikiEntryStatus> = {
  active: ['needs_review', 'superseded'],
  needs_review: ['active', 'superseded'],
  superseded: [],
};

export interface DebugWikiEntry {
  id: string;
  layer: DebugWikiLayer;
  createdAt: string;
  updatedAt: string;
  status: DebugWikiEntryStatus;
  category: DebugFailureCategory;
  summary: string;
  primaryError: string;
  debugDemand: string;
  fingerprints: string[];
  symptoms: string[];
  resolutionPlan?: string;
  solution: string;
  evidence: string[];
  sourceTicketId?: string;
  sourceStepId?: string;
  sourcePhase?: Phase;
  targetPhase?: Phase;
  language?: string;
  repairFiles?: string[];
  supersedes?: string[];
  stats: { uses: number; successes: number; failures: number };
  lastUsedAt?: string;
  feedback: DebugWikiFeedback[];
  sourcePath?: string;
}

export interface DebugWikiFeedback {
  at: string;
  kind: 'used' | 'success' | 'failure' | 'corrected';
  entryId?: string;
  ticketId?: string;
  stepId?: string;
  phase?: Phase;
  summary: string;
  reason?: string;
}

export interface DebugWikiMatch {
  entry: DebugWikiEntry;
  score: number;
  confidence: number;
  reasons: string[];
}

export interface DebugWikiResolutionInput {
  brief: DebugBrief;
  ticketId?: string;
  stepId?: string;
  phase?: Phase;
  targetPhase?: Phase;
  language?: string;
  resolutionPlan?: string;
  solution: string;
  evidence?: string[];
  repairFiles?: string[];
  usedEntryIds?: string[];
}

interface DebugWikiIndex {
  version: 1;
  updatedAt: string;
  root: string;
  layers: Record<DebugWikiLayer, { entries: number; writable: boolean }>;
  entries: Array<Pick<DebugWikiEntry, 'id' | 'layer' | 'status' | 'category' | 'summary' | 'updatedAt' | 'sourcePath'>>;
}

interface DebugWikiOperationLogEntry {
  at: string;
  action: 'use' | 'failure' | 'resolution_created' | 'resolution_updated';
  entryIds: string[];
  ticketId?: string;
  stepId?: string;
  phase?: Phase;
  summary: string;
  reason?: string;
}

const LAYERS: DebugWikiLayer[] = ['system', 'agent', 'external'];
const EMPTY_STATS = { uses: 0, successes: 0, failures: 0 };

export function defaultDebugWikiPath(fallbackRoot?: string): string {
  const configured = xcEnv('PATH')?.trim();
  const candidate = configured
    ? path.resolve(configured)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const base = isFilesystemRoot(candidate) && fallbackRoot
    ? path.resolve(fallbackRoot)
    : candidate;
  return path.join(base, DEFAULT_DEBUG_WIKI_REL_PATH);
}

function isFilesystemRoot(candidate: string): boolean {
  return path.resolve(candidate) === path.parse(path.resolve(candidate)).root;
}

export function bundledDebugWikiPath(): string {
  return path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), BUNDLED_DEBUG_WIKI_REL_PATH);
}

export class DebugWiki {
  private loaded = false;
  private entries: DebugWikiEntry[] = [];

  public readonly rootPath: string;
  public readonly filePath: string;
  private readonly bundledPath: string;

  constructor(rootPath: string, opts: { bundledPath?: string } = {}) {
    this.rootPath = path.resolve(rootPath);
    this.filePath = this.rootPath;
    this.bundledPath = opts.bundledPath ?? bundledDebugWikiPath();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.ensureLayout();
    await this.ensureRootReadme();
    await this.ensureOperationLog();
    await this.copyBundledLayers();
    this.entries = [];
    for (const layer of LAYERS) {
      this.entries.push(...await this.readLayer(layer));
    }
    await this.applyFeedbackLog();
    await this.writeIndex();
  }

  async search(brief: DebugBrief, opts: { limit?: number; language?: string } = {}): Promise<DebugWikiMatch[]> {
    await this.load();
    const limit = opts.limit ?? 3;
    return this.rank(brief, opts.language)
      .filter((match) => match.score >= 4)
      .slice(0, limit);
  }

  async recordUse(entryIds: string[], input: DebugWikiResolutionInput): Promise<void> {
    await this.load();
    const now = new Date().toISOString();
    const feedback = this.feedbackFrom(entryIds, input, now, 'used');
    if (feedback.length === 0) return;
    for (const item of feedback) {
      const entry = this.byId(item.entryId);
      if (!entry) continue;
      entry.stats.uses += 1;
      entry.lastUsedAt = now;
      entry.updatedAt = now;
      pushFeedback(entry, item);
    }
    await this.appendLayerFeedback(feedback);
    await this.persistExternalEntries();
    await this.writeIndex(now);
    await this.appendOperationLog({
      at: now,
      action: 'use',
      entryIds: feedback.map((item) => item.entryId).filter(Boolean) as string[],
      ticketId: input.ticketId,
      stepId: input.stepId,
      phase: input.phase,
      summary: input.brief.summary,
    });
  }

  async recordFailure(entryIds: string[], input: DebugWikiResolutionInput & { reason?: string }): Promise<void> {
    await this.load();
    const now = new Date().toISOString();
    const feedback = this.feedbackFrom(entryIds, input, now, 'failure', input.reason);
    if (feedback.length === 0) return;
    for (const item of feedback) {
      const entry = this.byId(item.entryId);
      if (!entry) continue;
      entry.stats.failures += 1;
      transitionDebugWikiEntry(entry, 'needs_review');
      entry.updatedAt = now;
      pushFeedback(entry, item);
    }
    await this.appendLayerFeedback(feedback);
    await this.persistExternalEntries();
    await this.writeIndex(now);
    await this.appendOperationLog({
      at: now,
      action: 'failure',
      entryIds: feedback.map((item) => item.entryId).filter(Boolean) as string[],
      ticketId: input.ticketId,
      stepId: input.stepId,
      phase: input.phase,
      summary: input.brief.summary,
      reason: input.reason,
    });
  }

  async recordResolution(input: DebugWikiResolutionInput): Promise<{ created?: string; updated: string[] }> {
    await this.load();
    const now = new Date().toISOString();
    const used = this.byIds(input.usedEntryIds ?? []);
    const externalTargets = used.filter((entry) => entry.layer === 'external');
    const target = externalTargets.length > 0
      ? externalTargets
      : this.rank(input.brief, input.language)
          .filter((match) => match.entry.layer === 'external' && match.score >= 8)
          .slice(0, 1)
          .map((m) => m.entry);
    const updated: string[] = [];
    let createdId: string | undefined;
    for (const entry of target) {
      this.applyResolution(entry, input, now, entry.stats.failures > 0 ? 'corrected' : 'success');
      updated.push(entry.id);
    }
    if (updated.length === 0) {
      const created = createEntry(input, now, this.nextExternalId(now), 'external');
      created.supersedes = used.length > 0 ? used.map((entry) => entry.id) : undefined;
      this.entries.push(created);
      createdId = created.id;
    }
    const correctedFeedback = this.feedbackFrom(
      used.filter((entry) => entry.layer !== 'external').map((entry) => entry.id),
      input,
      now,
      'corrected',
    );
    for (const item of correctedFeedback) {
      const entry = this.byId(item.entryId);
      if (!entry) continue;
      entry.stats.successes += 1;
      transitionDebugWikiEntry(entry, 'active');
      entry.updatedAt = now;
      pushFeedback(entry, item);
    }
    await this.appendLayerFeedback(correctedFeedback);
    await this.persistExternalEntries();
    await this.writeIndex(now);
    await this.appendOperationLog({
      at: now,
      action: createdId ? 'resolution_created' : 'resolution_updated',
      entryIds: createdId ? [createdId] : updated,
      ticketId: input.ticketId,
      stepId: input.stepId,
      phase: input.phase,
      summary: input.brief.summary,
    });
    return createdId ? { created: createdId, updated: [] } : { updated };
  }

  private async ensureLayout(): Promise<void> {
    for (const layer of LAYERS) {
      await fs.mkdir(this.layerDir(layer), { recursive: true });
    }
  }

  private async ensureRootReadme(): Promise<void> {
    const to = path.join(this.rootPath, 'README.md');
    if (await exists(to)) return;
    const from = path.join(this.bundledPath, 'README.md');
    const fallback = defaultDebugWikiReadme();
    const text = await fs.readFile(from, 'utf8').catch(() => fallback);
    await fs.writeFile(to, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  }

  private async ensureOperationLog(): Promise<void> {
    const file = this.operationLogPath();
    if (await exists(file)) return;
    await fs.writeFile(file, '# XCompiler Debug Wiki Log\n\nAppend-only operational notes for retrieval, failed reuse, and confirmed repairs.\n', 'utf8');
  }

  private async copyBundledLayers(): Promise<void> {
    if (path.resolve(this.bundledPath) === this.rootPath) return;
    for (const layer of ['system', 'agent'] as const) {
      const from = path.join(this.bundledPath, 'wiki', layer);
      const to = this.layerDir(layer);
      if (!await exists(from)) continue;
      await fs.cp(from, to, { recursive: true, force: true });
    }
  }

  private async readLayer(layer: DebugWikiLayer): Promise<DebugWikiEntry[]> {
    const dir = this.layerDir(layer);
    const files = (await fs.readdir(dir).catch(() => []))
      .filter((file) => file.endsWith('.md'))
      .sort();
    const entries: DebugWikiEntry[] = [];
    for (const file of files) {
      const abs = path.join(dir, file);
      const page = parseWikiPage(await fs.readFile(abs, 'utf8'));
      const entry = normalizeEntry({ ...page.data, layer, solution: page.data.solution ?? page.body }, layer);
      entry.sourcePath = path.relative(this.rootPath, abs).replace(/\\/g, '/');
      entries.push(entry);
    }
    return entries;
  }

  private async applyFeedbackLog(): Promise<void> {
    const log = await fs.readFile(this.feedbackPath(), 'utf8').catch(() => '');
    for (const line of log.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const item = JSON.parse(line) as DebugWikiFeedback;
      const entry = this.byId(item.entryId);
      if (!entry) continue;
      if (item.kind === 'used') entry.stats.uses += 1;
      if (item.kind === 'failure') {
        entry.stats.failures += 1;
        transitionDebugWikiEntry(entry, 'needs_review');
      }
      if (item.kind === 'success' || item.kind === 'corrected') {
        entry.stats.successes += 1;
        if (item.kind === 'corrected') transitionDebugWikiEntry(entry, 'active');
      }
      entry.updatedAt = item.at;
      pushFeedback(entry, item);
    }
  }

  private applyResolution(
    entry: DebugWikiEntry,
    input: DebugWikiResolutionInput,
    now: string,
    kind: DebugWikiFeedback['kind'],
  ): void {
    transitionDebugWikiEntry(entry, 'active');
    entry.updatedAt = now;
    entry.summary = input.brief.summary;
    entry.primaryError = input.brief.primaryError;
    entry.debugDemand = input.brief.debugDemand;
    entry.fingerprints = dedup([...entry.fingerprints, ...fingerprints(input.brief)]);
    entry.symptoms = dedup([...input.brief.evidence, ...entry.symptoms]).slice(0, 12);
    entry.evidence = dedup([...(input.evidence ?? []), ...entry.evidence]).slice(0, 12);
    if (input.resolutionPlan?.trim()) entry.resolutionPlan = input.resolutionPlan.trim();
    entry.solution = mergeSolution(entry.solution, input.solution);
    entry.repairFiles = dedup([...(input.repairFiles ?? []), ...(entry.repairFiles ?? [])]).slice(0, 12);
    entry.stats.successes += 1;
    pushFeedback(entry, {
      at: now,
      kind,
      entryId: entry.id,
      ticketId: input.ticketId,
      stepId: input.stepId,
      phase: input.phase,
      summary: input.brief.summary,
    });
  }

  private async persistExternalEntries(): Promise<void> {
    for (const entry of this.entries.filter((item) => item.layer === 'external')) {
      const abs = path.join(this.rootPath, entry.sourcePath ?? this.externalEntryPath(entry));
      entry.sourcePath = path.relative(this.rootPath, abs).replace(/\\/g, '/');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, renderWikiPage(entry), 'utf8');
    }
  }

  private async appendFeedback(feedback: DebugWikiFeedback[]): Promise<void> {
    if (feedback.length === 0) return;
    await fs.mkdir(path.dirname(this.feedbackPath()), { recursive: true });
    await fs.appendFile(this.feedbackPath(), feedback.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  }

  private async appendLayerFeedback(feedback: DebugWikiFeedback[]): Promise<void> {
    await this.appendFeedback(feedback.filter((item) => this.byId(item.entryId)?.layer !== 'external'));
  }

  private async appendOperationLog(entry: DebugWikiOperationLogEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.operationLogPath()), { recursive: true });
    await fs.appendFile(this.operationLogPath(), renderOperationLogEntry(entry), 'utf8');
  }

  private async writeIndex(now = new Date().toISOString()): Promise<void> {
    const layerCounts = Object.fromEntries(LAYERS.map((layer) => [
      layer,
      { entries: this.entries.filter((entry) => entry.layer === layer).length, writable: layer === 'external' },
    ])) as DebugWikiIndex['layers'];
    const index: DebugWikiIndex = {
      version: DEBUG_WIKI_VERSION,
      updatedAt: now,
      root: this.rootPath,
      layers: layerCounts,
      entries: this.entries.map((entry) => ({
        id: entry.id,
        layer: entry.layer,
        status: entry.status,
        category: entry.category,
        summary: entry.summary,
        updatedAt: entry.updatedAt,
        sourcePath: entry.sourcePath,
      })),
    };
    await fs.writeFile(path.join(this.rootPath, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(this.rootPath, 'index.md'), renderReadableIndex(index, this.entries), 'utf8');
  }

  private feedbackFrom(
    ids: string[],
    input: DebugWikiResolutionInput,
    now: string,
    kind: DebugWikiFeedback['kind'],
    reason?: string,
  ): DebugWikiFeedback[] {
    return dedup(ids).filter((id) => this.byId(id)).map((id) => ({
      at: now,
      kind,
      entryId: id,
      ticketId: input.ticketId,
      stepId: input.stepId,
      phase: input.phase,
      summary: input.brief.summary,
      reason,
    }));
  }

  private rank(brief: DebugBrief, language?: string): DebugWikiMatch[] {
    const queryTokens = new Set(tokensForBrief(brief));
    const queryFingerprints = fingerprints(brief);
    return this.entries
      .filter((entry) => entry.status !== 'superseded')
      .map((entry) => {
        const reasons: string[] = [];
        let score = entry.layer === 'agent' ? 1 : entry.layer === 'system' ? 0.5 : 0;
        if (entry.category === brief.category) {
          score += 4;
          reasons.push(`category:${entry.category}`);
        }
        if (language && entry.language === language) score += 1;
        const exact = entry.fingerprints.filter((fp) => queryFingerprints.includes(fp));
        if (exact.length > 0) {
          score += exact.length * 3;
          reasons.push(`fingerprint:${exact.length}`);
        }
        const entryTokens = new Set(tokensForEntry(entry));
        let overlap = 0;
        for (const token of queryTokens) if (entryTokens.has(token)) overlap++;
        score += Math.min(6, overlap);
        if (overlap > 0) reasons.push(`tokens:${overlap}`);
        const confidence = confidenceFor(entry);
        return { entry, score: score * confidence, confidence, reasons };
      })
      .sort((a, b) => b.score - a.score);
  }

  private byId(id?: string): DebugWikiEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  private byIds(ids: string[]): DebugWikiEntry[] {
    const wanted = new Set(ids);
    return this.entries.filter((entry) => wanted.has(entry.id));
  }

  private layerDir(layer: DebugWikiLayer): string {
    return path.join(this.rootPath, 'wiki', layer);
  }

  private feedbackPath(): string {
    return path.join(this.rootPath, 'wiki', 'external', 'feedback.jsonl');
  }

  private operationLogPath(): string {
    return path.join(this.rootPath, 'log.md');
  }

  private nextExternalId(now: string): string {
    const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14);
    const count = this.entries.filter((entry) => entry.layer === 'external').length + 1;
    return `external.${stamp}.${String(count).padStart(4, '0')}`;
  }

  private externalEntryPath(entry: DebugWikiEntry): string {
    return path.join('wiki', 'external', `${slugify(entry.id)}.md`);
  }
}

export function renderDebugWikiMatchesForPrompt(matches: DebugWikiMatch[]): string {
  if (matches.length === 0) return '';
  const lines = [
    '## debug wiki matches',
    'LLM-wiki layered retrieval. Treat entries as hypotheses, verify against current files/tests, and stop using any entry that current evidence disproves.',
  ];
  for (const match of matches) {
    const entry = match.entry;
    lines.push(
      `- ${entry.id} layer=${entry.layer} score=${match.score.toFixed(2)} confidence=${match.confidence.toFixed(2)} status=${entry.status}`,
      `  problem: [${entry.category}] ${entry.summary}`,
      `  symptoms: ${entry.symptoms.slice(0, 4).join(' | ') || entry.primaryError}`,
      entry.resolutionPlan ? `  priorPlan: ${entry.resolutionPlan}` : '',
      `  confirmedSolution: ${entry.solution}`,
      `  feedback: uses=${entry.stats.uses} successes=${entry.stats.successes} failures=${entry.stats.failures}`,
    );
    if (entry.repairFiles?.length) lines.push(`  repairFiles: ${entry.repairFiles.join(', ')}`);
    if (entry.supersedes?.length) lines.push(`  supersedes: ${entry.supersedes.join(', ')}`);
    if (match.reasons.length) lines.push(`  matchedBy: ${match.reasons.join(', ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

function createEntry(input: DebugWikiResolutionInput, now: string, id: string, layer: DebugWikiLayer): DebugWikiEntry {
  return normalizeEntry({
    id,
    layer,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    category: input.brief.category,
    summary: input.brief.summary,
    primaryError: input.brief.primaryError,
    debugDemand: input.brief.debugDemand,
    fingerprints: fingerprints(input.brief),
    symptoms: input.brief.evidence.slice(0, 12),
    resolutionPlan: input.resolutionPlan?.trim(),
    solution: input.solution,
    evidence: (input.evidence ?? input.brief.evidence).slice(0, 12),
    sourceTicketId: input.ticketId,
    sourceStepId: input.stepId,
    sourcePhase: input.phase,
    targetPhase: input.targetPhase,
    language: input.language,
    repairFiles: input.repairFiles?.slice(0, 12),
    stats: { uses: 0, successes: 1, failures: 0 },
    feedback: [{ at: now, kind: 'success', entryId: id, ticketId: input.ticketId, stepId: input.stepId, phase: input.phase, summary: input.brief.summary }],
  }, layer);
}

function normalizeEntry(raw: Partial<DebugWikiEntry>, layer: DebugWikiLayer): DebugWikiEntry {
  const now = new Date().toISOString();
  return {
    id: String(raw.id ?? `${layer}.${slugify(raw.summary ?? raw.primaryError ?? 'entry')}`),
    layer: raw.layer ?? layer,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
    status: raw.status ?? 'active',
    category: raw.category ?? 'unknown',
    summary: raw.summary ?? raw.primaryError ?? 'Debug wiki entry',
    primaryError: raw.primaryError ?? raw.summary ?? '',
    debugDemand: raw.debugDemand ?? '',
    fingerprints: raw.fingerprints ?? [],
    symptoms: raw.symptoms ?? [],
    resolutionPlan: raw.resolutionPlan,
    solution: raw.solution ?? '',
    evidence: raw.evidence ?? [],
    sourceTicketId: raw.sourceTicketId,
    sourceStepId: raw.sourceStepId,
    sourcePhase: raw.sourcePhase,
    targetPhase: raw.targetPhase,
    language: raw.language,
    repairFiles: raw.repairFiles ?? [],
    supersedes: raw.supersedes ?? [],
    stats: { ...EMPTY_STATS, ...(raw.stats ?? {}) },
    lastUsedAt: raw.lastUsedAt,
    feedback: (raw.feedback ?? []).slice(-20),
    sourcePath: raw.sourcePath,
  };
}

function renderWikiPage(entry: DebugWikiEntry): string {
  const frontmatter = { ...entry, sourcePath: undefined };
  return [
    '---',
    YAML.stringify(frontmatter).trim(),
    '---',
    '',
    `# ${entry.summary}`,
    '',
    '## Problem',
    '',
    `- category: ${entry.category}`,
    `- status: ${entry.status}`,
    `- primaryError: ${entry.primaryError || 'n/a'}`,
    `- debugDemand: ${entry.debugDemand || 'n/a'}`,
    '',
    '## Resolution Plan',
    '',
    entry.resolutionPlan?.trim() || 'No explicit plan recorded.',
    '',
    '## Confirmed Solution',
    '',
    entry.solution.trim() || 'No confirmed solution recorded.',
    '',
    '## Evidence',
    '',
    renderMarkdownList(entry.evidence),
    '',
    '## Retrieval',
    '',
    `- fingerprints: ${entry.fingerprints.join(', ') || 'n/a'}`,
    `- repairFiles: ${(entry.repairFiles ?? []).join(', ') || 'n/a'}`,
    `- stats: uses=${entry.stats.uses} successes=${entry.stats.successes} failures=${entry.stats.failures}`,
    '',
    '## Feedback',
    '',
    renderMarkdownList(entry.feedback.slice(-8).map((item) => `${item.at} ${item.kind}: ${item.summary}`)),
    '',
  ].join('\n');
}

function parseWikiPage(text: string): { data: Partial<DebugWikiEntry>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
  if (!match) return { data: {}, body: text.trim() };
  return { data: (YAML.parse(match[1] ?? '') ?? {}) as Partial<DebugWikiEntry>, body: (match[2] ?? '').trim() };
}

function fingerprints(brief: DebugBrief): string[] {
  return dedup([
    `cat:${brief.category}`,
    brief.primaryError ? `err:${normalize(brief.primaryError)}` : '',
    ...brief.failedTests.map((test) => `test:${normalize(test)}`),
    ...brief.files.map((file) => `file:${normalize(file)}`),
    ...brief.statusCodes.map((code) => `http:${code}`),
  ]);
}

function tokensForBrief(brief: DebugBrief): string[] {
  return tokenize([brief.summary, brief.primaryError, brief.debugDemand, ...brief.failedTests, ...brief.files, ...brief.evidence, ...brief.statusCodes].join(' '));
}

function tokensForEntry(entry: DebugWikiEntry): string[] {
  return tokenize([entry.id, entry.summary, entry.primaryError, entry.debugDemand, entry.resolutionPlan ?? '', entry.solution, ...entry.symptoms, ...entry.evidence, ...(entry.repairFiles ?? [])].join(' '));
}

function tokenize(text: string): string[] {
  return dedup(text.toLowerCase().split(/[^a-z0-9_./:-]+/u).filter((token) => token.length >= 3));
}

function normalize(text: string): string {
  return tokenize(text).slice(0, 24).join(' ');
}

function renderReadableIndex(index: DebugWikiIndex, entries: DebugWikiEntry[]): string {
  const lines = [
    '# XCompiler Debug Wiki Index',
    '',
    `Updated: ${index.updatedAt}`,
    '',
    'This file is regenerated from wiki pages and feedback overlays. Edit knowledge pages under `wiki/`, not this index.',
    '',
    '## Layers',
    '',
    '| Layer | Entries | Writable | Purpose |',
    '| --- | ---: | --- | --- |',
  ];
  for (const layer of LAYERS) {
    const info = index.layers[layer];
    lines.push(`| ${layer} | ${info.entries} | ${info.writable ? 'yes' : 'no'} | ${layerPurpose(layer)} |`);
  }
  for (const layer of LAYERS) {
    const layerEntries = entries.filter((entry) => entry.layer === layer);
    lines.push('', `## ${layer}`, '');
    if (layerEntries.length === 0) {
      lines.push('No entries.');
      continue;
    }
    lines.push('| ID | Status | Category | Summary | Source |', '| --- | --- | --- | --- | --- |');
    for (const entry of layerEntries) {
      const source = entry.sourcePath ? `[${entry.sourcePath}](${entry.sourcePath})` : '';
      lines.push(`| ${escapeTable(entry.id)} | ${entry.status} | ${entry.category} | ${escapeTable(entry.summary)} | ${source} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderOperationLogEntry(entry: DebugWikiOperationLogEntry): string {
  const lines = [
    '',
    `- ${entry.at} ${entry.action}: ${entry.entryIds.join(', ') || 'none'}`,
    `  - ticket: ${entry.ticketId ?? 'n/a'}; step: ${entry.stepId ?? 'n/a'}; phase: ${entry.phase ?? 'n/a'}`,
    `  - summary: ${entry.summary}`,
  ];
  if (entry.reason) lines.push(`  - reason: ${entry.reason}`);
  return `${lines.join('\n')}\n`;
}

function defaultDebugWikiReadme(): string {
  return [
    '# XCompiler Debug Wiki',
    '',
    'This directory is an LLM-wiki style knowledge base for Debugger repair.',
    '',
    '- `wiki/system/` contains system-level debug policies and safety rules.',
    '- `wiki/agent/` contains agent-level calibration knowledge derived from recurring LLM failure patterns.',
    '- `wiki/external/` stores resolved bug-ticket knowledge and feedback.',
    '- `index.md` is a human-readable regenerated catalog.',
    '- `index.json` is the machine-readable retrieval cache.',
    '- `log.md` is an append-only operational log.',
    '',
  ].join('\n');
}

function layerPurpose(layer: DebugWikiLayer): string {
  switch (layer) {
    case 'system':
      return 'bundled system debug policies';
    case 'agent':
      return 'bundled agent calibration knowledge';
    case 'external':
      return 'local project bug-ticket resolutions';
  }
}

function renderMarkdownList(items: string[]): string {
  const compact = items.map((item) => item.trim()).filter(Boolean);
  if (compact.length === 0) return '- n/a';
  return compact.map((item) => `- ${item}`).join('\n');
}

function escapeTable(text: string): string {
  return text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function transitionDebugWikiEntry(
  entry: DebugWikiEntry,
  next: DebugWikiEntryStatus,
): boolean {
  const changed = assertStateTransition(
    'debug wiki entry',
    entry.id,
    entry.status,
    next,
    DEBUG_WIKI_STATUS_TRANSITIONS,
  );
  if (!changed) return false;
  entry.status = next;
  return true;
}

function confidenceFor(entry: DebugWikiEntry): number {
  const total = entry.stats.uses + entry.stats.successes + entry.stats.failures;
  const base = (entry.stats.successes + 1) / Math.max(2, total + 2);
  const statusFactor = entry.status === 'needs_review' ? 0.45 : 1;
  const layerFactor = entry.layer === 'system' ? 0.9 : 1;
  return Math.max(0.1, Math.min(1, base * statusFactor * layerFactor));
}

function mergeSolution(previous: string, next: string): string {
  const trimmed = next.trim();
  if (!trimmed || previous.includes(trimmed)) return previous;
  if (!previous.trim()) return trimmed;
  return `${previous.trim()}\nCorrected/confirmed resolution: ${trimmed}`;
}

function pushFeedback(entry: DebugWikiEntry, feedback: DebugWikiFeedback): void {
  entry.feedback.push(feedback);
  if (entry.feedback.length > 20) entry.feedback.splice(0, entry.feedback.length - 20);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 96) || 'entry';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items.filter((item) => String(item ?? '').length > 0))];
}
