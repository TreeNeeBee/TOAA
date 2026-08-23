import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { t } from '../i18n/index.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../version.js';
import { checkPluginCompatibility } from './compatibility.js';
import { buildDefaultSkills } from '../skills/index.js';
import type {
  PluginLoadOptions,
  PluginSource,
  XCompilerPlugin,
  XCompilerPluginManifest,
} from './types.js';

interface PreflightSource {
  source: PluginSource;
  manifest: XCompilerPluginManifest;
  manifestPath: string;
  entryPath: string;
  skillDirectories: string[];
}

/**
 * 从磁盘加载插件。全部 manifest 会在任何插件模块 import 之前完成读取、兼容性与
 * 重复 ID 检查，避免不兼容插件借助模块顶层代码绕过宿主版本门禁。
 */
export async function loadPluginSources(options: PluginLoadOptions): Promise<XCompilerPlugin[]> {
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const runtime = {
    xcompilerVersion: options.xcompilerVersion ?? XCOMPILER_VERSION,
    pluginApiVersion: options.pluginApiVersion ?? XCOMPILER_PLUGIN_API_VERSION,
  };
  const preflight: PreflightSource[] = [];
  // Include built-ins so a manifest cannot shadow a core Skill before its module is imported.
  const preflightSkills = buildDefaultSkills();

  for (const source of options.sources) {
    const manifestPath = path.resolve(baseDir, source.manifestPath);
    const entryPath = path.resolve(baseDir, source.entryPath);
    let manifest: XCompilerPluginManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as XCompilerPluginManifest;
    } catch (error) {
      const message = t().plugins.manifestReadFailed(manifestPath, errorMessage(error));
      await auditRejected(options, '', 'manifest-read', message, { manifestPath, entryPath });
      throw new Error(message, { cause: error });
    }
    const report = checkPluginCompatibility(manifest, runtime);
    if (!report.compatible) {
      const message = report.message ?? report.code;
      await auditRejected(options, report.pluginId, 'compatibility', message, { manifestPath, entryPath });
      throw new Error(message);
    }
    const pluginRoot = path.resolve(baseDir, source.rootPath ?? path.dirname(source.entryPath));
    let skillDirectories: string[];
    try {
      skillDirectories = (manifest.skills ?? []).map((directory) => {
        const resolved = path.resolve(pluginRoot, directory);
        if (resolved !== pluginRoot && !resolved.startsWith(`${pluginRoot}${path.sep}`)) {
          throw new Error(`Plugin ${manifest.id} Skill directory escapes its plugin root: ${directory}`);
        }
        return resolved;
      });
      for (const directory of skillDirectories) {
        preflightSkills.registerDirectory(directory, { kind: 'plugin', pluginId: manifest.id });
      }
    } catch (error) {
      const message = `Plugin ${manifest.id} Agent Skill preflight failed: ${errorMessage(error)}`;
      await auditRejected(options, manifest.id, 'skill-preflight', message, { manifestPath, entryPath });
      throw new Error(message, { cause: error });
    }
    preflight.push({ source, manifest: snapshotManifest(manifest), manifestPath, entryPath, skillDirectories });
  }

  const seen = new Set<string>();
  for (const item of preflight) {
    if (seen.has(item.manifest.id)) {
      const message = t().plugins.duplicateId(item.manifest.id);
      await auditRejected(options, item.manifest.id, 'duplicate-id', message, item);
      throw new Error(message);
    }
    seen.add(item.manifest.id);
  }

  const plugins: XCompilerPlugin[] = [];
  for (const item of preflight) {
    const exportName = item.source.exportName ?? 'default';
    let loaded: Record<string, unknown>;
    try {
      loaded = await import(pathToFileURL(item.entryPath).href) as Record<string, unknown>;
    } catch (error) {
      const message = t().plugins.moduleLoadFailed(item.manifest.id, item.entryPath, errorMessage(error));
      await auditRejected(options, item.manifest.id, 'module-load', message, item);
      throw new Error(message, { cause: error });
    }
    const plugin = loaded[exportName];
    if (!isPlugin(plugin)) {
      const message = t().plugins.exportInvalid(item.manifest.id, exportName);
      await auditRejected(options, item.manifest.id, 'module-export', message, item);
      throw new Error(message);
    }
    if (!sameRuntimeManifest(plugin.manifest, item.manifest)) {
      const message = t().plugins.manifestMismatch(item.manifest.id);
      await auditRejected(options, item.manifest.id, 'manifest-mismatch', message, item);
      throw new Error(message, { cause: new Error('plugin runtime manifest differs from preflight manifest') });
    }
    const setup = plugin.setup.bind(plugin);
    plugins.push({
      ...plugin,
      manifest: snapshotManifest(item.manifest),
      async setup(api) {
        for (const directory of item.skillDirectories) api.registerSkillDirectory(directory);
        await setup(api);
      },
    });
  }
  return plugins;
}

function isPlugin(value: unknown): value is XCompilerPlugin {
  return !!value && typeof value === 'object' &&
    typeof (value as { setup?: unknown }).setup === 'function' &&
    !!(value as { manifest?: unknown }).manifest;
}

function sameRuntimeManifest(actual: XCompilerPluginManifest, expected: XCompilerPluginManifest): boolean {
  return actual.id === expected.id &&
    actual.version === expected.version &&
    actual.apiVersion === expected.apiVersion &&
    actual.minXCompilerVersion === expected.minXCompilerVersion &&
    sameStrings(actual.skills, expected.skills);
}

function sameStrings(actual: readonly string[] | undefined, expected: readonly string[] | undefined): boolean {
  const left = actual ?? [];
  const right = expected ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function snapshotManifest(manifest: XCompilerPluginManifest): XCompilerPluginManifest {
  return {
    ...manifest,
    keywords: manifest.keywords ? [...manifest.keywords] : undefined,
    skills: manifest.skills ? [...manifest.skills] : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function auditRejected(
  options: PluginLoadOptions,
  pluginId: string,
  stage: string,
  message: string,
  detail: unknown,
): Promise<void> {
  await options.audit?.event('note', message, {
    messageId: 'plugins.load_rejected',
    pluginId,
    stage,
    detail,
  });
}
