import type { LLMRouter } from '../../llm/router.js';
import type {
  DeliveryGateScene,
  DeliveryGateScenario,
  ScenarioOutcomeVerdict,
} from '../../domain/quality/delivery_gate.js';

/** What the workspace held before the scenario ran, so its own output can be told apart. */
export interface ScenarioArtifactSnapshot {
  path: string;
  mtimeMs: number;
}

export interface ScenarioArtifactReader {
  /** Every tracked path with its modification time. */
  snapshot(): Promise<ScenarioArtifactSnapshot[]>;
  /** The text of one produced artifact, bounded by the caller. */
  read(path: string, maxBytes: number): Promise<string | undefined>;
}

/**
 * Who judges the outcome.
 *
 * The finding this produces is routed through PM's problem-intake boundary, but PM is a domain
 * actor and not one of the configured LLM roles — naming a new role here would make every existing
 * configuration fail at the gate with `provider_not_configured`. `Planner` is the role that wrote
 * the expectation being judged, which makes it the closest reader of it. One line to change if a
 * ProjectManager role is later configured.
 */
const SCENARIO_JUDGE_ROLE = 'Planner' as const;

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
}): Promise<ScenarioOutcomeVerdict> {
  const produced = await producedArtifacts(input.artifacts, input.before);
  const evidence: string[] = [];
  if (input.scene.stdoutTail) {
    evidence.push(`stdout:\n${truncate(input.scene.stdoutTail, MAX_STREAM_CHARS)}`);
  }
  if (input.scene.stderrTail) {
    evidence.push(`stderr:\n${truncate(input.scene.stderrTail, MAX_STREAM_CHARS)}`);
  }
  for (const artifact of produced) {
    evidence.push(`artifact ${artifact.path}:\n${artifact.content}`);
  }

  // Nothing observable means nothing to judge. Reporting a defect here would accuse the project of
  // a fault this function cannot see, and a scenario whose result leaves no trace is a gap in the
  // scenario, not in the product.
  if (evidence.length === 0) {
    return { ok: true, reason: 'the scenario left no observable result to judge', evidence: [] };
  }

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
        'Answer with JSON only: {"ok": boolean, "reason": string}.',
        'Keep `reason` to one sentence naming the concrete discrepancy.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Expectation: ${input.scenario.expected}`,
        `Operation: ${input.scenario.operation}`,
        '',
        'Evidence:',
        ...evidence,
      ].join('\n'),
    },
  ]);

  const verdict = parseVerdict(answer);
  // An unreadable judgement is not a defect in the project. Failing delivery on it would turn a
  // model hiccup into a Bug against work that may be correct.
  if (!verdict) {
    return { ok: true, reason: 'scenario outcome could not be judged', evidence: [] };
  }
  return { ...verdict, evidence: verdict.ok ? [] : evidence };
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

function parseVerdict(answer: string): { ok: boolean; reason: string } | undefined {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(answer.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as { ok?: unknown; reason?: unknown };
    if (typeof value.ok !== 'boolean') return undefined;
    return {
      ok: value.ok,
      reason: typeof value.reason === 'string' && value.reason.trim().length > 0
        ? value.reason.trim()
        : 'the produced result does not meet the declared expectation',
    };
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}
