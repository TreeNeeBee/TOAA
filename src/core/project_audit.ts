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
  type DeliveryGateScene,
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
  for (const scenario of scenarios) {
    const operation = () => runScenarioAudit(opts.sandbox, scenario);
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
          summary: `Required delivery document is missing: ${doc}`,
          evidence: [`Phase audit could not find ${doc}.`],
          target: 'current-step' as const,
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
      summary: 'The delivered project contains no executable test files.',
      evidence: ['Phase audit found no Python or TypeScript tests under tests/.'],
      target: 'paired-source',
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
      summary: `Entrypoint smoke check failed: ${probe.command}`,
      evidence: [tailText(probe.stderrTail || probe.stdoutTail) || `exit=${probe.exitCode}`],
      target: 'code',
      dependencyPackages: [],
    },
  };
}

async function runScenarioAudit(
  sandbox: Sandbox,
  scenario: DeliveryGateScenario,
): Promise<ProjectAuditCheck> {
  const capturedAt = new Date().toISOString();
  const execution = scenario.execution;
  if (!execution) {
    throw new Error(`Phase delivery scenario ${scenario.name} has no concrete execution command`);
  }
  const result = await sandbox.exec(execution.command, execution.args, { timeoutMs: 120_000 });
  const probe = {
    ok: result.exitCode === 0 && !result.timedOut && !detectNetworkApiFailureInExec(result),
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
  if (probe.ok) {
    return {
      name: `scenario:${scenario.name}`,
      severity: 'info',
      ok: true,
      summary: t().execute.auditEntrypointOk(probe.command),
      scene,
    };
  }
  const sceneEvidence = renderSceneEvidence(scene);
  return {
    name: `scenario:${scenario.name}`,
    severity: 'error',
    ok: false,
    summary: t().execute.auditEntrypointFailed(probe.command),
    detail: sceneEvidence.join('\n'),
    scene,
    finding: {
      category: 'product-defect',
      summary: `Real entrypoint scenario failed: ${probe.command}`,
      evidence: sceneEvidence,
      target: 'code',
      dependencyPackages: [],
      scene,
    },
  };
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
        summary: 'TypeScript delivery is missing package.json.',
        evidence: ['Phase audit could not load package.json.'],
        target: 'high-level-design',
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
      summary: `${name} delivery check failed.`,
      evidence: [tailText(result.stderr || result.stdout) || `exit=${result.exitCode}`],
      target: 'code',
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
