import { promises as fs } from 'node:fs';
import type { Tool, ToolContext } from './types.js';
import { resolveWorkspacePath } from './path_guard.js';
import { DEPENDENCY_MANIFEST_OWNER } from '../domain/steps/step.js';

/**
 * add_dependency：把一组依赖追加到语言对应的依赖清单并重建沙盒。
 *  - Python     → requirements.txt（去重 + 排序）
 *  - TypeScript → package.json（支持 name@version，并受控刷新 lockfile）
 *
 * 这是受控文件：无需也不应该要求它出现在 Step.outputs 里。
 */
export const addDependencyTool: Tool<
  { packages: string[]; dev?: boolean },
  { added: string[]; updated: string[]; finalLines: string[] }
> = {
  name: 'add_dependency',
  description:
    '向依赖清单追加或更新依赖并重建沙盒。TypeScript packages 支持 name@version；测试/构建工具应设置 dev=true。',
  argsSchema: { packages: 'string[]', dev: 'boolean?' },
  async run(args, ctx) {
    if (!args || !Array.isArray(args.packages) || !args.packages.every((p) => typeof p === 'string')) {
      return { ok: false, error: 'invalid add_dependency args: packages must be a non-empty string[]' };
    }
    const normalized = [...new Set(args.packages.map((p) => p.trim()).filter(Boolean))];
    if (normalized.length === 0) {
      return { ok: false, error: 'invalid add_dependency args: packages must include at least one package name' };
    }
    // One design decides the whole dependency set. A Step that edits the manifest under
    // HIGH_LEVEL_DESIGN changes what every other Step already resolved against, and nobody checked
    // the result is consistent — so a need discovered elsewhere travels back as a Change Request
    // and returns as a dependency the design accepted.
    if (ctx.phase !== undefined && ctx.phase !== DEPENDENCY_MANIFEST_OWNER) {
      return {
        ok: false,
        code: 'dependency_not_owned',
        error:
          `add_dependency is owned by ${DEPENDENCY_MANIFEST_OWNER}; ${ctx.phase} cannot change the manifest. ` +
          `Report the packages this Step needs (${normalized.join(', ')}) as a dependency change ` +
          `request so ${DEPENDENCY_MANIFEST_OWNER} can check them against the accepted set and update it.`,
      };
    }
    const manifestPath = ctx.language === 'typescript' ? 'package.json' : 'requirements.txt';
    const resolved = await resolveWorkspacePath(ctx.ws, manifestPath, 'add_dependency', {
      forWrite: true,
      relativePathHints: ctx.allowedWrites,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const abs = resolved.abs;
    const added: string[] = [];
    const updated: string[] = [];
    let final: string[];
    const rollbackPaths = ctx.language === 'typescript'
      ? ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']
      : ['requirements.txt'];
    const snapshots = await Promise.all(
      rollbackPaths.map((rel) => snapshotWorkspaceFile(ctx.ws.abs(rel))),
    );

    if (ctx.language === 'typescript') {
      let pkg: Record<string, unknown>;
      try {
        const text = await fs.readFile(abs, 'utf8');
        pkg = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          pkg = {};
        } else {
          return {
            ok: false,
            error: `add_dependency cannot update invalid package.json: ${(err as Error).message}`,
          };
        }
      }
      const dependencies = dependencySection(pkg.dependencies);
      const devDependencies = dependencySection(pkg.devDependencies);
      for (const request of normalized) {
        const parsed = parseNpmDependencyRequest(request);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const { name, version } = parsed;
        const useDev = args.dev === true || (dependencies[name] === undefined && devDependencies[name] !== undefined);
        const target = useDev ? devDependencies : dependencies;
        const other = useDev ? dependencies : devDependencies;
        const previous = target[name] ?? other[name];
        const next = version ?? previous ?? '*';
        if (previous === undefined) added.push(name);
        if (previous !== undefined && (previous !== next || other[name] !== undefined)) updated.push(name);
        target[name] = next;
        if (args.dev === true) delete other[name];
      }
      final = [...new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)])].sort();
      if (added.length === 0 && updated.length === 0) {
        return unchangedDependencyResult(ctx, manifestPath, final);
      }
      pkg.dependencies = sortedDependencySection(dependencies);
      if (Object.keys(devDependencies).length > 0) {
        pkg.devDependencies = sortedDependencySection(devDependencies);
      }
      await fs.writeFile(abs, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    } else {
      let existing = '';
      try {
        existing = await fs.readFile(abs, 'utf8');
      } catch {
        /* new file */
      }
      const set = new Set<string>();
      for (const line of existing.split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#')) set.add(t);
      }
      const before = new Set(set);
      for (const p of normalized) {
        if (!before.has(p)) added.push(p);
        set.add(p);
      }
      final = [...set].sort();
      if (added.length === 0) {
        return unchangedDependencyResult(ctx, manifestPath, final);
      }
      await fs.writeFile(abs, final.join('\n') + '\n', 'utf8');
    }
    try {
      await ctx.sandbox.build(manifestPath, {
        refreshLockfile: ctx.language === 'typescript',
      });
    } catch (err) {
      const rollbackErrors = await restoreWorkspaceFiles(snapshots);
      const rollbackSummary = rollbackErrors.length === 0
        ? `${manifestPath} and related lockfiles were restored`
        : `rollback was incomplete: ${rollbackErrors.join('; ')}`;
      return {
        ok: false,
        error:
          `sandbox rebuild failed after staging ${manifestPath}: ${(err as Error).message}; ` +
          rollbackSummary,
      };
    }
    return {
      ok: true,
      data: { added, updated, finalLines: final },
      summary:
        `add_dependency ${manifestPath} +${added.length} ~${updated.length} ` +
        `(${[...added, ...updated].join(', ') || 'none changed'})`,
    };
  },
};

interface WorkspaceFileSnapshot {
  abs: string;
  existed: boolean;
  content?: Buffer;
}

async function snapshotWorkspaceFile(abs: string): Promise<WorkspaceFileSnapshot> {
  try {
    return { abs, existed: true, content: await fs.readFile(abs) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { abs, existed: false };
    }
    throw err;
  }
}

async function restoreWorkspaceFiles(
  snapshots: WorkspaceFileSnapshot[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const snapshot of snapshots) {
    try {
      if (snapshot.existed) {
        await fs.writeFile(snapshot.abs, snapshot.content!);
      } else {
        await fs.rm(snapshot.abs, { force: true });
      }
    } catch (err) {
      errors.push(`${snapshot.abs}: ${(err as Error).message}`);
    }
  }
  return errors;
}

/**
 * Every requested package was already declared — so the manifest does not change, but the
 * environment may still not match it.
 *
 * Those are different facts, and reading the first as the second is why a Step that called this
 * *because* its toolchain was missing was told the rebuild had been skipped and left exactly as it
 * was. Nothing a Step can do from there fixes it.
 *
 * The build is cached by manifest signature, so when the environment really is in sync this costs a
 * stat and a hash.
 */
async function unchangedDependencyResult(
  ctx: ToolContext,
  manifestPath: string,
  finalLines: string[],
) {
  let synced = true;
  let reason = '';
  try {
    await ctx.sandbox.build(manifestPath);
  } catch (error) {
    synced = false;
    reason = (error as Error).message;
  }
  return {
    ok: true as const,
    data: { added: [], updated: [], finalLines },
    summary: synced
      ? `add_dependency ${manifestPath} +0 (none new; environment matches the manifest)`
      : `add_dependency ${manifestPath} +0 (none new; the environment does not match the manifest ` +
        `and could not be prepared: ${reason})`,
  };
}

function dependencySection(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function sortedDependencySection(section: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(section).sort().map((name) => [name, section[name]!]));
}

function parseNpmDependencyRequest(
  request: string,
): { ok: true; name: string; version?: string } | { ok: false; error: string } {
  if (/\s/u.test(request)) {
    return { ok: false, error: `invalid npm dependency request: ${request}` };
  }
  const slash = request.startsWith('@') ? request.indexOf('/') : -1;
  const separator = request.startsWith('@')
    ? (slash > 1 ? request.indexOf('@', slash + 1) : -1)
    : request.lastIndexOf('@');
  const hasVersion = separator > 0;
  const name = hasVersion ? request.slice(0, separator) : request;
  const version = hasVersion ? request.slice(separator + 1) : undefined;
  if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(name) || (hasVersion && !version)) {
    return {
      ok: false,
      error: `invalid npm dependency request: ${request}; expected package-name or package-name@version`,
    };
  }
  return version ? { ok: true, name, version } : { ok: true, name };
}
