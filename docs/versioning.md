# XCompiler 版本管理

`package.json` 是 XCompiler 核心版本和 Plugin API 版本的唯一真源：

```json
{
  "version": "0.3.0",
  "xcompiler": { "pluginApiVersion": 2 }
}
```

`src/version.ts` 是自动生成的运行时常量，`package-lock.json` 由同一工具同步。不要手工修改这两个位置。

`npm run build` 通过 npm 的 `prebuild` 生命周期强制先执行 `version:check`；直接调用底层 `tsup` 不属于受支持的发布路径。`prepack` 和自举 qualification 也会独立重复校验，避免调用方使用 `--ignore-scripts` 时漏掉版本门禁。

## 常用命令

```bash
# 检查 package、lockfile、CLI 运行时常量是否一致
npm run version:check

# 重新按 package.json 生成其他版本元数据
npm run version:sync

# 设置下一个核心版本并同步全部位置
npm run version:set -- 0.1.4

# 准备一次本地发版（不 push）
npm run release:local -- v0.1.4
```

核心版本遵循 SemVer。发布 tag 必须是 `v<package version>`，例如 `v0.1.3`；Release workflow 会在测试和打包前强制校验，版本不一致时停止发布。二进制分发包内包含 `VERSION` 文件，CLI 的 `--version` 也读取同一个生成常量。

`release:local` 会要求工作区干净，然后同步 `package.json`、`package-lock.json` 与 `src/version.ts`，执行本地发版门禁（`version:check`、`npm audit --omit=dev`、`typecheck`、`lint`、`test`、`build`、`npm pack --dry-run`），提交 `chore: release <tag>`，并创建本地 annotated tag。它不会 push；完成后手工执行：

```bash
git push origin <branch>
git push origin <tag>
```

如果上一次本地 tag 创建错了但还没有推送远端，可使用 `npm run release:local -- v0.1.4 --replace-local-tag` 删除并重建本地 tag；该选项不会删除远端 tag。离线环境可加 `--skip-audit` 跳过本地 `npm audit`，但 GitHub Release workflow 仍会执行审计。

Plugin API 版本独立于核心版本，只在插件公共接口出现不兼容修改时递增整数主版本。插件自身使用 SemVer，并在 manifest 中强制声明 `apiVersion` 和 `minXCompilerVersion`；详细规则见 [plugin_api.md](plugin_api.md)。

审计内容默认使用 `redacted` 模式遮蔽 API key、token、密码等凭据。需要最小化留存时设置 `XC_AUDIT_CONTENT_MODE=metadata`（只保留长度和 SHA-256）；只有在受控环境确实需要完整回放时才使用 `full`。
