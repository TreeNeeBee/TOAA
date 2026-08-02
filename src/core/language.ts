import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import type { Sandbox } from '../sandbox/types.js';
import type { Language } from './plan.js';
import {
  autoFixSrcImports,
  ensurePyTestBootstrap,
  helpOutputLooksMeaningful,
  probeEntrypoint,
  type EntrypointProbe,
} from './entry_gate.js';
import { detectNetworkApiFailureInExec } from './network_api_gate.js';
import { t } from '../i18n/index.js';

/**
 * LanguageProfile：把"某种目标语言的工程化知识"集中到一处，
 * 让 sandbox / engine / lint / render / planner / executor 等都通过 profile 取用，
 * 而不是在各处硬编码 Python 的 venv / pip / pytest / requirements.txt 假设。
 *
 * 默认语言仍是 Python（完全向后兼容）；TypeScript 作为新 profile 接入。
 */
export interface LanguageProfile {
  readonly id: Language;
  readonly displayName: string;

  /** 依赖清单文件（相对 workspace 根）。python: requirements.txt；ts: package.json */
  readonly manifestFile: string;

  /** 源码/测试文件扩展名，用于 lint 阶段纯度检查与入口探测。 */
  readonly codeExtensions: string[];

  /**
   * 是否由 runtime（cli/execute）根据 plan.dependencies 生成 manifest。
   *  - Python：true —— 渲染器把依赖写入 requirements.txt，HIGH_LEVEL_DESIGN 不得直接产出该文件。
   *  - TypeScript：false —— package.json 由 HIGH_LEVEL_DESIGN 步骤撰写（含 scripts / devDependencies）。
   */
  readonly seedManifestFromDeps: boolean;

  /** 默认 Docker 镜像。 */
  readonly defaultDockerImage: string;

  /** 把依赖列表渲染为 manifest 文件内容（仅当 seedManifestFromDeps=true 时使用）。 */
  renderManifest(deps: string[]): string;

  /** 给 lint S004/S005 提示用：依据 CODE Step 的源码输出推导建议测试文件路径。 */
  testFileFor(srcOutput: string | undefined, stepId: string): string;

  /** 追加到 Planner system prompt 末尾的语言专属覆盖块（python 为空串）。 */
  readonly plannerPromptOverride: string;
  /** 追加到 Executor system prompt 末尾的语言专属覆盖块（python 为空串）。 */
  readonly executorPromptOverride: string;

  /** 测试/DEBUG 前置：确保测试可解析到源码（python 写 conftest.py；ts 无需）。 */
  ensureTestBootstrap?(ws: Workspace, audit: AuditLogger): Promise<void>;
  /** 通用兜底：修复入口 import 路径问题（python sys.path；ts 无需）。 */
  autoFixImports?(ws: Workspace, audit: AuditLogger): Promise<string[]>;
  /** FUNCTIONAL_TEST gate：探测入口 `--help` 是否开箱即用；缺失入口必须返回失败。 */
  probeEntry(ws: Workspace, sandbox: Sandbox): Promise<EntrypointProbe>;
}

const PY_TEST_RE = /\.py$/;

const pythonProfile: LanguageProfile = {
  id: 'python',
  displayName: 'Python',
  manifestFile: 'requirements.txt',
  codeExtensions: ['.py'],
  seedManifestFromDeps: true,
  defaultDockerImage: 'python:3.11-slim',
  renderManifest(deps) {
    return [...new Set(deps.map((d) => d.trim()).filter(Boolean))].sort().join('\n') + '\n';
  },
  testFileFor(srcOutput, stepId) {
    if (srcOutput && srcOutput.startsWith('src/') && PY_TEST_RE.test(srcOutput)) {
      const base = srcOutput.replace(/^src\//, '').replace(/\.py$/, '').replace(/\//g, '_');
      return `tests/test_${base}.py`;
    }
    return `tests/test_${stepId.toLowerCase()}.py`;
  },
  plannerPromptOverride: '',
  executorPromptOverride: '',
  async ensureTestBootstrap(ws, audit) {
    await ensurePyTestBootstrap(ws, audit);
  },
  async autoFixImports(ws, audit) {
    return autoFixSrcImports(ws, audit);
  },
  async probeEntry(ws, sandbox) {
    return probeEntrypoint(ws, sandbox);
  },
};

const typescriptProfile: LanguageProfile = {
  id: 'typescript',
  displayName: 'TypeScript',
  manifestFile: 'package.json',
  codeExtensions: ['.ts', '.tsx'],
  seedManifestFromDeps: false,
  defaultDockerImage: 'node:24-slim',
  renderManifest(deps) {
    const pkg = {
      name: 'app',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: { test: 'vitest run', start: 'tsx src/main.ts' },
      dependencies: Object.fromEntries(
        [...new Set(deps.map((d) => d.trim()).filter(Boolean))].sort().map((d) => [d, '*']),
      ),
      devDependencies: {
        vitest: '*',
        '@vitest/coverage-v8': '*',
        typescript: '*',
        tsx: '*',
        '@types/node': '*',
      },
    };
    return JSON.stringify(pkg, null, 2) + '\n';
  },
  testFileFor(srcOutput, stepId) {
    if (srcOutput && srcOutput.startsWith('src/') && /\.tsx?$/.test(srcOutput)) {
      const base = srcOutput.replace(/^src\//, '').replace(/\.tsx?$/, '').replace(/\//g, '_');
      return `tests/${base}.test.ts`;
    }
    return `tests/${stepId.toLowerCase()}.test.ts`;
  },
  plannerPromptOverride: '',
  executorPromptOverride: '',
  async autoFixImports(ws, audit) {
    return autoFixTypeScriptTypeOnlyImports(ws, audit);
  },
  async probeEntry(ws, sandbox) {
    return probeTsEntrypoint(ws, sandbox);
  },
};

const PROFILES: Record<Language, LanguageProfile> = {
  python: pythonProfile,
  typescript: typescriptProfile,
};

export function getLanguageProfile(language: Language): LanguageProfile {
  return PROFILES[language] ?? pythonProfile;
}

/** FUNCTIONAL_TEST gate（TypeScript）：优先尝试 `node src/main.ts --help`，确保源码入口开箱即用。 */
async function probeTsEntrypoint(
  ws: Workspace,
  sandbox: Sandbox,
): Promise<EntrypointProbe> {
  const tail = (s: string): string => s.split('\n').slice(-30).join('\n');
  const entry = await detectTsEntrypoint(ws);
  if (!entry) {
    return {
      ok: false,
      command: 'npm run start -- --help',
      exitCode: -1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: t().engine.missingTypeScriptEntrypoint,
    };
  }
  let r;
  try {
    r = await runTsEntryProbe(entry, sandbox);
  } catch (err) {
    return {
      ok: false,
      command: entry.command,
      exitCode: -1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: (err as Error).message,
    };
  }
  const helpNetworkFailure = detectNetworkApiFailureInExec(r);
  if (helpNetworkFailure) {
    return {
      ok: false,
      command: entry.command,
      exitCode: r.exitCode,
      timedOut: r.timedOut ?? false,
      stdoutTail: tail(r.stdout),
      stderrTail: `${helpNetworkFailure.message}\nEvidence: ${helpNetworkFailure.evidence}`,
    };
  }
  const ok = r.exitCode === 0 && !r.timedOut && helpOutputLooksMeaningful(r.stdout, r.stderr);
  if (ok) {
    try {
      const smoke = await runTsEntrySmoke(entry, sandbox);
      const smokeNetworkFailure = detectNetworkApiFailureInExec(smoke);
      if (smokeNetworkFailure) {
        return {
          ok: false,
          command: tsSmokeCommand(entry),
          exitCode: smoke.exitCode,
          timedOut: smoke.timedOut ?? false,
          stdoutTail: tail(smoke.stdout),
          stderrTail: `${smokeNetworkFailure.message}\nEvidence: ${smokeNetworkFailure.evidence}`,
        };
      }
    } catch {
      // Smoke run is only a network/API failure detector; ordinary no-arg failures
      // still fall back to the --help entrypoint verdict.
    }
  }
  return {
    ok,
    command: entry.command,
    exitCode: r.exitCode,
    timedOut: r.timedOut ?? false,
    stdoutTail: tail(r.stdout),
    stderrTail: ok ? tail(r.stderr) : tail(r.stderr || t().engine.entrypointHelpOutputMissing(entry.command)),
  };
}

async function detectTsEntrypoint(
  ws: Workspace,
): Promise<
  | { type: 'start-script'; command: string }
  | { type: 'run-program'; entry: string; command: string }
  | { type: 'exec'; cmd: string; argv: string[]; command: string }
  | null
> {
  const pkg = await readJsonFile<Record<string, unknown>>(ws, 'package.json');

  for (const cand of ['src/main.ts', 'src/index.ts']) {
    if (await ws.exists(cand)) {
      return toTsSourceProbe(cand);
    }
  }
  if (await ws.exists('src/main.tsx')) {
    return { type: 'run-program', entry: 'src/main.tsx', command: 'npx tsx src/main.tsx --help' };
  }

  const scripts =
    pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  if (typeof scripts.start === 'string' && scripts.start.trim()) {
    return { type: 'start-script', command: 'npm run --silent start -- --help' };
  }

  const binValue = pkg?.bin;
  if (typeof binValue === 'string' && binValue.trim()) {
    return toTsBinProbe(binValue);
  }
  if (binValue && typeof binValue === 'object' && !Array.isArray(binValue)) {
    const firstBin = Object.values(binValue as Record<string, unknown>).find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (firstBin) return toTsBinProbe(firstBin);
  }

  const mainValue = typeof pkg?.main === 'string' ? pkg.main.trim() : '';
  if (mainValue && (mainValue.endsWith('.ts') || mainValue.endsWith('.tsx') || mainValue.endsWith('.js'))) {
    return toTsBinProbe(mainValue);
  }
  return null;
}

async function runTsEntryProbe(
  probe:
    | { type: 'start-script'; command: string }
    | { type: 'run-program'; entry: string; command: string }
    | { type: 'exec'; cmd: string; argv: string[]; command: string },
  sandbox: Sandbox,
): Promise<Awaited<ReturnType<Sandbox['runProgram']>>> {
  if (probe.type === 'start-script') {
    return sandbox.exec('npm', ['run', '--silent', 'start', '--', '--help'], { timeoutMs: 60_000 });
  }
  if (probe.type === 'exec') {
    return sandbox.exec(probe.cmd, probe.argv, { timeoutMs: 60_000 });
  }
  return sandbox.runProgram([probe.entry, '--help'], { timeoutMs: 60_000 });
}

async function runTsEntrySmoke(
  probe:
    | { type: 'start-script'; command: string }
    | { type: 'run-program'; entry: string; command: string }
    | { type: 'exec'; cmd: string; argv: string[]; command: string },
  sandbox: Sandbox,
): Promise<Awaited<ReturnType<Sandbox['runProgram']>>> {
  if (probe.type === 'start-script') {
    return sandbox.exec('npm', ['run', '--silent', 'start'], { timeoutMs: 60_000 });
  }
  if (probe.type === 'exec') {
    return sandbox.exec(probe.cmd, probe.argv.filter((arg) => arg !== '--help'), { timeoutMs: 60_000 });
  }
  return sandbox.runProgram([probe.entry], { timeoutMs: 60_000 });
}

function tsSmokeCommand(
  probe:
    | { type: 'start-script'; command: string }
    | { type: 'run-program'; entry: string; command: string }
    | { type: 'exec'; cmd: string; argv: string[]; command: string },
): string {
  if (probe.type === 'start-script') return 'npm run --silent start';
  if (probe.type === 'exec') {
    const argv = probe.argv.filter((arg) => arg !== '--help');
    return [probe.cmd, ...argv].join(' ');
  }
  return `npx tsx ${probe.entry}`;
}

function toTsBinProbe(
  entry: string,
): { type: 'run-program'; entry: string; command: string } | { type: 'exec'; cmd: string; argv: string[]; command: string } {
  if (entry.endsWith('.js') || entry.endsWith('.ts')) {
    return { type: 'exec', cmd: 'node', argv: [entry, '--help'], command: `node ${entry} --help` };
  }
  return { type: 'run-program', entry, command: `npx tsx ${entry} --help` };
}

function toTsSourceProbe(
  entry: string,
): { type: 'exec'; cmd: string; argv: string[]; command: string } {
  return { type: 'exec', cmd: 'node', argv: [entry, '--help'], command: `node ${entry} --help` };
}

async function readJsonFile<T>(
  ws: Workspace,
  rel: string,
): Promise<T | null> {
  try {
    return JSON.parse(await ws.readFile(rel)) as T;
  } catch {
    return null;
  }
}

const TYPE_ONLY_IMPORTS_BY_PACKAGE: Record<string, Set<string>> = {
  axios: new Set([
    'AxiosAdapter',
    'AxiosBasicCredentials',
    'AxiosHeaderValue',
    'AxiosInstance',
    'AxiosInterceptorManager',
    'AxiosPromise',
    'AxiosProxyConfig',
    'AxiosRequestConfig',
    'AxiosRequestHeaders',
    'AxiosResponse',
    'AxiosResponseHeaders',
    'CreateAxiosDefaults',
    'InternalAxiosRequestConfig',
    'RawAxiosRequestHeaders',
  ]),
};

async function autoFixTypeScriptTypeOnlyImports(
  ws: Workspace,
  audit: AuditLogger,
): Promise<string[]> {
  const files = await listTypeScriptSourceFiles(ws, 'src');
  const fixed: string[] = [];
  for (const rel of files) {
    const original = await ws.readFile(rel);
    const next = rewriteKnownTypeOnlyImports(original);
    if (next === original) continue;
    await ws.writeFile(rel, next);
    fixed.push(rel);
    await audit.event('note', `fixed type-only imports in ${rel}`, {
      messageId: 'audit.typescript_imports_autofix',
      path: rel,
    });
  }
  return fixed;
}

async function listTypeScriptSourceFiles(ws: Workspace, dir: string): Promise<string[]> {
  const abs = ws.abs(dir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`.replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      files.push(...await listTypeScriptSourceFiles(ws, rel));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(rel);
    }
  }
  return files.sort();
}

function rewriteKnownTypeOnlyImports(source: string): string {
  const importRe = /^import\s+([^'"\n]+?)\s+from\s+(['"])([^'"]+)\2\s*;?$/gm;
  return source.replace(importRe, (full, clauseRaw: string, quote: string, specifier: string) => {
    const knownTypes = TYPE_ONLY_IMPORTS_BY_PACKAGE[specifier];
    if (!knownTypes) return full;
    if (clauseRaw.trim().startsWith('type ')) return full;

    const parsed = splitImportClause(clauseRaw);
    if (!parsed?.named.length) return full;
    const valueNamed: string[] = [];
    const typeNamed: string[] = [];
    for (const item of parsed.named) {
      const importedName = item.replace(/^type\s+/u, '').split(/\s+as\s+/iu)[0]?.trim() ?? '';
      if (knownTypes.has(importedName)) typeNamed.push(item.replace(/^type\s+/u, '').trim());
      else valueNamed.push(item);
    }
    if (typeNamed.length === 0) return full;

    const lines: string[] = [];
    if (parsed.defaultImport && valueNamed.length > 0) {
      lines.push(`import ${parsed.defaultImport}, { ${valueNamed.join(', ')} } from ${quote}${specifier}${quote};`);
    } else if (parsed.defaultImport) {
      lines.push(`import ${parsed.defaultImport} from ${quote}${specifier}${quote};`);
    } else if (valueNamed.length > 0) {
      lines.push(`import { ${valueNamed.join(', ')} } from ${quote}${specifier}${quote};`);
    }
    lines.push(`import type { ${typeNamed.join(', ')} } from ${quote}${specifier}${quote};`);
    return lines.join('\n');
  });
}

function splitImportClause(clauseRaw: string): { defaultImport?: string; named: string[] } | undefined {
  const clause = clauseRaw.trim();
  const namedMatch = clause.match(/\{([\s\S]*)\}$/u);
  if (!namedMatch) return undefined;
  const beforeNamed = clause.slice(0, namedMatch.index).replace(/,\s*$/u, '').trim();
  const named = (namedMatch[1] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    defaultImport: beforeNamed || undefined,
    named,
  };
}
