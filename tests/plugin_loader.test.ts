import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginSources } from '../src/plugins/loader.js';
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
});
