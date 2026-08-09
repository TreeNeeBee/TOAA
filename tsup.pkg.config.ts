// 用于"打包成单文件可执行程序"的专用 tsup 配置：
//   - 仅打 xcompiler 这一个统一入口（xcompiler build / xcompiler run 都走它）
//   - 输出 CJS 单文件（@yao-pkg/pkg 对 CJS 兼容性最佳，无需 ESM hack）
//   - bundle 全量依赖，目标 node24，方便 pkg 直接吃
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { xcompiler: 'src/cli/xcompiler.ts' },
  outDir: 'dist/pkg-build',
  format: ['cjs'],
  target: 'node24',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  minify: false,
  shims: true, // 让 __dirname / import.meta 在 cjs 下可用
  // The embedded runtime is Node 24; preserving `node:` avoids turning newer builtins such as
  // `node:sqlite` into nonexistent bare npm packages.
  removeNodeProtocol: false,
  // 把所有 npm deps 内联（pkg 之后只会看到这一个 .cjs 文件）。Node 24 的 SQLite builtin
  // 必须保持 external；把它归一化成 bare `sqlite` 会产生一个不存在的 npm 模块。
  noExternal: [/^(?!node:sqlite$).*/],
  banner: { js: '#!/usr/bin/env node' },
});
