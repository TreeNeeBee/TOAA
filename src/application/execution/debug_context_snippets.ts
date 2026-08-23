import path from 'node:path';
import type { Plan } from '../../core/plan.js';
import type { Workspace } from '../../workspace/workspace.js';

const MAX_DEBUG_DEPENDENCY_PATHS = 12;

/**
 * Expands failure-related files with their local code dependencies so a corrective role sees the
 * implementation contract before it proposes a mutation. The traversal is deliberately one hop:
 * it supplies the directly imported production surface without pulling the whole project into the
 * prompt.
 */
export async function discoverDebugContextPaths(input: {
  workspace: Workspace;
  seedPaths: readonly string[];
  failureEvidence?: string;
  language: Plan['language'];
  maxPaths?: number;
}): Promise<string[]> {
  const limit = input.maxPaths ?? MAX_DEBUG_DEPENDENCY_PATHS;
  const seeds = uniquePaths([
    ...extractWorkspacePaths(input.failureEvidence ?? ''),
    ...input.seedPaths,
  ]);
  const discovered: string[] = [];
  const seen = new Set<string>();

  for (const seed of seeds) {
    if (discovered.length >= limit) break;
    const resolvedSeed = await resolveExistingPath(input.workspace, seed, input.language);
    if (!resolvedSeed || seen.has(resolvedSeed)) continue;
    seen.add(resolvedSeed);
    discovered.push(resolvedSeed);

    if (!isSourceLikePath(resolvedSeed, input.language)) continue;
    const content = await input.workspace.readFile(resolvedSeed).catch(() => '');
    for (const specifier of localDependencySpecifiers(content, input.language)) {
      if (discovered.length >= limit) break;
      const dependency = await resolveDependency(
        input.workspace,
        resolvedSeed,
        specifier,
        input.language,
      );
      if (!dependency || seen.has(dependency)) continue;
      seen.add(dependency);
      discovered.push(dependency);
    }
  }
  return discovered;
}

export function extractWorkspacePaths(text: string): string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s"'`(=:[])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?=[,:;)}\s"'`\]])/gmu;
  for (const match of text.matchAll(pattern)) {
    const candidate = normalizeWorkspacePath(match[1] ?? '');
    if (candidate) paths.push(candidate);
  }
  return uniquePaths(paths);
}

function localDependencySpecifiers(content: string, language: Plan['language']): string[] {
  if (language === 'typescript') {
    const values: string[] = [];
    const patterns = [
      /\bfrom\s+["']([^"']+)["']/gmu,
      /\bimport\s*["']([^"']+)["']/gmu,
      /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gmu,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (match[1]?.startsWith('.')) values.push(match[1]);
      }
    }
    return [...new Set(values)];
  }

  const values: string[] = [];
  for (const match of content.matchAll(/^\s*from\s+(\.+[A-Za-z0-9_.]*)\s+import\s+/gmu)) {
    if (match[1]) values.push(match[1]);
  }
  return [...new Set(values)];
}

async function resolveDependency(
  workspace: Workspace,
  importer: string,
  specifier: string,
  language: Plan['language'],
): Promise<string | undefined> {
  if (language === 'python') {
    const dots = specifier.match(/^\.+/u)?.[0].length ?? 0;
    const moduleName = specifier.slice(dots).replaceAll('.', '/');
    let base = path.posix.dirname(importer);
    for (let level = 1; level < dots; level++) base = path.posix.dirname(base);
    return resolveExistingPath(workspace, path.posix.join(base, moduleName), language);
  }
  return resolveExistingPath(
    workspace,
    path.posix.join(path.posix.dirname(importer), specifier),
    language,
  );
}

async function resolveExistingPath(
  workspace: Workspace,
  rawPath: string,
  language: Plan['language'],
): Promise<string | undefined> {
  const normalized = normalizeWorkspacePath(rawPath);
  if (!normalized) return undefined;
  for (const candidate of pathCandidates(normalized, language)) {
    if (await workspace.exists(candidate)) return candidate;
  }
  return undefined;
}

function pathCandidates(value: string, language: Plan['language']): string[] {
  if (language === 'python') {
    return path.posix.extname(value)
      ? [value]
      : [`${value}.py`, path.posix.join(value, '__init__.py')];
  }
  const extension = path.posix.extname(value);
  if (!extension) {
    return [
      `${value}.ts`, `${value}.tsx`, `${value}.js`, `${value}.mjs`, `${value}.cjs`,
      path.posix.join(value, 'index.ts'), path.posix.join(value, 'index.tsx'),
      path.posix.join(value, 'index.js'),
    ];
  }
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    const stem = value.slice(0, -extension.length);
    return [value, `${stem}.ts`, `${stem}.tsx`];
  }
  return [value];
}

function normalizeWorkspacePath(value: string): string | undefined {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/').replace(/^\.\//u, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  if (path.posix.isAbsolute(normalized)) return undefined;
  return normalized;
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeWorkspacePath).filter((value): value is string => !!value))];
}

function isSourceLikePath(value: string, language: Plan['language']): boolean {
  return language === 'typescript'
    ? /\.(?:[cm]?js|jsx|tsx?)$/u.test(value)
    : /\.py$/u.test(value);
}
