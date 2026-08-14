import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';
import type { LLMClient } from '../llm/types.js';
import type { Tool } from '../tools/types.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../version.js';
import { checkPluginCompatibility } from './compatibility.js';
import type {
  HookContextMap,
  HookHandler,
  HookName,
  HookRegistrationOptions,
  PluginApi,
  PluginExtensionTarget,
  PluginHostOptions,
  XCompilerPlugin,
  XCompilerPluginManifest,
} from './types.js';

interface RegisteredHook {
  hook: HookName;
  plugin: XCompilerPlugin;
  handler: (context: unknown) => void | Promise<void>;
  priority: number;
  order: number;
}

/** 插件注册、扩展能力合并与生命周期 Hook 调度中心。 */
export class PluginHost {
  private readonly plugins: XCompilerPlugin[];
  private readonly strict: boolean;
  private readonly xcompilerVersion: string;
  private readonly pluginApiVersion: number;
  private readonly hooks = new Map<HookName, RegisteredHook[]>();
  private readonly contributedTools: Array<{ plugin: XCompilerPlugin; tool: Tool }> = [];
  private readonly contributedSkillDirectories: Array<{ plugin: XCompilerPlugin; directory: string }> = [];
  private audit?: AuditLogger;
  private initialized = false;
  private registrationOrder = 0;

  constructor(options: PluginHostOptions = {}) {
    this.plugins = (options.plugins ?? []).map(snapshotPlugin);
    this.strict = options.strict ?? false;
    this.xcompilerVersion = options.xcompilerVersion ?? XCOMPILER_VERSION;
    this.pluginApiVersion = options.pluginApiVersion ?? XCOMPILER_PLUGIN_API_VERSION;
    this.audit = options.audit;
    assertPluginMetadata(this.plugins, this.xcompilerVersion, this.pluginApiVersion);
  }

  get size(): number {
    return this.plugins.length;
  }

  /** 返回只读清单快照，供诊断、插件目录和未来 registry 使用。 */
  get manifests(): readonly XCompilerPluginManifest[] {
    return this.plugins.map((plugin) => snapshotManifest(plugin.manifest));
  }

  setAudit(audit: AuditLogger): void {
    this.audit = audit;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // 先置位，避免 setup 中的间接调用导致递归初始化。
    this.initialized = true;
    for (const plugin of this.plugins) {
      try {
        await plugin.setup(this.createApi(plugin));
        await this.audit?.event(
          'note',
          t().plugins.loaded(plugin.manifest.id, plugin.manifest.version),
          {
            messageId: 'plugins.loaded',
            pluginId: plugin.manifest.id,
            pluginVersion: plugin.manifest.version,
            minXCompilerVersion: plugin.manifest.minXCompilerVersion,
            apiVersion: plugin.manifest.apiVersion,
          },
        );
      } catch (error) {
        await this.handleFailure(plugin, 'setup', error);
      }
    }
  }

  /** 把插件贡献的 Tool / Skill 合并到 Engine 的默认注册表；禁止静默覆盖核心能力。 */
  applyExtensions(target: PluginExtensionTarget): void {
    for (const { plugin, tool } of this.contributedTools) {
      if (target.tools.get(tool.name)) {
        throw new Error(t().plugins.extensionConflict(plugin.manifest.id, 'tool', tool.name));
      }
      target.tools.register(tool);
    }
    for (const { plugin, directory } of this.contributedSkillDirectories) {
      try {
        target.skills.registerDirectory(directory, { kind: 'plugin', pluginId: plugin.manifest.id });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(t().plugins.extensionConflict(plugin.manifest.id, 'skill', detail), { cause: error });
      }
    }
  }

  async emit<K extends HookName>(hook: K, context: HookContextMap[K]): Promise<void> {
    await this.initialize();
    const handlers = [...(this.hooks.get(hook) ?? [])]
      .sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    for (const registration of handlers) {
      try {
        await registration.handler(context);
      } catch (error) {
        await this.handleFailure(registration.plugin, hook, error);
      }
    }
  }

  /** 在不绕过原 Tool / EditGuard 的前提下增加 before / after / error Hook。 */
  wrapTool<A, R>(tool: Tool<A, R>): Tool<A, R> {
    return {
      name: tool.name,
      description: tool.description,
      argsSchema: tool.argsSchema,
      run: async (args, context) => {
        const before: HookContextMap['tool.before'] = {
          stepId: context.stepId,
          tool: tool.name,
          args,
          context,
        };
        await this.emit('tool.before', before);
        try {
          const result = await tool.run(before.args as A, context);
          const after: HookContextMap['tool.after'] = {
            ...before,
            result,
          };
          await this.emit('tool.after', after);
          return after.result as Awaited<ReturnType<Tool<A, R>['run']>>;
        } catch (error) {
          await this.emit('tool.error', { ...before, error });
          throw error;
        }
      },
    };
  }

  /** 包装完整 LLM 调用；response 可由 after Hook 做结构化后处理。 */
  wrapLLM(client: LLMClient, role: string): LLMClient {
    return {
      name: client.name,
      chat: async (messages, options) => {
        const before: HookContextMap['llm.before'] = {
          role,
          model: client.name,
          messages: [...messages],
          options: options ? { ...options } : undefined,
        };
        await this.emit('llm.before', before);
        const startedAt = Date.now();
        try {
          const response = await client.chat(before.messages, before.options);
          const after: HookContextMap['llm.after'] = {
            role,
            model: client.name,
            messages: before.messages,
            response,
            durationMs: Date.now() - startedAt,
          };
          await this.emit('llm.after', after);
          return after.response;
        } catch (error) {
          await this.emit('llm.error', {
            role,
            model: client.name,
            messages: before.messages,
            error,
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      },
    };
  }

  private createApi(plugin: XCompilerPlugin): PluginApi {
    return {
      xcompilerVersion: this.xcompilerVersion,
      pluginApiVersion: this.pluginApiVersion,
      on: <K extends HookName>(
        hook: K,
        handler: HookHandler<K>,
        options: HookRegistrationOptions = {},
      ) => {
        const registration: RegisteredHook = {
          hook,
          plugin,
          handler: (context) => handler(context as HookContextMap[K]),
          priority: options.priority ?? 0,
          order: this.registrationOrder++,
        };
        const list = this.hooks.get(hook) ?? [];
        list.push(registration);
        this.hooks.set(hook, list);
        return () => {
          const current = this.hooks.get(hook);
          if (!current) return;
          const index = current.indexOf(registration);
          if (index >= 0) current.splice(index, 1);
        };
      },
      registerTool: (tool) => this.contributedTools.push({ plugin, tool }),
      registerSkillDirectory: (directory) => this.contributedSkillDirectories.push({ plugin, directory }),
    };
  }

  private async handleFailure(plugin: XCompilerPlugin, stage: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const rendered = t().plugins.hookFailed(plugin.manifest.id, stage, message);
    await this.audit?.event('note', rendered, {
      messageId: 'plugins.hook_failed',
      plugin: plugin.manifest.id,
      stage,
      error: message,
    });
    if (this.strict || plugin.failureMode === 'fail') throw error;
    console.warn(rendered);
  }
}

function assertPluginMetadata(
  plugins: XCompilerPlugin[],
  xcompilerVersion: string,
  pluginApiVersion: number,
): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const report = checkPluginCompatibility(plugin.manifest, { xcompilerVersion, pluginApiVersion });
    if (!report.compatible) throw new Error(report.message);
    if (seen.has(report.pluginId)) throw new Error(t().plugins.duplicateId(report.pluginId));
    seen.add(report.pluginId);
  }
}

function snapshotPlugin(plugin: XCompilerPlugin): XCompilerPlugin {
  return { ...plugin, manifest: snapshotManifest(plugin.manifest) };
}

function snapshotManifest(manifest: XCompilerPluginManifest | undefined): XCompilerPluginManifest {
  if (!manifest) return {} as XCompilerPluginManifest;
  return {
    ...manifest,
    keywords: manifest.keywords ? [...manifest.keywords] : undefined,
    skills: manifest.skills ? [...manifest.skills] : undefined,
  };
}
