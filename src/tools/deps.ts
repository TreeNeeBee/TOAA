import { promises as fs } from 'node:fs';
import type { Tool } from './types.js';
import { resolveWorkspacePath } from './path_guard.js';

/**
 * add_dependency：把一组依赖追加到语言对应的依赖清单并重建沙盒。
 *  - Python     → requirements.txt（去重 + 排序）
 *  - TypeScript → package.json.dependencies（去重 + 排序，版本占位为 "*"）
 *
 * 这是受控文件：无需也不应该要求它出现在 Step.outputs 里。
 */
export const addDependencyTool: Tool<
  { packages: string[] },
  { added: string[]; finalLines: string[] }
> = {
  name: 'add_dependency',
  description: '向依赖清单追加依赖（python: requirements.txt；typescript: package.json）并重建沙盒。',
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    if (!args || !Array.isArray(args.packages) || !args.packages.every((p) => typeof p === 'string')) {
      return { ok: false, error: 'invalid add_dependency args: packages must be a non-empty string[]' };
    }
    const normalized = [...new Set(args.packages.map((p) => p.trim()).filter(Boolean))];
    if (normalized.length === 0) {
      return { ok: false, error: 'invalid add_dependency args: packages must include at least one package name' };
    }
    const manifestPath = ctx.language === 'typescript' ? 'package.json' : 'requirements.txt';
    const resolved = await resolveWorkspacePath(ctx.ws, manifestPath, 'add_dependency', {
      forWrite: true,
      relativePathHints: ctx.allowedWrites,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const abs = resolved.abs;
    const added: string[] = [];
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
      const existingDeps =
        pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
          ? { ...(pkg.dependencies as Record<string, string>) }
          : {};
      const before = new Set(Object.keys(existingDeps));
      for (const name of normalized) {
        if (!before.has(name)) added.push(name);
        existingDeps[name] = existingDeps[name] || '*';
      }
      final = Object.keys(existingDeps).sort();
      if (added.length === 0) {
        return unchangedDependencyResult(manifestPath, final);
      }
      pkg.dependencies = Object.fromEntries(final.map((name) => [name, existingDeps[name] ?? '*']));
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
        return unchangedDependencyResult(manifestPath, final);
      }
      await fs.writeFile(abs, final.join('\n') + '\n', 'utf8');
    }
    try {
      await ctx.sandbox.build(manifestPath);
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
      data: { added, finalLines: final },
      summary: `add_dependency ${manifestPath} +${added.length} (${added.join(', ') || 'none new'})`,
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

function unchangedDependencyResult(
  manifestPath: string,
  finalLines: string[],
) {
  return {
    ok: true as const,
    data: { added: [], finalLines },
    summary: `add_dependency ${manifestPath} +0 (none new; sandbox rebuild skipped)`,
  };
}
