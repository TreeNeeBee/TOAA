import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Sandbox, ExecResult } from '../sandbox/types.js';
import type { Plan, ProjectType } from './plan.js';
import type { LanguageProfile } from './language.js';
import { deliveryDocsForIteration, deliveryDocsForProjectType } from './docs.js';
import { t } from '../i18n/index.js';
import { detectNetworkApiFailureInExec } from './network_api_gate.js';
import {
  type DeliveryGateFinding,
  type DeliveryGateScenario,
  type ScenarioOutcomeJudge,
  type DeliveryGateScene,
  type ScenarioOutcomeVerdict,
  type ScenarioRepairTarget,
  type ScenarioArtifactSnapshot,
} from '../domain/quality/delivery_gate.js';

export interface ProjectAuditCheck {
  name: string;
  severity: 'error' | 'warn' | 'info';
  ok: boolean;
  summary: string;
  detail?: string;
  /** Structured PM-routing input when this check fails. */
  finding?: DeliveryGateFinding;
  /** Captured real-user execution scene for audit and later PM intake. */
  scene?: DeliveryGateScene;
}

export interface ProjectAuditResult {
  ok: boolean;
  warnings: number;
  errors: number;
  checks: ProjectAuditCheck[];
  scope?: 'project' | 'iteration';
  iterationId?: string;
}

export function renderProjectAuditFailureLog(result: ProjectAuditResult): string {
  const failed = result.checks.filter((check) => !check.ok);
  const interesting = failed.length > 0 ? failed : result.checks;
  const scope = result.scope === 'iteration' && result.iterationId
    ? `Iteration gate ${result.iterationId}`
    : 'Project audit';
  return [
    `${scope} failed: ${result.errors} error(s), ${result.warnings} warning(s).`,
    ...interesting.map((check) =>
      [
        `[${check.severity}] ${check.name}: ${check.summary}`,
        check.detail ? `detail:\n${check.detail}` : '',
      ].filter(Boolean).join('\n'),
    ),
  ].join('\n\n');
}

export function shouldRunProjectAudit(
  opts: { onlyPhase?: string },
  allStageFeaturesComplete: boolean,
): boolean {
  return !opts.onlyPhase && allStageFeaturesComplete;
}

export async function runProjectAudit(opts: {
  ws: Workspace;
  sandbox: Sandbox;
  plan: Plan;
  profile: LanguageProfile;
  scenarios?: readonly DeliveryGateScenario[];
  runLiveScenario?: <T>(operation: () => Promise<T>) => Promise<T>;
  judgeScenarioOutcome?: ScenarioOutcomeJudge;
  /** The workspace as it stands right now, called once before each scenario runs. */
  snapshotArtifacts?: () => Promise<ScenarioArtifactSnapshot[]>;
}): Promise<ProjectAuditResult> {
  return runQualityAudit({ ...opts, scope: 'project' });
}

export async function runIterationGate(opts: {
  ws: Workspace;
  sandbox: Sandbox;
  plan: Plan;
  profile: LanguageProfile;
  iterationId: string;
}): Promise<ProjectAuditResult> {
  return runQualityAudit({ ...opts, scope: 'iteration', iterationId: opts.iterationId });
}

async function runQualityAudit(opts: {
  ws: Workspace;
  sandbox: Sandbox;
  plan: Plan;
  profile: LanguageProfile;
  scope: 'project' | 'iteration';
  iterationId?: string;
  scenarios?: readonly DeliveryGateScenario[];
  runLiveScenario?: <T>(operation: () => Promise<T>) => Promise<T>;
  judgeScenarioOutcome?: ScenarioOutcomeJudge;
  /** The workspace as it stands right now, called once before each scenario runs. */
  snapshotArtifacts?: () => Promise<ScenarioArtifactSnapshot[]>;
}): Promise<ProjectAuditResult> {
  const checks: ProjectAuditCheck[] = [];

  checks.push(
    ...await checkDocumentationBundle(
      opts.ws,
      opts.plan.projectType ?? 'application',
      opts.scope === 'iteration' ? opts.iterationId : undefined,
    ),
  );
  checks.push(await checkTestFiles(opts.ws));
  checks.push(await runTestAudit(opts.sandbox));
  checks.push(await runEntrypointAudit(opts.ws, opts.sandbox, opts.profile));

  const scenarios = opts.scenarios ?? [];
  if (scenarios.length > 0 && !opts.judgeScenarioOutcome) {
    throw new Error('Phase delivery scenarios require an LLM outcome judge');
  }
  for (const scenario of scenarios) {
    // Taken here rather than once for the Phase: the test and entrypoint checks above already
    // touched files, and each scenario changes files the next would otherwise inherit. A snapshot
    // from before all of that credits every one of those changes to whichever scenario is judged.
    const before = (await opts.snapshotArtifacts?.()) ?? [];
    const operation = () => runScenarioAudit(opts.sandbox, scenario, before, opts.judgeScenarioOutcome);
    checks.push(await (opts.runLiveScenario ? opts.runLiveScenario(operation) : operation()));
  }

  if (opts.plan.language === 'typescript') {
    checks.push(...await runTypeScriptAudit(opts.ws, opts.sandbox));
  }

  const warnings = checks.filter((check) => check.severity === 'warn' && !check.ok).length;
  const errors = checks.filter((check) => check.severity === 'error' && !check.ok).length;
  return { ok: errors === 0, warnings, errors, checks, scope: opts.scope, iterationId: opts.iterationId };
}

async function checkDocumentationBundle(
  ws: Workspace,
  projectType: ProjectType,
  iterationId?: string,
): Promise<ProjectAuditCheck[]> {
  const docs = iterationId
    ? deliveryDocsForIteration(projectType, iterationId)
    : deliveryDocsForProjectType(projectType);
  const checks: ProjectAuditCheck[] = [];
  for (const doc of docs) {
    const exists = await ws.exists(doc);
    checks.push({
      name: docCheckName(doc),
      severity: exists ? 'info' : 'error',
      ok: exists,
      summary: exists ? t().execute.auditDocPresent(doc) : t().execute.auditDocMissing(doc),
      ...(!exists ? {
        finding: {
          category: 'deliverable-defect' as const,
          code: 'required_delivery_document_missing',
          summary: `Required delivery document is missing: ${doc}`,
          evidence: [`Phase audit could not find ${doc}.`],
          target: 'current-step' as const,
          affectedArtifacts: [doc],
          dependencyPackages: [],
        },
      } : {}),
    });
  }
  return checks;
}

function docCheckName(pathName: string): string {
  if (pathName === 'README.md') return 'readme';
  if (pathName === 'docs/quickstart.md') return 'quickstart';
  if (pathName === 'docs/api-guide.md') return 'api-guide';
  if (pathName === 'docs/08-functional-test.md') return 'functional-test-doc';
  return `doc:${pathName}`;
}

async function checkTestFiles(ws: Workspace): Promise<ProjectAuditCheck> {
  const files = await listFiles(ws, 'tests');
  const concreteTests = files.filter((file) =>
    /(?:\.(?:test|spec)\.ts|\/(?:test_[^/]+|test)\.py)$/u.test(file),
  );
  if (concreteTests.length > 0) {
    return {
      name: 'test-files',
      severity: 'info',
      ok: true,
      summary: t().execute.auditTestFilesFound(concreteTests.length),
    };
  }
  return {
    name: 'test-files',
    severity: 'error',
    ok: false,
    summary: t().execute.auditTestFilesMissing,
    finding: {
      category: 'test-incomplete',
      code: 'executable_test_assets_missing',
      summary: 'The delivered project contains no executable test files.',
      evidence: ['Phase audit found no Python or TypeScript tests under tests/.'],
      target: 'paired-source',
      affectedArtifacts: ['tests/'],
      dependencyPackages: [],
    },
  };
}

async function runTestAudit(sandbox: Sandbox): Promise<ProjectAuditCheck> {
  const result = await sandbox.runTests([], { timeoutMs: 120_000 });
  return toExecCheck('tests', result, 'error');
}

async function runEntrypointAudit(
  ws: Workspace,
  sandbox: Sandbox,
  profile: LanguageProfile,
): Promise<ProjectAuditCheck> {
  const probe = await profile.probeEntry(ws, sandbox);
  if (probe.ok) {
    return {
      name: 'entrypoint',
      severity: 'info',
      ok: true,
      summary: t().execute.auditEntrypointOk(probe.command),
    };
  }
  return {
    name: 'entrypoint',
    severity: 'error',
    ok: false,
    summary: t().execute.auditEntrypointFailed(probe.command),
    detail: tailText(probe.stderrTail || probe.stdoutTail),
    finding: {
      category: 'product-defect',
      code: 'entrypoint_smoke_failed',
      summary: `Entrypoint smoke check failed: ${probe.command}`,
      evidence: [tailText(probe.stderrTail || probe.stdoutTail) || `exit=${probe.exitCode}`],
      target: 'code',
      affectedArtifacts: ['src/'],
      dependencyPackages: [],
    },
  };
}

async function runScenarioAudit(
  sandbox: Sandbox,
  scenario: DeliveryGateScenario,
  before: readonly ScenarioArtifactSnapshot[],
  judge?: ScenarioOutcomeJudge,
): Promise<ProjectAuditCheck> {
  const capturedAt = new Date().toISOString();
  const execution = scenario.execution;
  if (!execution) {
    throw new Error(`Phase delivery scenario ${scenario.name} has no concrete execution command`);
  }
  const result = await sandbox.exec(execution.command, execution.args, { timeoutMs: 120_000 });
  const probe = {
    // The process result, and nothing read out of its text. Network-failure wording in the output is
    // evidence for the judge, not a verdict: a run that degrades gracefully prints the source it lost
    // and still satisfies an expectation asking for two of them. Deciding `ok` from that text made
    // the judge's agreement an error, and the branch below turns disagreement into a thrown run.
    ok: result.exitCode === 0 && !result.timedOut,
    command: [execution.command, ...execution.args].join(' '),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutTail: tailText(result.stdout),
    stderrTail: tailText(result.stderr),
  };
  const scene: DeliveryGateScene = {
    scenario,
    capturedAt,
    command: probe.command,
    exitCode: probe.exitCode,
    timedOut: probe.timedOut,
    ...(probe.stdoutTail ? { stdoutTail: tailText(probe.stdoutTail) } : {}),
    ...(probe.stderrTail ? { stderrTail: tailText(probe.stderrTail) } : {}),
  };
  // A non-zero process result still contains routing evidence. The old branch returned before the
  // scenario judge ran, so every failed command became a CODE Bug even when satisfying the original
  // expectation required an accepted contract/capability change. The verdict may not turn a failed
  // process into a pass; it only identifies the Ticket type and owner of the observed failure.
  if (!judge) throw new Error(`Scenario ${scenario.name} has no outcome judge`);
  const verdict = await judge({ scenario, scene, before });
  if (probe.ok) {
    // Exiting zero answers a narrower question than the gate asks. The scenario states what the run
    // was supposed to produce; until something reads that, a project can pass delivery having done
    // the wrong thing successfully.
    if (verdict.ok) {
      return {
        name: `scenario:${scenario.name}`,
        severity: 'info',
        ok: true,
        summary: t().execute.auditEntrypointOk(probe.command),
        scene,
      };
    }
    return {
      name: `scenario:${scenario.name}`,
      severity: 'error',
      ok: false,
      summary: `Real scenario ran but its result does not meet the declared expectation: ${probe.command}`,
      detail: [verdict.reason, ...verdict.evidence].join('\n'),
      scene,
      finding: {
        ...scenarioFindingDisposition(verdict),
        code: scenarioFindingCode('scenario_expectation_failed', scenario.name, verdict),
        summary: `Scenario ${scenario.name} produced a result that does not meet its expectation: ${verdict.reason}`,
        evidence: [`expected: ${scenario.expected}`, ...verdict.evidence],
        // The LLM supplies ownership from the accepted contract and observed result. No protocol,
        // status code, service, or project-specific matcher decides this route.
        ...scenarioFindingTarget(verdict.target),
        dependencyPackages: [],
      },
    };
  }
  if (verdict.ok) {
    throw new Error(
      `Scenario ${scenario.name} exited unsuccessfully but its outcome judge returned ok=true`,
    );
  }
  const sceneEvidence = [
    ...renderSceneEvidence(scene),
    `judgement=${verdict.reason}`,
    ...verdict.evidence,
  ];
  return {
    name: `scenario:${scenario.name}`,
    severity: 'error',
    ok: false,
    summary: t().execute.auditEntrypointFailed(probe.command),
    detail: sceneEvidence.join('\n'),
    scene,
    finding: {
      ...scenarioFindingDisposition(verdict),
      code: scenarioFindingCode('scenario_execution_failed', scenario.name, verdict),
      summary: `Real entrypoint scenario failed: ${probe.command}`,
      evidence: sceneEvidence,
      ...scenarioFindingTarget(verdict.target),
      dependencyPackages: [],
      scene,
    },
  };
}

function scenarioFindingCode(
  prefix: 'scenario_execution_failed' | 'scenario_expectation_failed',
  name: string,
  verdict: Extract<ScenarioOutcomeVerdict, { ok: false }>,
): string {
  return verdict.ticketType === 'change-request'
    ? `${prefix}:${name}:change-request:${verdict.target}`
    : `${prefix}:${name}`;
}

function scenarioFindingDisposition(
  verdict: Extract<ScenarioOutcomeVerdict, { ok: false }>,
): { category: 'product-defect' | 'change-request' } {
  return { category: verdict.ticketType === 'change-request' ? 'change-request' : 'product-defect' };
}

/**
 * The Step a scenario failure is routed to, and the artifacts its repair may touch.
 *
 * The artifact list follows the target rather than staying at `src/`: a Step is offered the files it
 * owns, and naming another Step's outputs narrows its allowlist to nothing it can write.
 */
function scenarioFindingTarget(
  target: ScenarioRepairTarget,
): { target: DeliveryGateFinding['target']; affectedArtifacts: string[] } {
  switch (target) {
    case 'high-level-design':
      return { target: 'high-level-design', affectedArtifacts: ['docs/02-high-level-design.md'] };
    case 'requirement-analysis':
      return { target: 'requirement-analysis', affectedArtifacts: ['docs/01-requirement-analysis.md'] };
    case 'detailed-design':
      return { target: 'detailed-design', affectedArtifacts: ['docs/03-detailed-design.md'] };
    default:
      return { target: 'code', affectedArtifacts: ['src/'] };
  }
}

function renderSceneEvidence(scene: DeliveryGateScene): string[] {
  return [
    `scenario=${scene.scenario.name}`,
    `operation=${scene.scenario.operation}`,
    `environment=${scene.scenario.environment}`,
    `expected=${scene.scenario.expected}`,
    `command=${scene.command}`,
    `capturedAt=${scene.capturedAt}`,
    `exit=${scene.exitCode}; timedOut=${scene.timedOut}`,
    ...(scene.stderrTail ? [`stderr:\n${scene.stderrTail}`] : []),
    ...(scene.stdoutTail ? [`stdout:\n${scene.stdoutTail}`] : []),
  ];
}

async function runTypeScriptAudit(ws: Workspace, sandbox: Sandbox): Promise<ProjectAuditCheck[]> {
  const pkg = await readPackageJson(ws);
  if (!pkg) {
    return [{
      name: 'package-json',
      severity: 'error',
      ok: false,
      summary: t().execute.auditPackageJsonMissing,
      finding: {
        category: 'deliverable-defect',
        code: 'typescript_package_manifest_missing',
        summary: 'TypeScript delivery is missing package.json.',
        evidence: ['Phase audit could not load package.json.'],
        target: 'high-level-design',
        affectedArtifacts: ['package.json'],
        dependencyPackages: [],
      },
    }];
  }
  const scripts =
    pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const checks: ProjectAuditCheck[] = [];
  if (typeof scripts.build === 'string' && scripts.build.trim()) {
    const result = await sandbox.exec('npm', ['run', '--silent', 'build'], { timeoutMs: 120_000 });
    checks.push(toExecCheck('build', result, 'error'));
  } else {
    checks.push({
      name: 'build-script',
      severity: 'warn',
      ok: false,
      summary: t().execute.auditScriptMissing('build'),
    });
  }
  if (typeof scripts.lint === 'string' && scripts.lint.trim()) {
    const result = await sandbox.exec('npm', ['run', '--silent', 'lint'], { timeoutMs: 120_000 });
    checks.push(toExecCheck('lint', result, 'warn'));
  } else {
    checks.push({
      name: 'lint-script',
      severity: 'warn',
      ok: false,
      summary: t().execute.auditScriptMissing('lint'),
    });
  }
  return checks;
}

function toExecCheck(
  name: string,
  result: ExecResult,
  severity: 'error' | 'warn',
): ProjectAuditCheck {
  const networkFailure = detectNetworkApiFailureInExec(result);
  if (result.exitCode === 0 && !result.timedOut && !networkFailure) {
    return {
      name,
      severity: 'info',
      ok: true,
      summary: t().execute.auditCommandOk(name),
    };
  }
  return {
    name,
    severity,
    ok: false,
    summary: networkFailure
      ? `${name} failed: ${networkFailure.message}`
      : t().execute.auditCommandFailed(name, result.exitCode, result.timedOut),
    detail: networkFailure
      ? tailText(`${networkFailure.evidence}\n${result.stderr}\n${result.stdout}`)
      : tailText(result.stderr || result.stdout),
    finding: {
      category: 'product-defect',
      code: `delivery_check_failed:${name}`,
      summary: `${name} delivery check failed.`,
      evidence: [tailText(result.stderr || result.stdout) || `exit=${result.exitCode}`],
      target: 'code',
      affectedArtifacts: ['src/'],
      dependencyPackages: [],
    },
  };
}

async function readPackageJson(ws: Workspace): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await ws.readFile('package.json')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listFiles(ws: Workspace, dir: string): Promise<string[]> {
  const root = ws.abs(dir);
  const out: string[] = [];
  await walk(root, dir, out);
  return out;
}

async function walk(abs: string, rel: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRel = `${rel}/${entry.name}`;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      await walk(childAbs, childRel, out);
    } else {
      out.push(childRel);
    }
  }
}

function tailText(text: string): string {
  return text.split('\n').slice(-20).join('\n').trim();
}
