import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../src/plugins/host.js';
import { checkPluginCompatibility } from '../src/plugins/compatibility.js';
import { ToolRegistry, type Tool } from '../src/tools/types.js';
import { SkillRegistry } from '../src/skills/index.js';
import type { LLMClient } from '../src/llm/types.js';
import type { XCompilerPlugin, XCompilerPluginManifest } from '../src/plugins/types.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../src/version.js';

const pluginManifest = (
  id: string,
  overrides: Partial<XCompilerPluginManifest> = {},
): XCompilerPluginManifest => ({
  id,
  version: '1.0.0',
  apiVersion: XCOMPILER_PLUGIN_API_VERSION,
  minXCompilerVersion: '0.1.3',
  ...overrides,
});

describe('PluginHost', () => {
  it('runs hooks by priority and keeps registration order for ties', async () => {
    const calls: string[] = [];
    const plugin: XCompilerPlugin = {
      manifest: pluginManifest('order-test'),
      setup(api) {
        api.on('compile.start', () => { calls.push('normal-1'); });
        api.on('compile.start', () => { calls.push('high'); }, { priority: 10 });
        api.on('compile.start', () => { calls.push('normal-2'); });
      },
    };
    const host = new PluginHost({ plugins: [plugin] });
    await host.emit('compile.start', { workspace: '/tmp/x', intent: 'greenfield', topicMode: false });
    expect(calls).toEqual(['high', 'normal-1', 'normal-2']);
  });

  it('supports hook unregistration', async () => {
    let calls = 0;
    const host = new PluginHost({
      plugins: [{
        manifest: pluginManifest('unsubscribe-test'),
        setup(api) {
          const off = api.on('run.before', () => { calls++; });
          off();
        },
      }],
    });
    await host.emit('run.before', { plan: {} as never });
    expect(calls).toBe(0);
  });

  it('isolates plugin failures by default and can fail fast in strict mode', async () => {
    const bad: XCompilerPlugin = {
      manifest: pluginManifest('bad-hook'),
      setup(api) {
        api.on('run.before', () => { throw new Error('boom'); });
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(new PluginHost({ plugins: [bad] }).emit('run.before', { plan: {} as never }))
        .resolves.toBeUndefined();
      await expect(new PluginHost({ plugins: [bad], strict: true }).emit('run.before', { plan: {} as never }))
        .rejects.toThrow('boom');
    } finally {
      warn.mockRestore();
    }
  });

  it('wraps tools with mutable before/after contexts', async () => {
    const plugin: XCompilerPlugin = {
      manifest: pluginManifest('tool-hooks'),
      setup(api) {
        api.on('tool.before', (event) => {
          event.args = { value: Number((event.args as { value: number }).value) + 1 };
        });
        api.on('tool.after', (event) => {
          event.result.summary = `hooked:${event.result.summary}`;
        });
      },
    };
    const tool: Tool<{ value: number }, number> = {
      name: 'double',
      description: 'double a number',
      argsSchema: { value: 'number' },
      async run(args) {
        return { ok: true, data: args.value * 2, summary: String(args.value) };
      },
    };
    const host = new PluginHost({ plugins: [plugin] });
    const result = await host.wrapTool(tool).run(
      { value: 2 },
      { ws: undefined as never, sandbox: undefined as never, allowedWrites: [], stepId: 'S001' },
    );
    expect(result.data).toBe(6);
    expect(result.summary).toBe('hooked:3');
  });

  it('wraps LLM requests and permits response post-processing', async () => {
    const seen: string[] = [];
    const plugin: XCompilerPlugin = {
      manifest: pluginManifest('llm-hooks'),
      setup(api) {
        api.on('llm.before', (event) => {
          event.messages.push({ role: 'system', content: 'plugin-policy' });
        });
        api.on('llm.after', (event) => {
          event.response += ':checked';
        });
      },
    };
    const client: LLMClient = {
      name: 'fake',
      async chat(messages) {
        seen.push(...messages.map((message) => message.content));
        return 'ok';
      },
    };
    const result = await new PluginHost({ plugins: [plugin] })
      .wrapLLM(client, 'Coder')
      .chat([{ role: 'user', content: 'work' }]);
    expect(seen).toContain('plugin-policy');
    expect(result).toBe('ok:checked');
  });

  it('registers plugin tools and skills without allowing core overrides', async () => {
    const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-plugin-skill-'));
    const skillDirectory = path.join(skillRoot, 'plugin-skill');
    await fs.mkdir(skillDirectory);
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: plugin-skill',
      'description: Use the plugin tool for plugin-owned checks.',
      'allowed-tools: plugin_tool',
      '---',
      '',
      '# Plugin Skill',
      '',
      'Call the plugin tool and verify its result.',
    ].join('\n'));
    const tool: Tool = {
      name: 'plugin_tool',
      description: 'plugin tool',
      argsSchema: {},
      async run() { return { ok: true }; },
    };
    const plugin: XCompilerPlugin = {
      manifest: pluginManifest('extensions'),
      setup(api) {
        api.registerTool(tool);
        api.registerSkillDirectory(skillDirectory);
      },
    };
    const host = new PluginHost({ plugins: [plugin] });
    await host.initialize();
    const tools = new ToolRegistry();
    const skills = new SkillRegistry();
    host.applyExtensions({ tools, skills });
    expect(tools.get('plugin_tool')).toBe(tool);
    expect(skills.get('plugin-skill')?.allowedTools).toEqual(['plugin_tool']);

    expect(() => host.applyExtensions({ tools, skills })).toThrow(/cannot replace|不能覆盖/);
  });

  it('exposes core and Plugin API versions to plugins', async () => {
    let versions: [string, number] | undefined;
    const host = new PluginHost({
      plugins: [{
        manifest: pluginManifest('version-reader'),
        setup(api) { versions = [api.xcompilerVersion, api.pluginApiVersion]; },
      }],
    });
    await host.initialize();
    expect(versions).toEqual([XCOMPILER_VERSION, XCOMPILER_PLUGIN_API_VERSION]);
  });

  it('rejects incompatible or malformed plugin metadata before setup', () => {
    const setup = () => undefined;
    expect(() => new PluginHost({ plugins: [{
      manifest: pluginManifest('bad-version', { version: 'latest' }), setup,
    }] })).toThrow(/SemVer/);
    expect(() => new PluginHost({ plugins: [{
      manifest: pluginManifest('bad-api', { apiVersion: XCOMPILER_PLUGIN_API_VERSION + 1 }), setup,
    }] })).toThrow(/Plugin API/);
    expect(() => new PluginHost({ plugins: [{
      manifest: pluginManifest('future-core', { minXCompilerVersion: '99.0.0' }), setup,
    }] })).toThrow(/requires XCompiler|要求 XCompiler/);
    expect(() => new PluginHost({ plugins: [{
      manifest: pluginManifest('Bad ID'), setup,
    }] })).toThrow(/Plugin ID|插件 ID/);
    expect(() => new PluginHost({ plugins: [{
      manifest: pluginManifest('missing-min', { minXCompilerVersion: '' }), setup,
    }] })).toThrow(/minimum XCompiler|最低 XCompiler/);
    expect(checkPluginCompatibility(null as unknown as XCompilerPluginManifest))
      .toMatchObject({ compatible: false, code: 'invalid-id' });
  });

  it('offers a reusable compatibility report and immutable manifest inventory', () => {
    const manifest = pluginManifest('example.catalog', { keywords: ['policy'] });
    expect(checkPluginCompatibility(manifest)).toMatchObject({
      compatible: true,
      code: 'compatible',
      pluginId: 'example.catalog',
    });
    expect(checkPluginCompatibility(manifest, { xcompilerVersion: '0.1.2' })).toMatchObject({
      compatible: false,
      code: 'xcompiler-version-too-old',
    });
    expect(checkPluginCompatibility(pluginManifest('bad-prerelease', { version: '1.0.0-01' })))
      .toMatchObject({ compatible: false, code: 'invalid-plugin-version' });

    const host = new PluginHost({ plugins: [{ manifest, setup() {} }] });
    const inventory = host.manifests;
    manifest.keywords?.push('mutated');
    expect(inventory).toEqual([pluginManifest('example.catalog', { keywords: ['policy'] })]);
    expect(host.manifests).toEqual(inventory);
  });
});
