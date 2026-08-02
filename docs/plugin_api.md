# XCompiler Plugin API

XCompiler 的插件层位于核心流程与扩展能力之间。既支持直接传入 `XCompilerPlugin[]`，也提供 `loadPluginSources()` 从分离的 manifest 与模块入口执行 manifest-first 加载；当前仍不负责从网络安装第三方包或维护 marketplace。自举编排可通过 `@xcompiler/cli/runtime` 调用 `runBootstrap`，候选内部的 compile / run 仍触发相同生命周期 Hook。

## 清单与版本兼容

设计参考 [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)：插件元数据与可执行入口分离，唯一 ID、插件 SemVer 和宿主兼容声明都是必填项。XCompiler 使用可序列化的 `manifest`；`loadPluginSources()` 会先读取并检查全部 manifest，全部通过后才 import 任一模块，因此 registry / marketplace 可在不执行插件代码的前提下索引和预检。

XCompiler 核心版本和 Plugin API 版本独立演进：核心使用 package SemVer，Plugin API 使用整数主版本（当前 `1`）。每个插件清单必须声明：

| 字段 | 必填 | 语义 |
|---|---|---|
| `id` | 是 | 全局唯一稳定 ID；小写字母/数字/点/连字符/下划线 |
| `version` | 是 | 插件自身 SemVer |
| `apiVersion` | 是 | 插件面向的 XCompiler Plugin API 主版本 |
| `minXCompilerVersion` | 是 | 插件可运行的最低 XCompiler 核心 SemVer |
| `displayName/description/license/homepage/keywords` | 否 | 目录与展示元数据 |

`loadPluginSources()` 在模块 import 前检查全部 manifest 和重复 ID，并校验模块导出的运行时 manifest 与预检文件一致；拒绝事件可写入审计日志。直接传入已经 import 的 `XCompilerPlugin[]` 时，`PluginHost` 仍保证在任何 `setup()` 前完成同样检查，但无法撤销调用方此前执行的模块顶层代码。`checkPluginCompatibility()` 可供安装器、插件目录或配置预检复用。

版本常量从 `@xcompiler/cli/plugins` 导出；插件在 `setup(api)` 中也可读取 `api.xcompilerVersion` 和 `api.pluginApiVersion`。插件升级自身实现时递增 `manifest.version`；需要较新核心能力时提高 `manifest.minXCompilerVersion`；只有公共插件接口发生不兼容变化时，XCompiler 才递增 Plugin API 主版本。

## 模块边界

| 模块 | 责任 | 插件扩展点 |
|---|---|---|
| `runtime/build` | 需求输入、澄清、计划生成和人工门 | `compile.*` |
| `llm/router` | provider 选择、fallback、审计 | `llm.*` |
| `application/execution` | Runtime 用例、单次尝试和执行投影 | `run.*`、`step.*` |
| `domain` | Project/Phase/Step/Ticket 生命周期、调度和质量门 | 只观察，不允许 Hook 直接改状态 |
| `agents/executor` | 单 Step 多轮工具执行 | 通过 `step.attempt.*` 和 `tool.*` 观察 |
| `tools` / `skills` | 原子能力与高阶能力组合 | `registerTool`、`registerSkill` |
| `plugins` | 注册、排序、异常隔离和 Hook 调度 | 公共插件 API |

安全边界保持不变：插件注册的 Tool 进入与内置 Tool 相同的白名单选择和 `EditGuard`；Hook 不能绕过 workspace 写入限制。

## 生命周期 Hooks

| Hook | 触发位置 |
|---|---|
| `compile.start` | 配置、审计和插件初始化完成后 |
| `compile.afterClarify` | 澄清问答及用户补充收集后 |
| `compile.beforeDecompose` | Planner 生成计划之前 |
| `compile.afterPlan` | 计划校准后、Schema/Lint 之前 |
| `compile.finish` | 计划和文档持久化后 |
| `llm.before/after/error` | 每次完整 LLM 调用外围 |
| `run.before/after/error` | DomainExecutionEngine 整体运行外围 |
| `step.before/after/error` | 单个 V 模型 Step 外围 |
| `step.attempt.before/after` | 正常执行或 DEBUG retry 的每次尝试外围 |
| `tool.before/after/error` | Tool 调用外围（仍受 EditGuard 保护） |

同一 Hook 按 `priority` 从大到小执行；优先级相同时保持插件数组与注册顺序。插件错误默认记录审计并继续，插件可声明 `failureMode: 'fail'`，宿主也可启用 `strict` 强制失败。

## 示例

```ts
import type { XCompilerPlugin } from '@xcompiler/cli/plugins';
import { XCOMPILER_PLUGIN_API_VERSION } from '@xcompiler/cli/plugins';
import { runExecute } from '@xcompiler/cli/runtime';

export const policyPlugin: XCompilerPlugin = {
  manifest: {
    id: 'example.policy',
    displayName: 'Example Policy',
    description: 'Enforces organization plan policies.',
    version: '1.0.0',
    apiVersion: XCOMPILER_PLUGIN_API_VERSION,
    minXCompilerVersion: '0.2.4',
    license: 'Apache-2.0',
    keywords: ['policy', 'compliance'],
  },
  failureMode: 'fail',
  setup(api) {
    api.on('compile.afterPlan', ({ plan }) => {
      if (!plan.steps.some((step) => step.phase === 'UNIT_TEST')) {
        throw new Error('Every plan must contain a UNIT_TEST step.');
      }
    }, { priority: 100 });

    api.on('tool.before', ({ tool, args }) => {
      // 只做策略检查；实际写入仍由 Tool + EditGuard 完成。
      if (tool === 'write_file') console.log('write_file', args);
    });
  },
};
```

程序化调用：

```ts
import { loadPluginSources } from '@xcompiler/cli/plugins';

const plugins = await loadPluginSources({
  baseDir: process.cwd(),
  sources: [{
    manifestPath: 'plugins/example/plugin.json',
    entryPath: 'plugins/example/index.js',
  }],
});

await runExecute({
  workspace,
  planPath,
  plugins,
  pluginStrict: true,
});
```
