# XCompiler 部署指南（deploy）

> 适用版本：`@xcompiler/cli ≥ 0.1.0`
> 两种部署方式：
>
> 1. **本地（Local）**：宿主机直接装 Node 24 + Python 3，用 `npm link` 暴露 `xcompiler` 命令。开发与单机生产首选。
> 2. **Docker**：多阶段构建的 `xcompiler:latest` 镜像 + `docker compose`。适合 CI、共享服务器、网络隔离的生产环境。

---

## 0. 前置条件（两种方式通用）

| 组件 | 版本 | 用途 |
|---|---|---|
| **LLM 服务** | OpenRouter API key（默认 Free mode）**或** 任一 OpenAI-compatible endpoint；Ollama 可作为本地备选 | XCompiler 的所有 Agent 推理 |
| **Git** | 任意现代版本 | XCompiler 在 workspace 内做 snapshot/revert（每个 Step 一次提交）|
| **Python 3.11+** | （仅 `sandbox=subprocess` 必需，docker 模式可省）| 沙盒内运行 pip / pytest |

> **网络要求**：沙盒在 `pip install -r requirements.txt` 时需要可达的 PyPI 镜像。建议在 shell 注入：
> `PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`（或阿里云、内网 mirror）。

---

## 1. 本地部署（Local）

### 1.1 安装 Node 与依赖

```bash
# Linux/macOS
curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz | sudo tar -xJ -C /opt
export PATH=/opt/node-v24.18.0-linux-x64/bin:$PATH
node -v   # v24.x

# 克隆并装包
git clone <repo-url> xcompiler && cd xcompiler
npm ci
```

### 1.2 配置

```bash
cp .env.example .env
# 编辑 .env：
#   OPENROUTER_API_KEY=<your-key>
#   OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
#   OPENROUTER_MODEL=qwen/qwen3-coder:free

cp config.example.yaml config.yaml
# 关键字段（详见 README.md 与 docs/openrouter.md）：
#   llm.providers.<name>.type: openai | ollama
#   llm.roles.{Planner|Architect|Coder|Tester|Debugger}: provider 名数组
#   agent.sandboxes.python.mode / agent.sandboxes.typescript.mode: subprocess | docker
#   agent.max_rounds_per_step / max_debug_rounds_per_step
```

### 1.3 构建并安装为全局命令

```bash
npm run build       # tsup -> dist/
npm link            # 注册 xcompiler / xcompiler_build / xcompiler_run 到 $PATH

xcompiler --help
xcompiler --version
```

> **不想 `npm link`？** 直接用 `npx`：`npx -p . xcompiler --help`，
> 或在开发期 `npm run dev -- build -i workspace/intake.md`（tsx 直跑 TS）。

### 1.4 烟测

```bash
# 1) 单测（不依赖 LLM）
npm run typecheck
npm test                           # 全部套件
npm run test:core                  # 仅确定性套件；受限沙箱（禁止监听 127.0.0.1）中也能跑
npm run test:integration           # 需要本机回环端口与真实子进程
npm run test:e2e                   # 拉起真实 CLI/ACP 进程

# 2) OpenRouter endpoint 烟测（需 .env 中 OPENROUTER_API_KEY 可用）
set -a
. ./.env
set +a
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY"

# 3) 端到端编排
mkdir -p /tmp/hello-demo && cat > /tmp/hello-demo/intake.md <<'EOF'
开发一个 Python 包 hello，提供 hello.greet(name) -> str；至少 3 个 pytest 用例。
EOF
xcompiler build -o /tmp/hello-demo -i /tmp/hello-demo/intake.md --yes
xcompiler run /tmp/hello-demo/phasePlan.json
```

### 1.5 升级

```bash
cd xcompiler
git pull
npm ci
npm run build
# npm link 一次性建立的符号链接会自动指向新 dist/
```

### 1.6 卸载

```bash
npm unlink -g @xcompiler/cli
rm -rf <repo>/node_modules <repo>/dist
```

---

## 1.7 单文件可执行程序（无 Node 依赖）

> 适合分发到**没有 Node 环境**的目标机器。打出来的可执行程序内嵌了 Node 24 + 全部 JS 依赖，
> 终端用户只需要把单文件 `xcompiler` / `xcompiler.exe` 解压后直接运行即可。
>
> ⚠️ **注意**：单文件可执行程序仍然需要目标机器自带 **Python 3.11+ / git** —— 它们用于沙盒（pip / pytest）和 snapshot/revert。这是 XCompiler 自身的运行期依赖，不在打包范围内。

### 1.7.1 本机原生打包与全目标发版

```bash
# 自动识别当前 Linux/macOS 的架构，只打本机可直接运行的目标
npm run package

# 发版模式：linux-x64 / linux-arm64 / macos-arm64 / win-x64 全部打包
npm run package:all
```

全目标模式会由 `@yao-pkg/pkg` 按需下载各平台的 Node 基础二进制，因此首次执行需要访问其 GitHub Releases；CI 发版固定使用该入口。本机原生模式只需要当前平台的基础二进制。

产物布局：

```
dist/pkg/
├── xcompiler-linux-x64/
│   ├── xcompiler                      # ELF 64-bit, x86_64
│   ├── README.md  LICENSE  NOTICE
│   ├── config.example.yaml  .env.example
├── xcompiler-linux-x64.tar.gz         # 打包发布用
├── xcompiler-linux-arm64/
│   ├── xcompiler                      # ELF 64-bit, aarch64
│   └── ...（同上）
├── xcompiler-linux-arm64.tar.gz
├── xcompiler-macos-arm64/
│   ├── xcompiler                      # Mach-O 64-bit, arm64（已 ad-hoc 签名）
│   └── ...
├── xcompiler-macos-arm64.tar.gz
├── xcompiler-win-x64/
│   ├── xcompiler.exe                  # PE32+, x86_64 — ⚠️ v0.1.0 未在 Windows 实机验证
│   └── ...
└── xcompiler-win-x64.zip              # 需要本机有 zip 命令；否则只产生目录
```

> **macOS Apple Silicon 原生目标为 macos-arm64**；`npm run package` 会在 Apple Silicon Mac 上自动选择该目标。
> 关键点：
>
> - `--no-bytecode` 已默认开启 — 解决 V8 bytecode snapshot 在 Node 24 readline / NDJSON HTTP 流场景下的 SIGSEGV。
> - 强制代码签名 — macOS 本机使用系统 `codesign` 执行并验证 ad-hoc 签名；Linux 交叉打包 macOS 目标时使用 `ldid`。
> - macos-x64（Intel Mac）会在 Intel Mac 上被自动选择，也可显式执行 `npm run package:macos-x64`。

### 1.7.2 单目标打包

```bash
npm run package:linux-x64
npm run package:linux-arm64
npm run package:macos-arm64
npm run package:macos-x64
npm run package:win-x64

# 或直接调脚本
./scripts/package.sh linux-x64 win-x64
./scripts/package.sh macos-arm64 macos-x64
./scripts/package.sh native
./scripts/package.sh all
TARGETS="linux-arm64" ./scripts/package.sh
```

### 1.7.3 终端用户的使用流程

**Linux**:

```bash
tar -xzf xcompiler-linux-x64.tar.gz
cd xcompiler-linux-x64
cp config.example.yaml ~/.xc/config.yaml      # 按需编辑
./xcompiler --help
./xcompiler build -i intake.md -o ~/myproj --yes
./xcompiler run ~/myproj/phasePlan.json
```

**Windows**（PowerShell）：

> ⚠️ **v0.1.0 状态**：`xcompiler-win-x64.exe` 已能成功打包，但**尚未在 Windows 实机上端到端验证**（沙盒 / git snapshot / pytest 流程）。建议作为预览版试用，遇到问题请提 issue。Linux / macOS Apple Silicon 已通过完整回归。

```powershell
Expand-Archive xcompiler-win-x64.zip
cd xcompiler-win-x64
copy config.example.yaml $env:USERPROFILE\.xc\config.yaml
.\xcompiler.exe --help
.\xcompiler.exe build -i intake.md -o C:\myproj --yes
.\xcompiler.exe run C:\myproj\phasePlan.json
```

### 1.7.4 实现细节（如何打的包）

| 阶段 | 工具 | 输入 → 输出 |
|---|---|---|
| 1. 构建 CJS 单包 | [tsup.pkg.config.ts](../tsup.pkg.config.ts) | `src/cli/xcompiler.ts` → `dist/pkg-build/xcompiler.cjs`（约 1.7 MB，已 inline 全部依赖）|
| 2. 跨平台编译 | `@yao-pkg/pkg` (vercel/pkg 维护活跃 fork) | `xcompiler.cjs` + 内置 Node20 → 各目标平台 native binary（约 55 MB）|
| 3. 压缩发布 | `tar` / `zip` | `xcompiler-<target>/` → `xcompiler-<target>.tar.gz` / `.zip`（约 21 MB）|
| 4. 完整性校验 | `sha256sum` / `shasum` | 所有压缩包 → `dist/pkg/SHA256SUMS` |

脚本主入口：[scripts/package.sh](../scripts/package.sh)。配置都集中在 `tsup.pkg.config.ts` 与 `package.json -> scripts`。

> **为什么不打 `xcompiler_build` / `xcompiler_run` 单独的 exe？**
> `xcompiler` 是统一入口，`xcompiler build` ≡ `xcompiler_build`，`xcompiler run` ≡ `xcompiler_run`。一个 60 MB 的可执行文件
> 可以承担全部子命令；如果想要 `xcompiler_build.exe` 这种命名，复制重命名即可，行为不变。

> **Windows .zip 需要 zip 命令**：选择 Windows 目标但检测不到 `zip` 时，脚本会终止发版，避免留下不完整的发布产物。Linux / WSL 上可执行 `apt install zip` 安装。


---

## 2. Docker 部署

### 2.1 镜像结构

[Dockerfile](../Dockerfile) 是两阶段：

| Stage | 基础镜像 | 用途 |
|---|---|---|
| `build` | `node:20-bookworm-slim` | `npm ci` + `npm run build` 生成 `dist/` |
| `runtime` | `node:20-bookworm-slim` + `python3 / python3-venv / git / docker.io / tini` | 仅装 production deps，运行 `xcompiler` |

启动时 `tini` 做 PID 1，运行用户为 `xcompiler (uid=1000)`，工作目录 `/workspace` 以 volume 形式暴露。

### 2.2 构建镜像

```bash
cd xcompiler
docker build -t xcompiler:latest .
# 或带版本 tag：docker build -t xcompiler:0.1.3 -t xcompiler:latest .
```

### 2.3 配置文件准备

```bash
cp .env.example .env
cp config.example.yaml config.yaml
mkdir -p workspace
```

### 2.4 用 docker compose 跑（推荐）

[docker-compose.yml](../docker-compose.yml) 已挂好：
- `./workspace -> /workspace`（编排产出）
- `./config.yaml -> /home/xcompiler/app/config.yaml:ro`
- `/var/run/docker.sock -> /var/run/docker.sock`（DooD：让容器内 xcompiler 能起 sibling 沙盒容器）

```bash
# 看帮助
docker compose run --rm xcompiler --help

# 编译需求 -> phasePlan.json + 当前阶段 plan.P<N>.json（写到指定输出目录）
docker compose run --rm xcompiler build \
  -i /workspace/intake.md \
  -c /home/xcompiler/app/config.yaml \
  -o /workspace/hello-demo \
  --yes

# 执行当前阶段计划
docker compose run --rm xcompiler run \
  /workspace/<project>/phasePlan.json \
  -c /home/xcompiler/app/config.yaml
```

> **DooD 的 GID 注入**：宿主 `/var/run/docker.sock` 的属主 GID 通常是 `999` 或 `998`。
> 默认 `group_add: ["999"]`；如果不同，请：
>
> ```bash
> DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose run --rm xcompiler ...
> ```

### 2.5 直接 `docker run`（不要 compose）

```bash
docker run --rm -it \
  --env-file .env \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/config.yaml:/home/xcompiler/app/config.yaml:ro" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -w /workspace \
  xcompiler:latest \
  build -i /workspace/intake.md -c /home/xcompiler/app/config.yaml --yes
```

### 2.6 沙盒模式选择

`config.yaml -> agent.sandboxes.<language>.mode`：

| 模式 | 适用场景 | 说明 |
|---|---|---|
| `subprocess` | **容器部署唯一支持项** / 轻量本地 | 直接在宿主或 XCompiler 镜像内创建语言专属本地沙盒。简单，最快。默认推荐。 |
| `docker` | **仅限宿主部署使用** | 在宿主 docker daemon 上起 sibling 容器（image 由 `agent.sandboxes.<language>.docker.image` 指定）。 |

> ⚠️ **容器内不可使用 `mode: docker`**。XCompiler 启动时会检测运行环境（`/.dockerenv` / `/proc/1/cgroup` / `XC_IN_CONTAINER` env），若检测到在容器内且当前语言 sandbox 使用 Docker，将报错退出并提示改用 `subprocess`。
>
> 原因：DooD 路径错位、`docker.sock` GID 冲突、sibling 容器看不到 XCompiler 容器内的 `/workspace` 路径。
>
> 如确需绕过（宿主与容器路径完全一致的可控调试场景）：`-e XC_IN_CONTAINER=0`。

[Dockerfile](../Dockerfile) 已预设 `ENV XC_IN_CONTAINER=1`。

### 2.7 内置 Ollama（可选备份）

默认配置不需要内置 Ollama。如要在同一 compose 中跑 Ollama 作为 `type: ollama` 备选 provider，
编辑 [docker-compose.yml](../docker-compose.yml) 取消注释 `ollama` 服务与对应 volume，然后：

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull gemma4:31b
docker compose exec ollama ollama pull qwen3-coder:30b
# 在 .env 里把 OLLAMA_BASE_URL 改成 http://ollama:11434
```

### 2.8 升级

```bash
cd xcompiler
git pull
docker build -t xcompiler:latest .
# compose run 会自动用新镜像；workspace 与 config.yaml 不会被 rebuild 影响
```

### 2.9 清理

```bash
docker compose down
docker rmi xcompiler:latest
# workspace/ 与 .env / config.yaml 是宿主文件，保留或手动删
```

---

## 3. 常见问题

| 现象 | 原因 | 处置 |
|---|---|---|
| `pip install` 在沙盒里 DNS 失败 | 宿主到 PyPI 不通 | 设 `PIP_INDEX_URL=<可达镜像>` 注入到 XCompiler 进程环境 |
| docker 模式下沙盒容器找不到工程文件 | 用了 `./workspace` 相对路径 | 改成绝对路径或 `$(pwd)/workspace` |
| `EACCES: /var/run/docker.sock` | `xcompiler` 用户不在宿主 docker 组 | `DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) docker compose ...` |
| 长时 LLM 调用后 `audit.jsonl` 没事件 | （已修）旧版异步 appendFile 排队丢失 | 升级到当前版本：审计已改为 `appendFileSync` |
| `Plan schema 校验失败` | LLM 返回 plan 字段类型异常 | 查看 `<workspace>/docs/.draft/plan.invalid.json` 定位字段，必要时调高 `agent.max_rounds_per_step` 或换更强模型作为 Planner |
| 测试阶段达到 Step attempt 上限 | Bug/CR 链未能通过配对验证 | 先查看 `<project-root>/.xcompiler/audit/summary.md`，再按链接访问 `audit.jsonl` 和 Ticket revision；修复配置或环境后重新执行 `xcompiler run`，Scheduler 会从精确的未完成 Ticket 恢复，不能跳过 Step |

---

## 4. 目录约定

部署完成后的 0.3 项目容器结构：

```
<project-root>/
├── intake.md                # 需求输入（用户提供）
├── config.yaml              # 本次运行的配置
├── phasePlan.json           # 阶段总览与当前阶段指针
├── plan.P1.json             # 当前阶段的 V 模型执行计划
├── <name>.xc                # 项目控制入口
├── .xcompiler/
│   ├── audit/
│   │   ├── audit.jsonl      # 完整、只追加的机器审计真源
│   │   ├── process_log.md   # 完整的人类可读过程记录
│   │   └── summary.md       # 可重建摘要与详细记录链接
│   ├── objects/             # 不可变领域对象 revision
│   ├── registry/            # 对象索引与事件链
│   ├── record-replay/
│   └── history/docs/        # 同名旧文档归档
└── worktrees/master/        # 唯一发布工程主线
    ├── requirements.txt / package.json
    ├── docs/
    ├── src/
    └── tests/
```
