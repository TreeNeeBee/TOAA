<p align="center">
  <img src="docs/assets/xcompiler-icon.png" alt="XCompiler logo" width="128" height="128" />
</p>

<h1 align="center">XCompiler</h1>

<p align="center">
  <strong>AI Software Factory Runtime</strong>
</p>

> Turn natural-language requirements into runnable, tested Python or TypeScript projects through an iterative V-model workflow.

<p align="center">
  <a href="https://www.npmjs.com/package/@xcompiler/cli"><img src="https://img.shields.io/npm/v/@xcompiler/cli.svg" alt="npm package" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node.js >= 24" /></a>
</p>

Languages: **EN** (default) · [简体中文](README.CN.md)

---

## What XCompiler Does

XCompiler is a reusable AI software factory runtime. It compiles a product request into an executable engineering plan, then runs that plan with sandboxed agents, guarded tools, tests, debug loops, audit logs, and resumable project state.

| Command | Role | Input | Output |
|---|---|---|---|
| `xcompiler build` | Compile requirements into a `phasePlan.json` plus the current phase plan, such as `plan.P1.json` | Requirement text (`-i req.md`, `-t topic.md`, or interactive input) | `topic.md`, `phasePlan.json`, `plan.P1.json`, `plan.md`, `<name>.xc` |
| `xcompiler run` | Execute the current phase through the V-model workflow | `phasePlan.json` | Runnable project, tests, docs, audit trail, updated progress |
| `xcompiler load` | Resume from a project file | `<name>.xc` | Continue the saved phase/task state |
| `xcompiler append` / `xcompiler evolve` | Add new requirements to an existing project | Existing workspace/project file plus new requirement | Incremental plan and implementation |
| `xcompiler acp` | Run as an ACP code-agent adapter | stdio JSON-RPC from an IDE/editor | Runtime-backed code-agent events and results |

The current architecture treats **Runtime as the only business entry point**. CLI and ACP are adapters: they parse input, load config, render output, and listen to Runtime events, while Runtime owns build/run/workflow/agent/tool/plugin/memory behavior.

---

## Iterative V-Model Pipeline

XCompiler combines a phase iteration model with the V-model. The planner first creates a high-level `phasePlan.json`, then expands only the active phase into a concrete `plan.P<N>.json`. Each current phase runs a full V-model cycle. After its iteration gate and project audit pass, it becomes `complete`; XCompiler activates the first dependency-ready phase and materializes only that phase's plan for the next run.

<p align="center">
  <img src="docs/assets/iterative-v-model-pipeline.svg" alt="Iterative V-Model Pipeline" />
</p>

V-model behavior:

- Each implementation Phase owns exactly eight canonical Steps: `REQUIREMENT_ANALYSIS`, `HIGH_LEVEL_DESIGN`, `DETAILED_DESIGN`, `CODE`, `UNIT_TEST`, `INTEGRATION_TEST`, `MODULE_TEST`, and `FUNCTIONAL_TEST`.
- Planner JSON is an immutable execution specification. Runtime compiles it into globally identified domain objects; only those objects own lifecycle state. Every one of them carries the same envelope — a UUIDv7 `id`, `objectType`, `projectId`, `revision`, and timestamps — and is committed through the object registry: Project, ProjectPlan/PhasePlan, Phase, Step, Ticket, ActorRegistration, TicketAssignment, TicketTraceEvent, ProjectManagementPlan, Decision, Risk, InteractionRequest, KPI, QualityAssessment, Changelist, Checkpoint, Deliverable, Report, Log, AuditEvent, and DomainEvent.
- `REQUIREMENT_ANALYSIS`, `HIGH_LEVEL_DESIGN`, `DETAILED_DESIGN`, and `CODE` generate the paired functional, module, integration, and unit baseline test plans/cases.
- `HIGH_LEVEL_DESIGN` defines system-level interfaces, external APIs, third-party libraries, and dependencies.
- `DETAILED_DESIGN` defines internal module structure and implementation details.
- S1-S4 author stage deliverables and the paired baseline suites. Their gates combine stage-specific deliverable/solution validation with baseline-test asset validation and execution.
- On the initial S1-S3 pass, product code does not exist yet, so only executable baseline execution is explicitly deferred; deliverables, solution evidence, and baseline test assets are still validated. S4 always executes its unit baseline. A correction originating at S4-S8 and routed back to S1-S3 must execute that source Step's exact baseline before redelivery.
- S5-S8 independently inspect the paired baseline, add risk-driven functional tests only in a verification-owned supplement namespace, freeze the combined suite, and execute it with deterministic external data. No individual Step owns a privileged live-network escape hatch.
- Each gate stores this contract structurally: `validationTypes` identifies deliverable, baseline, and supplemental-functional validation; `baselineExecutionPolicy` distinguishes initial pre-code deferral, required execution, and freeze-then-execute acceptance.
- The execution matrix is fixed: initial S1-S3 run deliverable validation and validate baseline assets but defer baseline execution; corrected S1-S3 work whose causal chain starts at S4-S8 runs both; S4 runs deliverable validation plus its baseline; S5-S8 run the frozen paired baseline plus their risk-driven supplemental functional tests.
- Missing or under-aligned deliverables, solutions, or tests open an `enhancement`; executable test/product failures open a `bug`. The owning stage reruns incrementally.
- S5 enforces line, branch, and test-case pass coverage; S6 enforces interface and integration-scenario coverage; S7 enforces module and contract coverage; S8 enforces functional, requirement, and end-to-end coverage. Each plan can override thresholds and bounded `tolerance`.
- A metric shortfall, incomplete artifact, or alignment gap opens an `enhancement`; an execution or test failure opens a `bug`. These are distinct Ticket types with distinct reporting and scoring effects.
- Each Phase has its own `deliveryGate` for complete deliverables, integrated build/tests, and declared real-user scenarios. Runtime executes those cases with Replay disabled, captures the operation, command, environment, timestamp, exit status, timeout, and output tails, then submits each failure to PM as a non-Ticket problem report.
- Tickets exist only inside a Phase. A Phase-external gate or future post-delivery adapter can submit problems, data, and captured scenes through the PM intake boundary; PM alone converts a validated report into a Phase-local Ticket, registers it, routes it upstream-first, and restarts the V-model correction flow. Post-delivery reactivation is reserved for a later release.
- Each Phase compiles to one `epic`, eight Step `story` Tickets, optional `task` Tickets with at most two nested task levels, and one delivery `story`. Dependencies are UUID references, never array positions or display names.
- Globally unique UUIDv7 `id` values own identity. Human labels such as `P1-S004` are stored in `name`; they are never foreign keys.
- A failure is filed against the Step that discovered it, and the V-model pairing picks the target; it never inherits the origin of whichever Change Request chain happened to be active. A Bug then routes to the paired source Step for Debug, and its root-cause fix produces a `change-request` carrying the contract delta, affected Step IDs, implementation plan, changelists, commits, and verification gates.
- A verification Step's gate runs two ownership domains — the paired baseline and the supplement the Step wrote itself. A defect confined to that supplement stays in the Step that wrote it; routing it to the paired source would hand that source a file it has no write access to. One failing baseline case is enough to send the whole finding back to the source.
- Two Change Requests propagating the same hop — same source Step, same target Step, same origin failure — fold into the one already carrying it rather than opening parallel chains.
- Repeated identical failures stop the Ticket instead of exhausting its budget. Recurrence is judged by a structural signature built from what the failure *is* — the failing cases, the failure kind, the stable part of the reason — and never from how the attempt happened to run: tool argv, the temporary directory a rerun is given, addresses, and counters all change between otherwise identical failures.
- Downstream CR work is incremental. A CR failure creates a linked Bug, blocks the parent CR, executes the paired-source repair and child CR verification, then resumes only the parent's remaining applications.
- A Bug closes only after the failure that opened it has been replayed at the Step that observed it and passed. Each Bug carries a verification contract naming that Step and the selectors to re-run; satisfying it appends an immutable verification record. An unsatisfied contract refuses the closure rather than raising: an unfinished corrective chain leaves the Bug open and its Story blocked, where the next chain to reach that gate can still finish it.
- Bug closure order is fixed: source repair -> all affected CR gates -> verified solution -> debug-wiki persistence. Retrieved fixes that fail are marked for review rather than accumulated as trusted context.
- Every report of a failure stays its own Ticket. PM compares registered Bugs before assignment and parks a structural duplicate — same target Step, same failure identity — against the earliest such Ticket, recording the routing decision. A parked duplicate is never scheduled and follows the original into whichever terminal state it reaches.
- A Change Request carries the propagation scope decided when its chain opened, so a repair confined to the paired baseline tests reaches its verification Step directly instead of walking every Step between.
- The PM application service owns Project/Phase/V-model advancement. It registers every Ticket, routes it to a registered role by capability, monitors state, records decisions, and caches a rebuildable project-status projection. Domain transition policies remain the final authority.
- PM normally creates project-context `epic` and `story` Tickets. Inside a Phase, the role that discovers technical work creates `task`, `bug`, `enhancement`, or `change-request`; at the Phase boundary, only PM may materialize a corrective Ticket from a structured problem report.
- Ticket ownership is an accepted Assignment. Every handoff appends an immutable, hash-chained trace event carrying actor, role, reason, assignment, correlation, and causation data.
- A Phase closes only when all eight Steps, Step stories, corrective Tickets, KPI assessments, and the delivery story are closed. The Project closes only after every dependency-ready Phase closes.
- Completed-phase debug must provide a real patch/rewrite or successful verification evidence.
- Network/API failures are treated as real gates: if the project API fails, the run must repair or switch API instead of hiding the failure.
- Quality assessments, changelists, checkpoints, reports, logs, and audit events are first-class registered objects. Delivery writes `docs/project-development-report.md` and links its Report object back to the owning Phase or Project.

---

## System Architecture

<p align="center">
  <img src="docs/assets/system-architecture.svg" alt="XCompiler System Architecture" />
</p>

Layer responsibilities:

- **Adapters**: argument/protocol parsing, config loading, user interaction, output rendering, exit codes.
- **Runtime**: Runtime API, Build Service, Run Service, Event Stream, and Permission Broker; the only business entry point.
- **Application / PM**: requirement planning, Ticket registration and capability routing, Project/Phase/V-model scheduling, correction and CR propagation, permission governance, quality gates, delivery, projections, and exact-state resume.
- **State policy**: canonical domain objects are the only runtime source of truth. Ticket types are `epic`, `story`, `task`, `bug`, `enhancement`, and `change-request`; Planner files contain no execution state.
- **Agents / Skills**: Agent Skills Specification directories with metadata-first planning, activation-time instructions, on-demand resources, and Runtime-constrained Tools.
- **Tools**: guarded file edits, program/test execution, API fetches, dependency edits, git snapshots.
- **LLM Router**: role chains, provider scores, cluster fallbacks, OpenAI-compatible/Ollama clients, audit.
- **Project container**: the root `control` space owns `<name>.xc`, `phasePlan.json`, and `plan.P<N>.json`; `.xcompiler/` owns shared PM state, immutable object revisions, Record/Replay, Debug Wiki, and complete audit records; `worktrees/master/` is the only authoritative product tree and release source. Ticket/Gate worktrees are temporary candidates and never become a second project tree.

The append-only object-registry event stream is the recovery source; its snapshot index and PM status cache are rebuildable. Each registry entry maps `id` to `objectType`, object path, parent, revision, content hash, and lifecycle state. Multi-object lifecycle changes commit through one repository unit of work with optimistic revision checks and a transactional event outbox. Adapters and agents cannot mutate these files directly.

---

## Install From npm

```bash
npm install -g @xcompiler/cli
mkdir xcompiler-demo && cd xcompiler-demo
cp "$(npm root -g)/@xcompiler/cli/config.example.yaml" config.yaml
cp "$(npm root -g)/@xcompiler/cli/.env.example" .env
# Edit .env and set OPENROUTER_API_KEY
xcompiler doctor
```

The template contains an explicit OpenRouter Free starter provider through the `type: openai` OpenAI-compatible interface. XCompiler has no implicit `llm.default`; every role must list its providers:

```yaml
model: openrouter/free
base_url: https://openrouter.ai/api/v1
context_window: 128K
```

`config.yaml`, `llm_scores.yaml`, and `llm_scores_user.yaml` are local files and are intentionally not committed. The npm package ships `config.example.yaml` and `.env.example` as templates. `llm_scores.yaml` is XCompiler-maintained runtime state; create `llm_scores_user.yaml` only when you want fixed local score overrides such as `provider: 0` to disable one provider.

---

## Quick Start

```bash
echo "Parse a DBC file into an Excel report" > req.md
xcompiler build -i req.md --yes
xcompiler run /tmp/xcompiler-<timestamp>/phasePlan.json
xcompiler load /tmp/xcompiler-<timestamp>/xcompiler-<timestamp>.xc
```

Source checkout development:

```bash
npm ci
cp .env.example .env
cp config.example.yaml config.yaml
npm run build
npm link
xcompiler --help
```

Dev mode without linking:

```bash
npm run dev -- build -i req.md --yes
npm run dev -- run path/to/phasePlan.json
```

Incremental development:

```bash
xcompiler build -w path/to/workspace -i feature_req.md --intent feature --yes
xcompiler evolve -w path/to/workspace -i refactor_req.md --intent refactor --yes
xcompiler append path/to/workspace/<name>.xc -i feature_req.md --yes
```

Self-bootstrap:

```bash
xcompiler bootstrap -r path/to/XCompiler -i self_req.md --yes
```

---

## Common Commands

| Command | Purpose |
|---|---|
| `xcompiler build -i <file>` | Build a phase plan from a requirement file |
| `xcompiler build -t <topic.md>` | Reuse a clarified topic and skip Gate 1 |
| `xcompiler run <phasePlan.json>` | Execute the active phase plan |
| `xcompiler run --debug-wiki-path <dir>` | Reuse and update a shared layered debug wiki path |
| `xcompiler load <name.xc>` | Load project config/progress and continue |
| `xcompiler append <name.xc> -i <file>` | Add a new requirement to an existing project |
| `xcompiler evolve -w <workspace> -i <file>` | Build and run an incremental change |
| `xcompiler acp` | Start the ACP code-agent stdio adapter |
| `xcompiler fixtures prepare <phasePlan.json>` | Record external interactions for deterministic verification |
| `xcompiler fixtures inspect` / `verify` | Inspect or integrity-check record/replay fixtures without live access |
| `xcompiler fixtures refresh <phasePlan.json>` | Replace active fixture records and preserve their supersession chain |
| `xcompiler doctor` | Check config, LLM providers, sandbox, and skills |
| `xcompiler ls` / `xcompiler show <stepId>` | Inspect plans and recent audit entries |
| `npm run release:local -- vX.Y.Z` | Prepare a local release commit and tag without pushing |

---

## Runtime Defaults

- **LLM**: no implicit model selection. The shipped template explicitly maps every role to an OpenRouter Free starter provider; users may replace those role lists with paid, local OpenAI-compatible, or Ollama providers. Missing/invalid keys produce provider/model/base URL/status/body diagnostics and an explicit key hint.
- **LLM routing**: role-specific provider chains, XCompiler-maintained dynamic scores, user overrides from `llm_scores_user.yaml`, and `tags: [cluster]` fallback score bands for aggregated routes such as `openrouter/free`.
- **Languages**: Python and TypeScript project generation, testing, execution, and entry checks.
- **Sandbox**: `subprocess` by default with an isolated environment (`inherit_env: false`); optional `docker` mode for enforceable network/resource isolation. `network: off` is rejected in subprocess mode because a host child process cannot enforce it.
- **Audit**: every run appends complete records to `.xcompiler/audit/audit.jsonl` and `.xcompiler/audit/process_log.md`. A separate, rebuildable `.xcompiler/audit/summary.md` indexes high-signal events and links to raw lines and immutable object revisions; it never replaces or truncates the source records.
- **Debug wiki**: Bug Ticket repairs retrieve LLM-wiki style prior fixes by compact `DebugBrief`. The wiki is a layered Markdown knowledge base: bundled `wiki/system` policy pages, bundled `wiki/agent` calibration pages, and local `wiki/external` resolved-Bug knowledge. Runtime regenerates `index.md` for review and `index.json` for retrieval, while `log.md` remains local append-only operational history. By default it is copied to the XCompiler path (`$XC_PATH/.xcompiler/debug-wiki` when `XC_PATH` is set, otherwise the package/repo root); use `--debug-wiki-path <dir>` to share a different root. A Bug closes only after its `bugResolutionPlan` and evidence are persisted; failed reused fixes are marked `needs_review`.
- **Security gates**: internal project operations are governed by Step outputs, tool allowlists, EditGuard, Ticket, sandbox, and Git gates without repeated external prompts. External resources are authorized once per Runtime task with `permissions.mode: request|auto|deny`; paths outside the project container are always denied, including in `auto` mode.
- **Record/replay**: external HTTP, LLM, and tool data support `off`, `record`, `replay`, `auto`, and `refresh`. Current project code, builds, and tests always execute; Replay supplies their external fixtures rather than reusing an old process exit code. S1-S4 may capture controlled data for baseline tests; S5-S8 use Record/Replay for deterministic supplements and frozen execution. The Phase delivery gate alone disables Replay for declared real-user scenarios. Fixture inspection validates hash chains and redaction and fails explicitly on missing, ambiguous, or corrupt records.
- **Agent Skills**: bundled file, web, test, debug, Record/Replay, Debug Wiki, dependency, review, security, profiling, CR, and delivery workflows follow the Agent Skills Specification. Planner sees metadata only; Run loads instructions and resources only for selected Skills. Plugin API 3 can add standard Skill directories without bypassing Runtime gates.

---

## Runtime Tuning

LLM routing is configured under `config.yaml -> llm.*`.

| Field | Default | Effect |
|---|---|---|
| `roles.<Role>` | role dependent | Ordered/scored provider chain for `Planner`, `Architect`, `Coder`, `Tester`, `Debugger`, and `ProjectManager`. Every role is configured here; `ProjectManager` judges delivery outcomes on the project's behalf and never executes a Step |
| `providers.<name>.context_window` | `128K` | Model input+output context capacity; accepts token counts such as `131072`, `128K`, or an empty value for the default |
| `llm_scores_user.yaml` | absent | Local user score overrides; `0` disables, `0.1..1` fixes effective priority |
| `cluster_score_min/max` | `0.2..0.5` | Dynamic score band for providers tagged `cluster`; user overrides may still use `0.1..1` |
| `agent.sandboxes.python.mode` | `subprocess` | Python project sandbox backend: local subprocess or Docker |
| `agent.sandboxes.typescript.mode` | `subprocess` | TypeScript project sandbox backend: local subprocess or Docker |
| `agent.sandboxes.<language>.local.inherit_env` | `false` | Opt in to host environment inheritance; keep false when the host contains API keys or other secrets |
| `max_rounds_per_step` | `6` | LLM dialogue limit within a normal step |
| `max_debug_rounds_per_step` | `max(8, 2 * max_rounds_per_step)` | Debugger round cap |
| Planner `Step.maxAttempts` | complexity-adaptive | Transactional Step attempts; minimum grows from simple to moderate/complex and with Phase count |
| `--debug-wiki-path <dir>` | XCompiler path `.xcompiler/debug-wiki` | Shared layered debug wiki root |
| `permissions.mode` / `--permission-mode` | `request` | External-resource authorization for this Runtime task: `request`, `auto`, or `deny`; internal project operations do not prompt |
| `permissions.timeout_ms` | `0` | Permission wait timeout; `0` waits until the user answers or cancels |
| `max_edit_lines_per_step` | `auto` | Adaptive EditGuard cumulative write-line budget |
| `agent.sandboxes.<language>.<local\|docker>.limits.network` | `download-only` | Docker supports enforceable `off`; subprocess rejects `off` instead of claiming isolation it cannot provide |
| `providers.<name>.tcp_keepalive_ms` | `30000` | Idle time before the kernel probes the connection. A socket left by a dropped network never receives RST/FIN, so probing is what turns it into a real connection error; `0` disables |
| `providers.<name>.stream_headers_timeout_ms` | `30000` | Streaming only: a response-header deadline. A streaming server writes headers before it starts thinking, so missing headers is a connection problem while slow tokens are a model problem; `0` removes the limit |
| `stall_diagnosis_after_ms` | `600000` | Run one environment diagnosis when a peer sends no bytes for this long, and attach the verdict to the failure |

---

## Documentation

| Path | Content |
|---|---|
| [docs/openrouter.md](docs/openrouter.md) | OpenRouter Free-mode setup and OpenAI-compatible provider notes |
| [docs/acp.md](docs/acp.md) | ACP code-agent adapter protocol notes |
| [docs/agent_skills.md](docs/agent_skills.md) | Agent Skills contract, built-in catalog, security boundaries, and Plugin API 3 |
| [docs/XCompiler_design.md](docs/XCompiler_design.md) | Core design and V-model concepts |
| [docs/XCompiler_project_constraints.md](docs/XCompiler_project_constraints.md) | Architecture, ownership, lifecycle, and layout constraints the project must preserve |
| [docs/XCompiler_project_constraints.md](docs/XCompiler_project_constraints.md) | Current architecture, PM/Ticket lifecycle, workspace, and release constraints |
| [docs/plugin_api.md](docs/plugin_api.md) | Plugin API, lifecycle hooks, tools, skills |
| [docs/versioning.md](docs/versioning.md) | Version sources, release script, tag policy |
| [docs/self_bootstrap.md](docs/self_bootstrap.md) | Self-bootstrap and qualification gates |
| [docs/deploy.md](docs/deploy.md) | Local, Docker, and native package deployment |
| [docs/XCompiler_user_fixture_plan.md](docs/XCompiler_user_fixture_plan.md) | Open design: supplying a real user fixture to a run (`--fixture`); decided, not yet implemented |
| [docs/archive/](docs/archive/) | Delivered design and refactor plans, kept for the reasoning behind decisions the code no longer explains. Not current documentation |

---

## Tests

```bash
npm run version:check
npm run typecheck
npm run lint
npm test
npm run build
```

Suites are split by the capabilities they need, so a restricted environment can still run a full
deterministic gate instead of reporting environment limits as product failures:

```bash
npm run test:core          # deterministic only; no sockets, no spawned processes
npm run test:integration   # loopback HTTP servers and real subprocesses
npm run test:e2e           # spawns the real CLI/ACP process
```

The release gate always runs the complete current suite; no fixed historical test count is used as an acceptance claim.

---

## License

[Apache License 2.0](LICENSE) © 2026 The XCompiler Authors. See [NOTICE](NOTICE) for details.
