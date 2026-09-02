import type { LLMRouter } from '../../llm/router.js';
import type {
  DeliveryGateScene,
  DeliveryGateScenario,
  ScenarioOutcomeVerdict,
} from '../../domain/quality/delivery_gate.js';
import {
  type ScenarioArtifactSnapshot,
  SCENARIO_REPAIR_TARGETS,
  SCENARIO_TICKET_TYPES,
} from '../../domain/quality/delivery_gate.js';

/** What the workspace held before the scenario ran, so its own output can be told apart. */
export type { ScenarioArtifactSnapshot } from '../../domain/quality/delivery_gate.js';

export interface ScenarioArtifactReader {
  /** Every tracked path with its modification time. */
  snapshot(): Promise<ScenarioArtifactSnapshot[]>;
  /** The text of one produced artifact, bounded by the caller. */
  read(path: string, maxBytes: number): Promise<string | undefined>;
}

/**
 * Who judges the outcome.
 *
 * PM, because the question is whether the project got what it asked for — and no role that executed
 * the work should answer that about its own output. The finding this produces is routed through
 * PM's problem-intake boundary, so judgement and routing now name the same owner.
 */
const SCENARIO_JUDGE_ROLE = 'ProjectManager' as const;

const MAX_ARTIFACTS = 3;
const MAX_ARTIFACT_BYTES = 4_000;
const MAX_STREAM_CHARS = 2_000;

/**
 * Decides whether what a scenario produced meets what the scenario said to expect.
 *
 * Kept free of any project vocabulary. The only statement of what "correct" means is the
 * scenario's own `expected`, written when the Phase was planned; the only evidence is what the run
 * printed and the files it changed. A scraper, a compiler, a migration, and a report generator all
 * arrive here as the same three things — an expectation, some output, and some artifacts — which is
 * what lets one rule serve every kind of project.
 *
 * Artifacts are found by difference rather than by name: whatever the scenario touched is what the
 * scenario produced. Nothing here knows that a briefing is Markdown or that output lives in
 * `output/`, and nothing should.
 */
export async function judgeScenarioOutcome(input: {
  router: LLMRouter;
  artifacts?: ScenarioArtifactReader;
  before: readonly ScenarioArtifactSnapshot[];
  scenario: DeliveryGateScenario;
  scene: DeliveryGateScene;
  /** Project framing needed to distinguish a broken implementation from an obsolete accepted contract. */
  requirementDigest?: string;
}): Promise<ScenarioOutcomeVerdict> {
  const produced = await producedArtifacts(input.artifacts, input.before);
  // What the run left behind, kept apart from how it ended: silence is a finding about the output,
  // and a process line would hide it by making the list never empty.
  const observations: string[] = [];
  if (input.scene.stdoutTail) {
    observations.push(`stdout:\n${truncate(input.scene.stdoutTail, MAX_STREAM_CHARS)}`);
  }
  if (input.scene.stderrTail) {
    observations.push(`stderr:\n${truncate(input.scene.stderrTail, MAX_STREAM_CHARS)}`);
  }
  for (const artifact of produced) {
    observations.push(`artifact ${artifact.path}:\n${artifact.content}`);
  }
  // Absence is evidence too. Whether silence is valid depends on the scenario expectation, so the
  // judge must decide it instead of Runtime silently treating an unobservable run as successful.
  if (observations.length === 0) {
    observations.push('No stdout, stderr, or changed text artifact was observed.');
  }
  // How the process ended, stated rather than implied. The judge is asked whether the run produced
  // what it was supposed to, and a non-zero exit or a timeout answers part of that already — it was
  // reading the output without being told either.
  const evidence = [
    input.scene.timedOut
      ? 'process: timed out before it finished'
      : `process: exited with code ${input.scene.exitCode}`,
    ...observations,
  ];

  const answer = await input.router.for(SCENARIO_JUDGE_ROLE).chat([
    {
      role: 'system',
      content: [
        'You decide whether a completed run produced what it was supposed to produce.',
        'You are given the expectation recorded when the work was planned, and the evidence the run',
        'left behind. Judge only against that expectation. Do not invent requirements, do not',
        'comment on style, and do not fail a run for anything the expectation does not ask for.',
        'Report a failure when the evidence contradicts the expectation, including when a required',
        'element is absent, duplicated, empty, or obviously wrong for the field it fills.',
        'When it failed, classify the work without relying on any particular protocol, status code,',
        'vendor, or project domain. Use ticketType="bug" when the accepted requirement and design',
        'remain valid and the implementation, configuration, or integration realizes them',
        'incorrectly. Use ticketType="change-request" when satisfying the expectation requires',
        'changing an accepted requirement, capability, external dependency, interface, data source,',
        'or design premise because the accepted one is no longer viable.',
        'Choose target by ownership: requirement-analysis for requirement/scope changes,',
        'high-level-design for system interfaces, external capabilities and dependency selection,',
        'detailed-design for internal module contracts, and code for implementation errors.',
        'An HTTP status, timeout, exception, or empty result is evidence only; it never determines',
        'ticketType or target by itself. Explain which accepted premise can remain or must change.',
        'If evidence is insufficient to prove a contract change, choose bug/code.',
        'Answer with JSON only:',
        '{"ok": boolean, "reason": string, "ticketType": "bug"|"change-request",',
        '"target": "requirement-analysis"|"high-level-design"|"detailed-design"|"code"}.',
        'Keep `reason` to one sentence naming the concrete discrepancy and ownership rationale.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        // The accepted framing tells the judge whether the implementation can satisfy the contract
        // as written or whether that contract/capability itself has to change.
        ...(input.requirementDigest ? [`Project statement: ${input.requirementDigest}`] : []),
        `Expectation: ${input.scenario.expected}`,
        `Operation: ${input.scenario.operation}`,
        '',
        'Evidence:',
        ...evidence,
      ].join('\n'),
    },
  ], { scoreSuccess: false });

  const verdict = parseVerdict(answer);
  // A malformed judgement is neither evidence that the project passed nor evidence for a Bug. Stop
  // the gate without manufacturing a product Ticket; the runtime/provider failure remains visible.
  if (!verdict) {
    throw new ScenarioOutcomeJudgementError(
      'Scenario outcome judgement must be valid JSON and classify every failure as bug or change-request',
    );
  }
  return verdict.ok
    ? { ok: true, reason: verdict.reason, evidence: [] }
    : { ...verdict, evidence };
}

async function producedArtifacts(
  reader: ScenarioArtifactReader | undefined,
  before: readonly ScenarioArtifactSnapshot[],
): Promise<Array<{ path: string; content: string }>> {
  if (!reader) return [];
  const previous = new Map(before.map((entry) => [entry.path, entry.mtimeMs]));
  const after = await reader.snapshot();
  const changed = after
    .filter((entry) => previous.get(entry.path) !== entry.mtimeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_ARTIFACTS);
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of changed) {
    const content = await reader.read(entry.path, MAX_ARTIFACT_BYTES);
    if (content !== undefined) out.push({ path: entry.path, content });
  }
  return out;
}

/** Whether a failure is the judge returning something unusable, rather than a verdict about the project. */
export function isScenarioOutcomeJudgementError(error: unknown): error is ScenarioOutcomeJudgementError {
  return error instanceof ScenarioOutcomeJudgementError;
}

export class ScenarioOutcomeJudgementError extends Error {
  readonly code = 'scenario_outcome_judgement_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ScenarioOutcomeJudgementError';
  }
}

function parseVerdict(answer: string): ScenarioOutcomeVerdict | undefined {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(answer.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as {
      ok?: unknown;
      reason?: unknown;
      ticketType?: unknown;
      target?: unknown;
    };
    if (typeof value.ok !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim()) {
      return undefined;
    }
    if (value.ok) return { ok: true, reason: value.reason.trim(), evidence: [] };
    const ticketType = SCENARIO_TICKET_TYPES.find((candidate) => candidate === value.ticketType);
    const target = SCENARIO_REPAIR_TARGETS.find((candidate) => candidate === value.target);
    if (!ticketType || !target) return undefined;
    return { ok: false, reason: value.reason.trim(), evidence: [], ticketType, target };
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}
