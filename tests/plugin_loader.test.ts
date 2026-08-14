import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginSources } from '../src/plugins/loader.js';
import { PluginHost } from '../src/plugins/host.js';
import { SkillRegistry } from '../src/skills/index.js';
import { ToolRegistry } from '../src/tools/types.js';
import { XCOMPILER_PLUGIN_API_VERSION } from '../src/version.js';

async function fixture(minXCompilerVersion: string): Promise<{
  root: string;
  manifestPath: string;
  entryPath: string;
  markerPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-plugin-loader-'));
  const manifestPath = path.join(root, 'plugin.json');
  const entryPath = path.join(root, 'plugin.mjs');
  const markerPath = path.join(root, 'executed');
  const manifest = {
    id: 'fixture.loader',
    version: '1.0.0',
    apiVersion: XCOMPILER_PLUGIN_API_VERSION,
    minXCompilerVersion,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await fs.writeFile(entryPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(markerPath)}, "yes");`,
    `export default { manifest: ${JSON.stringify(manifest)}, setup() {} };`,
  ].join('\n'), 'utf8');
  return { root, manifestPath, entryPath, markerPath };
}

describe('manifest-first plugin loader', () => {
  it('rejects an incompatible manifest before executing module top-level code', async () => {
    const f = await fixture('99.0.0');
    await expect(loadPluginSources({
      sources: [{ manifestPath: f.manifestPath, entryPath: f.entryPath }],
    })).rejects.toThrow(/99\.0\.0/);
    await expect(fs.access(f.markerPath)).rejects.toThrow();
  });

  it('loads a compatible module only after manifest preflight', async () => {
    const f = await fixture('0.1.3');
    const plugins = await loadPluginSources({
      sources: [{ manifestPath: f.manifestPath, entryPath: f.entryPath }],
    });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.id).toBe('fixture.loader');
    await expect(fs.readFile(f.markerPath, 'utf8')).resolves.toBe('yes');
  });

  it('rejects an invalid manifest-declared Skill before executing plugin code', async () => {
    const f = await fixture('0.1.3');
    const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.skills = ['skills'];
    await fs.writeFile(f.manifestPath, JSON.stringify(manifest), 'utf8');
    const directory = path.join(f.root, 'skills', 'actual-name');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), [
      '---',
      'name: wrong-name',
      'description: This invalid Skill must fail before plugin import.',
      '---',
      '# Invalid',
    ].join('\n'));

    await expect(loadPluginSources({
      sources: [{ manifestPath: f.manifestPath, entryPath: f.entryPath }],
    })).rejects.toThrow(/Agent Skill preflight failed/u);
    await expect(fs.access(f.markerPath)).rejects.toThrow();
  });

  it('registers valid manifest-declared Skills through Plugin API 3', async () => {
    const f = await fixture('0.1.3');
    const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.skills = ['skills'];
    await fs.writeFile(f.manifestPath, JSON.stringify(manifest), 'utf8');
    const directory = path.join(f.root, 'skills', 'loader-skill');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), [
      '---',
      'name: loader-skill',
      'description: Validate manifest-first Skill registration.',
      '---',
      '# Loader Skill',
      'Use only for this plugin fixture.',
    ].join('\n'));
    await fs.writeFile(f.entryPath, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(f.markerPath)}, "yes");`,
      `export default { manifest: ${JSON.stringify(manifest)}, setup() {} };`,
    ].join('\n'), 'utf8');

    const plugins = await loadPluginSources({
      sources: [{ manifestPath: f.manifestPath, entryPath: f.entryPath }],
    });
    const host = new PluginHost({ plugins });
    await host.initialize();
    const skills = new SkillRegistry();
    host.applyExtensions({ tools: new ToolRegistry(), skills });
    expect(skills.get('loader-skill')?.source).toEqual({ kind: 'plugin', pluginId: 'fixture.loader' });
  });

  it('rejects a runtime manifest that changes the preflight Skill list', async () => {
    const f = await fixture('0.1.3');
    const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.skills = [];
    await fs.writeFile(f.manifestPath, JSON.stringify(manifest), 'utf8');
    const runtimeManifest = { ...manifest, skills: ['unexpected-skills'] };
    await fs.writeFile(f.entryPath, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(f.markerPath)}, "yes");`,
      `export default { manifest: ${JSON.stringify(runtimeManifest)}, setup() {} };`,
    ].join('\n'), 'utf8');
    await expect(loadPluginSources({
      sources: [{ manifestPath: f.manifestPath, entryPath: f.entryPath }],
    })).rejects.toThrow(/manifest/u);
  });
});
