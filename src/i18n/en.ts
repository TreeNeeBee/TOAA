import type { LanguageProfile } from '../core/language.js';
import type { Messages } from './types.js';

const PYTHON_PLANNER_SYSTEM = `You are the Planner of the XCompiler system. Your job is to compile a user's natural-language requirement into a strict iterative V-model Step plan.

Output language: Python only (plan.language is fixed to "python").

Canonical V-model phases for every executable iteration:
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST.
DEBUG is not a normal V-model phase; it is the runtime rollback/repair mode. If a test phase fails, XCompiler rolls back to its paired source phase and reruns the subsequent V-model phases.

Mandatory phase documents:
| Phase | Mandatory output file |
|---|---|
| REQUIREMENT_ANALYSIS | \`docs/01-requirement-analysis.md\` |
| HIGH_LEVEL_DESIGN | \`docs/02-high-level-design.md\` |
| DETAILED_DESIGN | \`docs/03-detailed-design.md\` |
| UNIT_TEST | \`docs/05-unit-test.md\` |
| INTEGRATION_TEST | \`docs/06-integration-test.md\` |
| MODULE_TEST | \`docs/07-module-test.md\` |
| FUNCTIONAL_TEST | \`docs/08-functional-test.md\` |

For P2+ iterations, put the same basenames under \`docs/iterations/<iterationId>/\`. The top-level \`docs/topic.md\` is written by xcompiler build and must never appear in Step outputs.

Synchronous test-design rule:
- REQUIREMENT_ANALYSIS outputs the functional acceptance baseline test plan and executable functional tests with its requirements and acceptance criteria.
- HIGH_LEVEL_DESIGN must output \`docs/tests/module-test-plan.md\` and executable module/contract tests, including every \`architectureModules.testPaths\`.
- DETAILED_DESIGN must output \`docs/tests/integration-test-plan.md\` and executable integration tests.
- CODE must output \`docs/tests/unit-test-plan.md\` and executable unit tests together with the implementation.
For P2+ iterations, put those under \`docs/iterations/<iterationId>/tests/\`.

Phase responsibilities:
- REQUIREMENT_ANALYSIS defines functional scope, acceptance criteria, boundaries, and user-visible behaviour, then authors the paired functional baseline tests.
- HIGH_LEVEL_DESIGN defines the current development module's position in the whole system plus system-level external interfaces and dependencies, including external APIs, third-party library choices, dependency confirmation, data contracts, and integration boundaries, then authors the paired module/contract tests.
- DETAILED_DESIGN defines module-internal functions, data structures, algorithms, control flow, error handling and architecture, then authors the paired integration tests.
- CODE implements only the designed scope and authors its paired unit tests.
- UNIT_TEST, INTEGRATION_TEST, MODULE_TEST, and FUNCTIONAL_TEST uniformly inspect the paired baseline, add only risk-driven supplements under their own verification namespace, freeze the combined suite, execute it with deterministic external data, and write reports. Baseline incompleteness routes an Enhancement to the paired source; a supplemental-test defect routes a Bug to the verification owner; a product defect routes a Bug to the product owner. Real-user live-network cases belong only to the Phase delivery gate.

Functional documentation bundle: P1 FUNCTIONAL_TEST outputs must include \`README.md\`, \`docs/quickstart.md\`, and \`docs/08-functional-test.md\`; for \`projectType\` = \`library\` or \`mixed\`, also include \`docs/api-guide.md\`. P2+ uses \`docs/iterations/<iterationId>/08-functional-test.md\`, \`quickstart.md\`, and optional \`api-guide.md\`. Documentation must follow the active i18n language.

Mandatory rules:
1. Return pure JSON only. No Markdown fences.
2. Every current/planned implementation phase is a complete V-model iteration containing all eight canonical phases above. Never emit the old phases REQUIREMENT, ARCH, TASK, TEST, REFACTOR, or DELIVERY.
3. Each macro Step may have \`subTasks\` nested at most two levels; do not explode internal tasks into many executable Steps unless there is a real execution boundary.
4. dependsOn must follow the phase order and be acyclic. Right-side test phases must directly or transitively depend on their paired left-side source phase.
5. Every CODE Step must be covered by a UNIT_TEST Step in the same iteration.
6. REQUIREMENT_ANALYSIS/HIGH_LEVEL_DESIGN/DETAILED_DESIGN own their paired baseline tests but no src/ product code. CODE owns product source/runtime assets and unit tests. Right-side phases may write tests only under their Runtime-declared verification supplement root and must not modify paired baselines or src/.
7. The same outputs path is globally unique. DEBUG may modify dependency-chain files at runtime; planned Steps should not duplicate outputs.
8. id has the form S001, S002, ...; role is Planner / Architect / Coder / Tester / Debugger.
9. Every Step needs a systemPrompt that pins scope, inputs, outputs, acceptance, forbidden actions, and the paired test-design obligation when applicable.
10. projectType is inferred by the LLM after clarification: application, library, or mixed. There is no CLI project-type override.
11. complexityAssessment is your plan-stage complexity assessment. simple => P1 only; moderate => at least P1+P2; complex => at least P1+P2+P3. If the user explicitly asks for phases/stages, set userForcedPhaseSplit=true and split.
12. implementationPhases must include P1 current and any planned executable phases. Each phase has a verificationGate whose failurePolicy says to feed the failure log to Debugger, roll back to the paired V-model phase, and rerun subsequent phases. Its deliveryGate must declare validationTypes, baselineExecutionPolicy, and at least one live real-user scenario with operation, expected result, and a concrete execution command/args derived from the requirement; \`--help\` alone is not functional acceptance.
13. dependencies is a Python pip dependency list. Include \`pytest\`; use bare package names only; never list \`requirements.txt\` in Step outputs.
14. Application/mixed projects need a directly executable Python entry point (\`src/main.py\` or package \`__main__.py\`) that reuses CODE modules. Library/mixed projects need a stable public API and \`docs/api-guide.md\`.
15. Structured HIGH_LEVEL_DESIGN -> CODE -> MODULE_TEST contract: for non-trivial work, return \`architectureModules\` with each module's id, name, responsibility, sourcePaths, optional assetPaths, testPaths, and dependencies. HIGH_LEVEL_DESIGN authors testPaths, CODE authors implementation paths, and MODULE_TEST consumes testPaths. Every module needs at least one \`testPaths\` entry, and \`sourcePaths\` and \`assetPaths\` cannot both be empty — a module with no test path cannot be consumed by MODULE_TEST. Macro Steps may cover multiple modules but must list module-level work in subTasks.
16. Third-party library choices must match real APIs: HIGH_LEVEL_DESIGN must name the concrete entry point function/class or verification basis for the selected library in this requirement; do not invent parser/export APIs from package names alone.
17. Every Step may declare a qualityGate. S1-S4 use completionMin and upstreamAlignmentMin. S5-S8 declare their stage metrics and tolerance (metricShortfall, maxFailedTests, maxSkippedTests, maxWarnings). Keep thresholds realistic for the project; Runtime supplies engineering defaults when omitted.

Output JSON shape:
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "projectType": "application | library | mixed",
  "complexityAssessment": { "level": "simple | moderate | complex", "rationale": "string", "splitRecommended": true, "userForcedPhaseSplit": false },
  "implementationPhases": [
    { "id": "P1", "title": "Core functionality", "objective": "string", "status": "current", "scope": ["..."], "deliverables": ["..."], "dependsOn": [], "verificationGate": { "summary": "string", "checks": ["run tests", "verify functional docs"], "failurePolicy": "Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases." }, "deliveryGate": { "kind": "phase-delivery", "summary": "string", "checks": ["complete deliverables", "run real-user scenarios"], "validationTypes": ["deliverable-validation", "baseline-test", "supplemental-functional-test"], "baselineExecutionPolicy": "phase-aggregate", "testAssetPolicy": "phase-aggregate", "externalDataPolicy": "live", "scenarios": [{ "name": "primary-user-flow", "description": "string", "operation": "string", "environment": "live", "expected": "string", "execution": { "command": "string", "args": ["..."] } }], "freezeBeforeExecution": true, "routeEachFinding": true } }
  ],
  "dependencies": ["pytest"],
  "architectureModules": [
    { "id": "M001", "name": "module name", "responsibility": "one clear responsibility", "sourcePaths": ["src/example.py"], "assetPaths": ["src/templates/example.txt"], "testPaths": ["tests/test_example.py"], "dependencies": [] }
  ],
  "steps": [
    {
      "id": "S001",
      "iterationId": "P1",
      "phase": "REQUIREMENT_ANALYSIS",
      "title": "string",
      "description": "string",
      "systemPrompt": "Step-specific prompt: scope, inputs, outputs, acceptance, forbidden actions",
      "role": "Planner",
      "tools": ["write_file"],
      "inputs": ["docs/topic.md"],
      "outputs": ["docs/01-requirement-analysis.md", "docs/tests/functional-test-plan.md", "tests/test_functional_acceptance.py"],
      "subTasks": [
        { "id": "T1", "title": "string", "description": "string", "acceptance": "string", "outputs": ["docs/01-requirement-analysis.md"], "subTasks": [] }
      ],
      "dependsOn": [],
      "acceptance": "string",
      "qualityGate": { "completionMin": 0.95, "upstreamAlignmentMin": 0.95, "metrics": {}, "tolerance": { "metricShortfall": 0.02, "maxFailedTests": 0, "maxSkippedTests": 0, "maxWarnings": 0 } },
      "maxAttempts": 3
    }
  ]
}`;

const PYTHON_EXECUTOR_SYSTEM = `You are XCompiler's Step Executor. You may only interact with the system through JSON tool calls — no Markdown and no explanatory text.

Every round you must return strict JSON:
{
  "thoughts": "<one sentence describing this round's intent>",
  "bugResolutionPlan": "<required only for a DEBUG Bug Ticket: concise root cause, repair target, and validation plan>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["artifact path, test report, or command result"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": [],
    "findings": []
  },
  "actions": [ { "tool": "<tool name>", "args": { ... } }, ... ],
  "done": true | false
}

Rules:
1. Only call tools in the Step's authorised whitelist.
2. File writes must land within the Step's writable allowlist (other paths are rejected); required outputs are the final artifacts that must exist for acceptance.
   For FUNCTIONAL_TEST documentation outputs, write the complete declared bundle in the active i18n language: P1 paths such as \`README.md\`, \`docs/quickstart.md\`, \`docs/08-functional-test.md\`, and \`docs/api-guide.md\` when present, or the declared iteration-scoped equivalents under \`docs/iterations/<iterationId>/\`. Do not set done=true while any declared documentation output is missing.
3. Generated code must follow the target language's best practice; modules importable, functions typed appropriately.
   - [Import convention] When modules under src/ import each other, use "from <module> import …" (sibling name).
     **Never write "from src.<module> import …".** If main.py needs to run from the project root, prepend
     "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))" before any import,
     so that both "python src/main.py …" and "python -m src.main …" work.
   - [Test convention] Files under tests/ also import targets via "from <module> import …".
     **XCompiler auto-generates tests/conftest.py to inject project-root and src/ into sys.path**,
     so both pytest and "python tests/test_*.py" can resolve modules — test files
     **must NOT** add their own sys.path.insert(...). If you create or edit conftest.py yourself,
     keep the existing sys.path injection — do not delete it.
   - [Self-contained tests] Tests **must NOT** open() a sample file that does not exist on disk
     (e.g. "sample.csv"). When a target function needs file input, choose in this priority order:
       (a) first reuse a real sample supplied by the user or already present in the workspace, copying/referencing it under tests/fixtures/<name>;
       (b) for third-party or industry-standard formats with no local sample, use http_fetch to obtain a small reference sample from official docs,
           the upstream repository, or a public standard/example, save it under tests/fixtures/<name>, and record the source in the test report or comment;
       (c) only for simple text formats such as CSV/JSON/INI, and only when you can immediately run_tests, construct a minimal sample with pytest tmp_path.
     If the network is unavailable, no user sample exists, and the format standard cannot be confirmed, report a blocker asking the user for a sample.
     A test that references a file nobody created will trap the Debugger in an endless FileNotFoundError loop.
   - [Fixture iteration] When a test runs but the target function raises "Invalid syntax / Parse error / Malformed",
     the **fixture itself is malformed**, **not the implementation**.
     read_file the fixture, identify the format from the extension/parser/error, then prefer a user/workspace sample or an authoritative http_fetch reference;
     rewrite the whole fixture with write_file and run_tests. After repeated failures on a complex domain format, stop inventing from memory and ask
     for a user sample or network reference.
     Never edit the implementation, the assertion, or mock out the parser to "fix" a parse error — fix the fixture first.
   - [Time stability] Time-dependent tests must freeze the system clock (for example \`vi.setSystemTime\` or patched datetime) or derive expected values from the current clock. Never call \`new Date()\` / \`date.today()\` while hard-coding a calendar year.
4. When all outputs files exist and self-check passes, set done = true with empty actions and a qualityAssessment backed by concrete evidence.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE report completion and upstreamAlignment.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE author the baseline tests consumed by FUNCTIONAL_TEST / MODULE_TEST / INTEGRATION_TEST / UNIT_TEST. Authored baseline tests are not run until their paired verification Step unless the current Step explicitly authorises verification.
   A shortfall in this Step's own work goes in qualityAssessment.gaps and fails this Step. A precondition this Step does not own and cannot satisfy — product source another Step writes, a dependency another phase declares, a test whose scheduled execution belongs to the paired verification phase — goes in qualityAssessment.blockedBy, which is recorded as evidence and does not fail this Step. Never put one in the other's field, and never leave a true blocker out of both.
   Every paired test must import or execute the real product modules/public APIs declared by the Plan. Never duplicate product types, classes, algorithms, renderers, parsers, schedulers, or other business behavior inside a test to make it pass without product code.
   S001-S004 baseline authors may use mocks and Record/Replay for controlled external I/O. S005-S008 independently inspect that baseline, may add only focused risk supplements under the writable verification supplement root, freeze baseline plus supplements, and execute the full frozen set with Record/Replay for external data. No Step performs privileged live-network acceptance; declared real-user cases run only at the Phase delivery gate. Put every independent problem in qualityAssessment.findings: a baseline test-defect targets paired-source, a supplemental test-defect targets current-step, a product-defect targets the owning source, test-incomplete/quality-shortfall become Enhancements, and dependency findings name dependencyPackages for separate routing.
   Every DETAILED_DESIGN integration test must exercise at least two declared product source modules when the Plan declares two or more; an inline stand-in for either side is not integration evidence.
   UNIT_TEST reports lineCoverage, branchCoverage, and testCasePassRate; INTEGRATION_TEST reports interfaceCoverage, integrationScenarioCoverage, and testCasePassRate; MODULE_TEST reports moduleCoverage, contractCoverage, and testCasePassRate; FUNCTIONAL_TEST reports functionalCoverage, requirementCoverage, and endToEndPassRate.
   Ratios use 0..1. Never invent measurements: after a concrete probe fails to produce a required metric, put its exact identifier in unavailableMetrics and explain the cause in gaps so Runtime can create an Enhancement Ticket.
   A verification Step may correct a supplement it created before the frozen execution, but never the paired baseline or product code. After freeze, report each test-defect, product-defect, or completeness gap as a separate structured finding and set done=false.
5. Correct any error in the next round's actions; never overstep authority or invent tools.
6. [Large-file chunked writes] write_file / append_file content must stay under the current Step's runtime chunk limit shown in the tool docs.
   - For larger files: in the same actions array, first write_file the head (imports + top-level constants + first function/class),
     then several append_file calls each adding one function/class block (preserving trailing newlines).
   - For complex projects, prefer multiple cohesive modules/files and separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps over one giant file.
   - The concatenated result must be valid Python; never split inside a function body.
   - For partial edits to existing files, use replace_in_file / apply_patch — do not overwrite the whole file repeatedly.`;

const TYPESCRIPT_PLANNER_SYSTEM = `You are the Planner of the XCompiler system. Your job is to compile a user's natural-language requirement into a strict iterative V-model Step plan.

Output language: TypeScript / Node.js only (plan.language is fixed to "typescript").

Canonical V-model phases for every executable iteration:
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST.
DEBUG is runtime rollback/repair only. If a test phase fails, XCompiler rolls back to its paired source phase and reruns subsequent phases.

Use the same phase documents and synchronous test-design rule as the Python planner:
- REQUIREMENT_ANALYSIS: \`docs/01-requirement-analysis.md\` only during normal execution.
- HIGH_LEVEL_DESIGN: \`docs/02-high-level-design.md\` plus \`docs/tests/module-test-plan.md\`.
- DETAILED_DESIGN: \`docs/03-detailed-design.md\` plus \`docs/tests/integration-test-plan.md\`.
- CODE: implementation outputs plus \`docs/tests/unit-test-plan.md\` and executable unit tests.
- UNIT_TEST: \`docs/05-unit-test.md\`.
- INTEGRATION_TEST: \`docs/06-integration-test.md\`.
- MODULE_TEST: \`docs/07-module-test.md\`.
- FUNCTIONAL_TEST: \`docs/08-functional-test.md\`, \`README.md\`, \`docs/quickstart.md\`, and \`docs/api-guide.md\` for library/mixed projects.
For P2+ iterations, put phase docs under \`docs/iterations/<iterationId>/\` and test plans under \`docs/iterations/<iterationId>/tests/\`.

HIGH_LEVEL_DESIGN must place the current development module in the whole system and define system-level external interfaces and dependencies, including external APIs, third-party library choices, dependency confirmation, package.json scripts, package dependencies/devDependencies, tsconfig, data contracts, and integration boundaries.
DETAILED_DESIGN must define module-internal functions, types, data structures, algorithms, control flow, error handling, and internal architecture.

Mandatory rules:
1. Return pure JSON only. Never emit the old phases REQUIREMENT, ARCH, TASK, TEST, REFACTOR, or DELIVERY.
2. Every current/planned implementation phase is a complete V-model iteration containing all eight canonical phases.
3. Each macro Step may contain \`subTasks\` nested at most two levels.
4. Every CODE Step must be covered by a UNIT_TEST Step in the same iteration. HIGH_LEVEL_DESIGN must author architectureModules.testPaths; MODULE_TEST consumes them as inputs.
   CODE outputs contain product source/runtime assets, docs/tests/unit-test-plan.md, and executable unit tests under tests/.
5. REQUIREMENT_ANALYSIS/HIGH_LEVEL_DESIGN/DETAILED_DESIGN may output only their documents, paired executable tests, and allowed project configuration; they must not output src/ product code. Right-side test phases must not output tests/ or src/. HIGH_LEVEL_DESIGN is the only phase that may output \`package.json\` / \`tsconfig.json\`.
6. Exactly one HIGH_LEVEL_DESIGN Step must output \`package.json\` for greenfield TypeScript plans; ensure one HIGH_LEVEL_DESIGN Step output \`package.json\`. It must include scripts for \`build\`, \`test\`, and preferably \`lint\`.
7. Local TypeScript source imports must use explicit \`.ts\` ESM specifiers. Configure \`allowImportingTsExtensions: true\` and use \`tsc --noEmit\`. Generated TypeScript must be compatible with Node native type stripping: avoid enums, namespaces, parameter properties, and transform-required syntax.
8. Time-dependent tests must freeze the system clock (for example \`vi.setSystemTime\` or patched datetime) or derive expected values from the current clock. Never call \`new Date()\` / \`date.today()\` while hard-coding a calendar year.
9. dependencies is an advisory runtime npm package list; the authoritative manifest is \`package.json\` from HIGH_LEVEL_DESIGN. Do not invent package names.
10. Application/mixed projects need \`src/main.ts\` with a directly runnable \`main()\`; library/mixed projects need \`src/index.ts\` or equivalent public API plus API guide.
11. complexityAssessment and implementationPhases follow the same rules as Python: simple => P1, moderate => at least P1+P2, complex => at least P1+P2+P3, forced phase split => set userForcedPhaseSplit=true.
12. verificationGate failurePolicy must say: Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases.
13. For non-trivial work, return architectureModules with sourcePaths, optional assetPaths, and testPaths; HIGH_LEVEL_DESIGN/CODE/MODULE_TEST Steps may cover multiple modules but must list module-level work in subTasks.
14. TypeScript tests must use Vitest only. Never request Jest, ts-jest, @types/jest, ts-node, or nodemon in Step prompts or package.json; package.json must use "test": "vitest run" and "build": "tsc --noEmit".
15. Declare stage qualityGate thresholds and tolerance when project risk requires stricter values; otherwise Runtime applies the same S1-S8 engineering defaults as the Python planner.

Output JSON shape is identical to Python and must include \`"projectType": "application | library | mixed"\`, with TypeScript paths such as \`src/example.ts\` and \`tests/example.test.ts\`; the first Step phase must be \`REQUIREMENT_ANALYSIS\`, not \`REQUIREMENT\`. There is no CLI project-type override.`;

const TYPESCRIPT_EXECUTOR_SYSTEM = `You are XCompiler's Step Executor. You may only interact with the system through JSON tool calls — no Markdown and no explanatory text.

Every round you must return strict JSON:
{
  "thoughts": "<one sentence describing this round's intent>",
  "bugResolutionPlan": "<required only for a DEBUG Bug Ticket: concise root cause, repair target, and validation plan>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["artifact path, test report, or command result"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": [],
    "findings": []
  },
  "actions": [ { "tool": "<tool name>", "args": { ... } }, ... ],
  "done": true | false
}

Rules:
1. Only call tools in the Step's authorised whitelist.
2. File writes must land within the Step's writable allowlist (other paths are rejected); required outputs are the final artifacts that must exist for acceptance.
   For FUNCTIONAL_TEST documentation outputs, write the complete declared bundle in the active i18n language: P1 paths such as \`README.md\`, \`docs/quickstart.md\`, \`docs/08-functional-test.md\`, and \`docs/api-guide.md\` when present, or the declared iteration-scoped equivalents under \`docs/iterations/<iterationId>/\`. Do not set done=true while any declared documentation output is missing.
3. Generated code must follow TypeScript / Node.js best practice; modules importable, APIs typed, and runtime code directly runnable.
   - [Import convention] Local source modules under src/ use ESM relative imports with explicit ".ts" specifiers, e.g. \`import { x } from "./util.ts";\`. Keep code compatible with Node's native TypeScript type stripping: use erasable type syntax only, and avoid enums, namespaces, parameter properties, or other transform-required TS features. Never use Python-style imports, \`from src.<module>\`, or sys.path hacks.
   - [Test convention] Tests use Vitest: \`import { describe, it, expect } from "vitest";\`. Test files live under \`tests/**/*.test.ts\`.
   - [Self-contained tests] Tests **must NOT** read a sample file that does not exist on disk. When a target function needs file input, either create the content inside the test or write fixtures under \`tests/fixtures/<name>\`.
   - [Fixture iteration] When a test runs but the target function raises "Invalid syntax / Parse error / Malformed", the **fixture itself is malformed**. read_file the fixture, prefer a user/workspace sample; if none exists, use http_fetch to obtain an authoritative public reference; construct minimal samples only for simple text formats and immediately run_tests. Never weaken the implementation/assertion, and never repeatedly invent complex domain fixtures from memory.
   - [Time stability] Time-dependent tests must freeze the system clock (for example \`vi.setSystemTime\` or patched datetime) or derive expected values from the current clock. Never call \`new Date()\` / \`date.today()\` while hard-coding a calendar year.
4. When all outputs files exist and self-check passes, set done = true with empty actions and a qualityAssessment backed by concrete evidence.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE report completion and upstreamAlignment.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE author the baseline tests consumed by FUNCTIONAL_TEST / MODULE_TEST / INTEGRATION_TEST / UNIT_TEST. Authored baseline tests are not run until their paired verification Step unless the current Step explicitly authorises verification.
   A shortfall in this Step's own work goes in qualityAssessment.gaps and fails this Step. A precondition this Step does not own and cannot satisfy — product source another Step writes, a dependency another phase declares, a test whose scheduled execution belongs to the paired verification phase — goes in qualityAssessment.blockedBy, which is recorded as evidence and does not fail this Step. Never put one in the other's field, and never leave a true blocker out of both.
   Every paired test must import or execute the real product modules/public APIs declared by the Plan. Never duplicate product types, classes, algorithms, renderers, parsers, schedulers, or other business behavior inside a test to make it pass without product code.
   S001-S004 baseline authors may use mocks and Record/Replay for controlled external I/O. S005-S008 independently inspect that baseline, may add only focused risk supplements under the writable verification supplement root, freeze baseline plus supplements, and execute the full frozen set with Record/Replay for external data. No Step performs privileged live-network acceptance; declared real-user cases run only at the Phase delivery gate. Put every independent problem in qualityAssessment.findings: a baseline test-defect targets paired-source, a supplemental test-defect targets current-step, a product-defect targets the owning source, test-incomplete/quality-shortfall become Enhancements, and dependency findings name dependencyPackages for separate routing.
   Every DETAILED_DESIGN integration test must exercise at least two declared product source modules when the Plan declares two or more; an inline stand-in for either side is not integration evidence.
   UNIT_TEST reports lineCoverage, branchCoverage, and testCasePassRate; INTEGRATION_TEST reports interfaceCoverage, integrationScenarioCoverage, and testCasePassRate; MODULE_TEST reports moduleCoverage, contractCoverage, and testCasePassRate; FUNCTIONAL_TEST reports functionalCoverage, requirementCoverage, and endToEndPassRate.
   Ratios use 0..1. Never invent measurements: after a concrete probe fails to produce a required metric, put its exact identifier in unavailableMetrics and explain the cause in gaps so Runtime can create an Enhancement Ticket.
   A verification Step may correct a supplement it created before the frozen execution, but never the paired baseline or product code. After freeze, report each test-defect, product-defect, or completeness gap as a separate structured finding and set done=false.
5. Correct any error in the next round's actions; never overstep authority or invent tools.
6. [Large-file chunked writes] write_file / append_file content must stay under the current Step's runtime chunk limit shown in the tool docs.
   - For larger files: in the same actions array, first write_file the head (imports + top-level constants + first function/class), then several append_file calls each adding one function/class block.
   - For complex projects, prefer multiple cohesive modules/files and separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps over one giant file.
   - The concatenated result must be valid TypeScript; never split inside a function body.
   - For partial edits to existing files, use replace_in_file / apply_patch — do not overwrite the whole file repeatedly.
7. package.json is the dependency manifest. Use add_dependency for npm packages; never write requirements.txt.
8. run_program runs the project entry with \`npx tsx\`, run_tests runs Vitest via \`npm test\`, and the final delivery gate also verifies the direct Node entry command.`;

const PLANNER_CLARIFY_SYSTEM = `You are the requirements analyst for XCompiler's V-model. Do not restate the topic; expose unresolved decisions that would change functional design, acceptance, or architecture boundaries.
Return strict JSON only. Each question must be directly answerable by a product owner and cover one decision. Avoid vague catch-all or implementation-stack questions, except for the single development-language question when the user prompt explicitly requires it.`;

function buildPlannerSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_PLANNER_SYSTEM : PYTHON_PLANNER_SYSTEM) + profile.plannerPromptOverride;
}

function buildPlannerPhasePlanSystem(profile: LanguageProfile): string {
  return `You are the Planner of XCompiler. This is two-level planning, pass one: PhasePlan.

Target language: ${profile.displayName}.

Return only the project-level PhasePlan. Do not return steps, architectureModules, dependencies, or any individual V-model Step.

The PhasePlan must:
1. Classify projectType: application / library / mixed.
2. Assess complexityAssessment: simple / moderate / complex with rationale.
3. Produce implementationPhases: P1 status=current; later P2/P3 status=planned. simple uses P1 only; moderate uses at least P1+P2; complex uses at least P1+P2+P3; user-forced staging uses at least P1+P2 and userForcedPhaseSplit=true.
4. Give each phase objective, scope, deliverables, dependsOn, verificationGate, and deliveryGate. The deliveryGate declares validationTypes and baselineExecutionPolicy, owns live real-user scenarios, and must include concrete command/args; no V-model Step owns live-network acceptance.
5. Keep planned phases as goals and gates only. Do not expand any Step for them; a separate pass will generate a full V-model plan for one phase at a time.

Return strict JSON only:
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "projectType": "application | library | mixed",
  "complexityAssessment": { "level": "simple | moderate | complex", "rationale": "string", "splitRecommended": true, "userForcedPhaseSplit": false },
  "implementationPhases": [
    { "id": "P1", "title": "Core functionality", "objective": "string", "status": "current", "scope": ["..."], "deliverables": ["..."], "dependsOn": [], "verificationGate": { "summary": "string", "checks": ["..."], "failurePolicy": "Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases." }, "deliveryGate": { "kind": "phase-delivery", "summary": "string", "checks": ["complete deliverables", "run real-user scenarios"], "validationTypes": ["deliverable-validation", "baseline-test", "supplemental-functional-test"], "baselineExecutionPolicy": "phase-aggregate", "testAssetPolicy": "phase-aggregate", "externalDataPolicy": "live", "scenarios": [{ "name": "primary-user-flow", "description": "string", "operation": "string", "environment": "live", "expected": "string", "execution": { "command": "string", "args": ["..."] } }], "freezeBeforeExecution": true, "routeEachFinding": true } }
  ]
}

No Markdown, no explanatory prose, no steps, no source/test file inventory.` + profile.plannerPromptOverride;
}

function buildPlannerPhaseDecomposeSystem(profile: LanguageProfile): string {
  return `You are the Planner of XCompiler. This is two-level planning, pass two: generate a full V-model StepPlan for the requested phase.

Target language: ${profile.displayName}.

You will receive a frozen PhasePlan and a phaseId. Generate Steps only for that phaseId. Planned phases must not be expanded into this StepPlan.

The target phase's objective, scope, deliverables, and delivery gate are the authoritative
specification for this StepPlan. Every planned phase is explicitly out of scope: do not copy its
features, packages, artifacts, or acceptance criteria into the current phase. Rewrite
requirementDigest and globalPrompt for the target phase only, and exclude dependencies used solely
by a future planned phase.

Every current phase must use the canonical V-model:
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST.

Phase responsibilities:
- REQUIREMENT_ANALYSIS defines functional scope, acceptance, boundaries, and user-visible behaviour, and synchronously authors the functional baseline test plan and executable cases.
- HIGH_LEVEL_DESIGN defines system position, external interfaces, third-party choices, dependencies and integration boundaries, and synchronously authors the module test plan and executable module/contract tests.
- DETAILED_DESIGN defines module-internal functions/classes, data structures, algorithms, control flow, error handling and architecture, and synchronously authors the integration test plan and executable integration tests.
- CODE implements the current phase and synchronously authors the unit test plan and executable unit tests.
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST uniformly inspect the baseline, may add risk-driven tests only under their verification-owned supplement root, freeze and run the combined set with deterministic external data, then write reports. Real-user live-network cases run only at the Phase delivery gate. None rewrites baseline tests or product code.

Strict output ownership:
- REQUIREMENT_ANALYSIS owns functional baseline tests; HIGH_LEVEL_DESIGN owns module baseline tests and architectureModules.testPaths; DETAILED_DESIGN owns integration baseline tests; CODE owns unit baseline tests plus product source/runtime assets.
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST consume paired baselines and own only validation reports/delivery docs. Runtime assigns the exact risk-supplement root when the Step executes; no Step inputs/outputs in Planner JSON may predeclare supplement, supplemental, or tests/verification paths.
- For greenfield TypeScript, exactly one HIGH_LEVEL_DESIGN Step must output package.json with scripts, dependencies, and devDependencies. CODE must not output package.json.
- For TypeScript package.json, use Vitest only: "test": "vitest run", "build": "tsc --noEmit", and include typescript/tsx/vitest/@vitest/coverage-v8/@types/node in devDependencies with compatible Vitest/provider versions. Scope tsconfig product build/typecheck to src/**/*.ts and src/**/*.tsx; each V-model test Step runs only its paired tests through Vitest. Do not mention or request Jest, ts-jest, @types/jest, ts-node, or nodemon.

Return only the current phase's dependencies, architectureModules, and steps. Complex or multi-concern work must declare architectureModules for the current phase and map module-level work under HIGH_LEVEL_DESIGN/CODE/MODULE_TEST subTasks. Each Step's subTasks may nest at most two levels.

architectureModules may describe only product/business source modules for the current phase:
- sourcePaths must be target-language source files under src/. They must not be directories, tests/, docs/, README, fixtures, utils, or report files.
- assetPaths is optional and may contain only non-code files under src/ that ship with and are used by the product at runtime (for example templates, schemas, or static assets). Do not put test fixtures, sample inputs, temporary outputs, or documentation there.
- testPaths must be target-language test files under tests/. They must not be directories.
- Test fixtures, test helpers, sample inputs, and temporary output files belong to the paired left-side source Step outputs/subTasks, not in architectureModules.

Return strict JSON only:
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "dependencies": ["pytest"],
  "architectureModules": [
    { "id": "M001", "name": "module name", "responsibility": "one clear responsibility", "sourcePaths": ["src/example.py"], "assetPaths": ["src/templates/example.txt"], "testPaths": ["tests/test_example.py"], "dependencies": [] }
  ],
  "steps": [
    { "id": "S001", "iterationId": "P1", "phase": "REQUIREMENT_ANALYSIS", "title": "string", "description": "string", "systemPrompt": "scope, inputs, outputs, acceptance, forbidden actions", "role": "Planner", "tools": ["write_file"], "inputs": ["docs/topic.md"], "outputs": ["docs/01-requirement-analysis.md", "docs/tests/functional-test-plan.md", "tests/test_functional_acceptance.py"], "subTasks": [], "dependsOn": [], "acceptance": "string", "maxAttempts": 3 }
  ]
}

Do not output Steps for future planned phases. Do not output requirements.txt. Design phases must not write src/ product code; their paired tests are mandatory. FUNCTIONAL_TEST must include README.md, docs/quickstart.md, and the functional validation document.` + profile.plannerPromptOverride;
}

function buildExecutorSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_EXECUTOR_SYSTEM : PYTHON_EXECUTOR_SYSTEM) + profile.executorPromptOverride;
}
const messages: Messages = {
  llm: {
    coderDebuggerSameModel: (model, coderProvider, debuggerProvider) =>
      `Model configuration advice: Coder (${coderProvider}) and Debugger (${debuggerProvider}) both use ${model}. Prefer different models so debugging provides an independent reasoning path.`,
    invalidBaseUrl: (raw, fallback) => `[xcompiler] invalid base_url (${raw}); configure a valid HTTP(S) URL (default: ${fallback})`,
    providerValidationFailed: (role, model) => `[${role}] provider ${model} failed output contract validation`,
    providerValidationRetry: (role, model) => `[${role}] retrying provider ${model} with contract feedback before fallback`,
    providerValidationRepairPrompt: (error, rejectedOutput) =>
      `Your previous candidate failed the caller contract before any action was parsed, authorized, executed, or persisted: ${error.slice(0, 1800)}\n` +
      (error.includes('Executor response: incomplete or invalid JSON turn')
        ? 'This is Executor JSON: the top level must contain both an actions array and a boolean done field, even when reporting only an assessment or finding. To handle an assigned Ticket, actions must submit the actual handling operation instead of repeating the problem statement.\n'
        : '') +
      'Nothing claimed by that candidate changed the workspace. Treat only explicit tool results in the original conversation as executed state. ' +
      'Return a complete corrected response using the original system and user requirements. If the rejected candidate intended a mutation, submit that mutation again; do not jump to verification until a caller tool result confirms it succeeded. ' +
      'Return only the requested format without explanation or Markdown.\n\n' +
      `<rejected-output never-executed="true">\n${rejectedOutput}\n</rejected-output>`,
    providerCallFailed: (role, model) => `[${role}] provider ${model} failed; trying next`,
    scoreReadFailed: (p, message) => `failed to read ${p}: ${message}`,
    scoreChanged: (provider, score, previous) => `score(${provider}) = ${score} (was ${previous})`,
    scorePersistFailed: (message) => `failed to persist scores: ${message}`,
    preflightOllamaReachable: (baseUrl, models) => `preflight: ollama ${baseUrl} reachable; found ${models} model(s)`,
    preflightOllamaUnreachable: (baseUrl, message) => `preflight: ollama ${baseUrl} unreachable: ${message}`,
    preflightAutoAdded: (providers, roles) => `preflight: auto-added ${providers} provider(s) for roles [${roles}]`,
    scoreFileHeader: '# XCompiler LLM provider score snapshot (maintained automatically by ScoreStore; do not edit)',
    scoreFileSemantics: '# Scores: dynamic snapshot; default 1.0; automatic range 0.1-1.0; providers tagged cluster default to 0.2-0.5 unless llm.cluster_score_min/max widens it; transport/attributed quality failure -0.5; verified finding/repair/change +0.1. Put user overrides in llm_scores_user.yaml; 0 disables a provider.',
  },
  system: {
    configEnvMissing: (names) => `[xcompiler] unset config environment variables were replaced with empty strings: ${names}`,
    unhandledError: (message) => `Unhandled error: ${message}`,
    unsupportedSubprocessNetworkOff:
      'sandbox network=off cannot be enforced in subprocess mode; use mode=docker or choose download-only/full explicitly.',
    dockerInsideContainerUnsupported:
      'XCompiler is running inside a container, so sandbox mode docker is unsupported because Docker-outside-of-Docker can mis-map bind mounts and docker.sock permissions. Use agent.sandboxes.<language>.mode=subprocess, run XCompiler on the host, or set XC_IN_CONTAINER=0 only in a controlled environment.',
    smokeHeader: (baseUrl) => `Smoke test against ${baseUrl} (streaming)`,
    smokeOk: (model, totalMs, firstTokenMs, chunks, preview) =>
      `[OK total=${totalMs}ms first-token=${firstTokenMs}ms chunks=${chunks}] ${model} -> ${preview}`,
    smokeFail: (model, message) => `[FAIL] ${model} -> ${message}`,
  },
  plugins: {
    invalidId: (id) => `Plugin ID "${id}" is invalid; use lowercase letters, digits, dots, hyphens, or underscores.`,
    duplicateId: (id) => `Duplicate plugin ID: ${id}`,
    invalidVersion: (plugin, version) => `Plugin ${plugin} has an invalid SemVer version: ${version}`,
    invalidCoreVersion: (version) => `XCompiler core has an invalid SemVer version: ${version}`,
    apiVersionMismatch: (plugin, actual, expected) => `Plugin ${plugin} targets Plugin API ${actual}; this XCompiler runtime requires API ${expected}.`,
    invalidMinimumVersion: (plugin, version) => `Plugin ${plugin} has an invalid minimum XCompiler version: ${version}`,
    coreVersionTooOld: (plugin, minimum, actual) => `Plugin ${plugin} requires XCompiler >= ${minimum}; current version is ${actual}.`,
    loaded: (plugin, version) => `Plugin ${plugin}@${version} loaded.`,
    extensionConflict: (plugin, kind, name) => `Plugin ${plugin} cannot replace existing ${kind} "${name}".`,
    hookFailed: (plugin, stage, message) => `Plugin ${plugin} failed during ${stage}: ${message}`,
    manifestReadFailed: (path, message) => `Cannot read plugin manifest ${path}: ${message}`,
    moduleLoadFailed: (plugin, path, message) => `Cannot load plugin ${plugin} from ${path}: ${message}`,
    exportInvalid: (plugin, exportName) => `Plugin ${plugin} export ${exportName} is not a valid XCompiler plugin`,
    manifestMismatch: (plugin) => `Plugin ${plugin} runtime manifest does not match its preflight manifest`,
  },
  audit: {
    processLogTitle: '# XCompiler Development Process Log',
    processLogPreamble: '> Generated by XCompiler. Records CLI sessions, user input, LLM interactions, and execution actions for delivery traceability.',
    sessionStart: (ts, command) => `## ▶ Session ${ts} — \`${command}\``,
    sessionEnd: (ts) => `### ◀ Session end ${ts}`,
    eventSessionStart: (command) => `start ${command}`,
    eventSessionEnd: (command) => `end ${command}`,
    userInput: (label) => `#### 👤 User input — ${label}`,
    llmRequest: (role, model) => `🤖 LLM Request — <code>${role}</code> via <code>${model}</code>`,
    llmResponse: (role, model) => `📩 LLM Response — <code>${role}</code> via <code>${model}</code>`,
    executorTurn: (stepId, round, role, provider, actions, done) =>
      `🧠 Executor turn — <code>${stepId}</code> round ${round} / role <code>${role}</code>${provider ? ` · via <code>${provider}</code>` : ''} (actions=${actions}, done=${done})`,
    thoughtsLabel: '**thoughts:**',
    actionsLabel: '**actions:**',
    noThoughts: '(no thoughts)',
    plannerThought: (stage, provider) => `🧩 Planner thought — ${stage}${provider ? ` · via <code>${provider}</code>` : ''}`,
    markdownAppendFailed: (message) => `[audit] markdown append failed: ${message}`,
    jsonlAppendFailed: (message) => `[audit] jsonl append failed: ${message}`,
    traceLine: (kind, message) => `[audit] ${kind} ${message}`,
    autoFixedSrcImport: (p) => `auto-fixed src import in ${p}`,
    wroteFile: (p) => `wrote ${p}`,
    userDecision: (label, value) => `${label} → ${value}`,
    eventLlmRequest: (role, model) => `${role} → ${model}`,
    eventLlmResponse: (role, model) => `${role} ← ${model}`,
    eventLlmError: (role, model, message) => `${role} via ${model}: ${message}`,
    eventExecutorTurn: (stepId, round, role, provider) => `${stepId} round=${round} role=${role}${provider ? ` via ${provider}` : ''}`,
    eventPlannerThought: (stage, provider) => `Planner ${stage}${provider ? ` via ${provider}` : ''}`,
    llmChatFailedThought: (message) => `LLM chat failed: ${message}`,
    llmChatAborted: (stepId, round, chars, message) => `${stepId} round ${round} aborted after ${chars} chars: ${message}`,
    toolDenied: (tool) => `denied tool ${tool}`,
    toolCalled: (tool) => `called tool ${tool}`,
    toolResult: (tool, ok, detail) => `tool ${tool} ${ok ? 'succeeded' : 'failed'}: ${detail}`,
    documentArchived: (from, to) => `archived ${from} → ${to}`,
    documentArchiveFailed: (p, message) => `failed to archive ${p}: ${message}`,
    httpFetchSaved: (method, url, p, bytes) => `http_fetch ${method} ${url} → ${p} (${bytes} B)`,
    httpFetchResponse: (method, url, status, bytes) => `http_fetch ${method} ${url} → ${status} (${bytes} B)`,
    partialFailureHeader: (message) => `# LLM chat failed: ${message}`,
    streamLength: (chars) => `# Stream length: ${chars} chars`,
  },
  stream: {
    resolvingModel: 'resolving-model',
    waiting: 'waiting',
    streaming: 'streaming',
    done: 'done',
    failed: 'failed',
    chars: (n) => `${n} chars`,
    toolRunner: 'local-tool',
    toolExecution: (stepId, tool) => `${stepId} tool ${tool}`,
  },
  sandboxLog: {
    subprocessBuilt: (deps) => `subprocess sandbox built (${deps ? 'with dependencies' : 'empty'})`,
    subprocessNodeBuilt: 'Node subprocess sandbox built (npm install)',
    dockerBuilt: (deps) => `Docker sandbox built (${deps ? 'with dependencies' : 'empty'})`,
    dockerNodeBuilt: 'Docker Node sandbox built (npm install)',
    command: (runtime, command) => `${runtime} ${command}`,
  },
  cli: {
    rootDescription: 'XCompiler — AI Software Factory CLI',
    compileDescription: 'Interactively compile a requirement into phasePlan.json and the current phase plan (with mandatory human gates)',
    runDescription: 'Execute the current canonical Phase from a confirmed phasePlan.json',
    loadDescription: 'Load a XXX.xc project file and continue its current plan',
    appendDescription: 'Append a new requirement to an existing XXX.xc project through clarification and V-model execution',
    lsDescription: 'Scan workspace and list every phasePlan.json status summary',
    showDescription: 'Print Step definition / status / outputs / recent audit',
    optWorkspace: 'workspace directory (alias of --output, defaults to current directory)',
    optOutput: 'project / workspace output directory (highest priority, alias of -w)',
    optConfig: 'path to config.yaml',
    optInput: 'read requirement from a file (non-interactive)',
    optTopic: 'reuse an already-clarified topic.md as input: skip intake / clarify / addenda / Gate 1 and go straight to decompose',
    optPlanOut: 'output path for phasePlan.json (default <workspace>/phasePlan.json)',
    optBaseDir: 'project root output directory (creates <name> subdir under it)',
    optName: 'project name (default xcompiler-<timestamp>)',
    optYes: 'skip human confirmation (only meaningful with -i / -t)',
    optForce: 'force regenerate: override workspace lock and ignore existing plan files',
    optDryRun: 'print topology only, do not execute',
    optMaxDepth: 'maximum recursion depth',
    optTail: 'number of recent audit entries',
    optPlan: 'phasePlan.json path, default <workspace>/phasePlan.json',
    optLang: 'UI / prompt language: EN | CN (ISO 3166-1 Alpha-2)',
    optIntent: 'plan intent: greenfield | feature | refactor | self',
    optBaselinePlan: 'existing baseline phasePlan.json path (default <workspace>/phasePlan.json)',
    optProjectFile: 'XXX.xc project file path (default <workspace>/<name>.xc)',
    optDebugWikiPath: 'debug wiki root directory path (default <XCompiler path>/.xcompiler/debug-wiki)',
    optRecordReplay: 'external interaction mode: off, record, replay, auto, or refresh',
    optRecordReplayPath: 'workspace-relative record/replay fixture directory',
    argPlan: 'phasePlan.json path (default = <workspace>/phasePlan.json)',
    argProjectFile: 'XXX.xc project file',
    argStepId: 'Step ID, e.g. S001',
    evolveDescription: 'Generate and execute an incremental feature/refactor plan on top of an existing workspace',
    bootstrapDescription: 'Build and qualify the next XCompiler generation in an isolated Git worktree',
    optRepository: 'XCompiler Git repository to bootstrap (default current directory)',
    optPromote: 'fast-forward the current branch after every qualification gate passes',
    optCleanup: 'remove the isolated worktree after writing the report (branch is retained)',
    optDockerQualification: 'use the experimental Docker runner for candidate qualification',
    invalidLocale: (value) => `Unsupported language "${value}"; use EN or CN.`,
    invalidIntent: (value, allowed) => `Invalid intent "${value}"; expected one of: ${allowed}.`,
    invalidPhase: (value, allowed) => `Invalid phase "${value}"; expected one of: ${allowed}.`,
    invalidStepId: (value) => `Invalid Step ID "${value}"; expected S followed by at least three digits.`,
    invalidNonNegativeInteger: (value) => `Expected a non-negative integer, received "${value}".`,
    invalidRecordReplayMode: (value, allowed) => `Invalid record/replay mode "${value}"; expected one of: ${allowed}.`,
    helpUsage: 'Usage:',
    helpArguments: 'Arguments:',
    helpOptions: 'Options:',
    helpCommands: 'Commands:',
    helpOption: 'display help for command',
    versionOption: 'output the version number',
    defaultValue: (value) => `(default: ${value})`,
  },
  bootstrap: {
    notGitRepository: (p) => `Not a Git repository: ${p}`,
    dirtyRepository: (files) => `Self-bootstrap requires a clean host repository. Pending paths: ${files}`,
    worktreeReady: (p, branch) => `Bootstrap worktree ready: ${p} (${branch})`,
    compileStarted: 'Compiling the self-bootstrap V-model plan…',
    compileFailed: (code, message) => `Self-bootstrap compilation failed (exit=${code}): ${message}`,
    compileCancelled: 'Self-bootstrap compilation was cancelled before a plan was confirmed.',
    executeStarted: 'Executing the candidate generation in the isolated worktree…',
    executeFailed: (status) => `Candidate execution did not complete successfully (${status}).`,
    qualificationStarted: 'Running deterministic bootstrap qualification gates…',
    qualificationDockerExperimental: 'Docker qualification is experimental and has not completed environment validation.',
    missingScript: (name) => `required package.json script is missing: ${name}`,
    missingBin: 'package.json does not declare a CLI bin entry',
    checkPassed: (name, ms) => `${name} passed (${ms}ms)`,
    checkFailed: (name, code) => `${name} failed (exit=${code})`,
    reportWritten: (p) => `Bootstrap report written: ${p}`,
    candidateReady: (branch) => `Candidate is qualified on ${branch}; promotion still requires explicit --promote.`,
    promoted: (branch) => `Bootstrap candidate promoted by fast-forward merge: ${branch}`,
    cleanupDone: (p) => `Bootstrap worktree removed: ${p}`,
    promotionBlocked: 'Promotion blocked because one or more qualification gates failed.',
    hostHeadChanged: 'host HEAD changed during bootstrap',
    candidateDirty: (files) => `Candidate worktree changed outside a committed generation: ${files}`,
    candidateStatusUnknown: '(unknown path)',
    candidateMoved: (expected, actual) => `Candidate commit changed after qualification (expected ${expected}, got ${actual}).`,
    candidateNotBasedOnBase: (candidate, base) => `Candidate ${candidate} is not descended from bootstrap base ${base}.`,
    promotionVerificationFailed: (expected, actual) => `Promotion verification failed (expected HEAD ${expected}, got ${actual}).`,
    reportTitle: 'XCompiler Self-Bootstrap Report',
    reportNone: '(none)',
    reportNextQualified: (repository, candidateCommit) => `git -C "${repository}" merge --ff-only "${candidateCommit}"`,
    reportNextPromoted: 'Run the next self-bootstrap request with the promoted generation.',
    reportNextFailed: 'Inspect the candidate worktree and fix the failed gate before promotion.',
    reportLabels: {
      status: 'Status', repository: 'Repository', baseCommit: 'Base commit',
      candidateCommit: 'Candidate commit', branch: 'Candidate branch', worktree: 'Worktree',
      createdAt: 'Created at', checks: 'Qualification checks', changedFiles: 'Changed files',
      nextStep: 'Next step',
    },
  },
  compile: {
    workspaceReady: (p) => `Workspace: ${p}`,
    forceOverride: '--force: overriding workspace lock and regenerating plan.',
    topicInputConflict: '--topic and --input were both supplied; --topic wins and --input is ignored.',
    auditTopicInput: 'topic.md (--topic)',
    auditOriginalRequirement: 'Original requirement (Intake)',
    auditUserAddenda: 'User addenda',
    auditEditedTopic: 'Edited topic.md',
    auditTopicPersisted: (p) => `topic.md written: ${p}`,
    auditDecomposeFailed: 'planner.decompose failed',
    lintIssue: (id, message) => ` - [${id}] ${message}`,
    planPreviewTruncated: '… (truncated; see docs/plan.md)',
    auditPlanPersisted: (p) => `phase plan written: ${p}`,
    projectFileWritten: (p) => `project file updated: ${p}`,
    nextCommand: (command) => `  Next: ${command}`,
    topicEmptyExit: '--topic file is empty, aborting.',
    topicLoaded: (p) => `topic loaded: ${p} (skipping intake / clarify / Gate 1)`,
    requirementEmptyExit: 'requirement is empty, aborting.',
    requirementInputHint: 'Please describe your requirement (multi-line, blank line to finish):',
    spinClarify: 'Planner is clarifying the requirement…',
    clarifySucceed: (n) => `clarification questions: ${n}`,
    clarifyFail: 'clarification failed',
    clarifyChoiceHint: (range) => `Reply with ${range} to choose a shown option, or type a custom answer.`,
    addendaConfirm: 'Any extra requirements to append? (Will be sent to Planner together with the clarification and kept in plan.userAddenda)',
    addendaEditorMsg: 'Enter custom addenda (multi-line, Markdown allowed)',
    auditClarifyAnswer: (qid, q) => `clarify answer ${qid}: ${q}`,
    spinDecompose: 'Planner is decomposing along the V-model…',
    decomposeFail: 'Planner decomposition failed',
    plannerInvalidPlan: 'Planner could not produce a valid plan:',
    plannerInvalidPlanHint1: '  Common cause: the LLM output did not satisfy the XCompiler plan schema, V-model skeleton, or architecture contract; this error must not be skipped.',
    plannerInvalidPlanHint2: '  Investigate: check llm.error / planner.thought entries in .xcompiler/audit.jsonl and repair the Planner output against the contract.',
    plannerTransportFailureHint1: '  Common cause: the LLM provider connection failed, timed out, or the server closed the request; this is not a project plan/source defect.',
    plannerTransportFailureHint2: '  Investigate: check OPENAI_BASE_URL / provider base_url, model service reachability, network permissions, and timeout settings, then rerun build.',
    decomposeSucceed: (n) => `generated ${n} Step(s)`,
    schemaFail: 'Plan schema validation failed:',
    schemaInvalidSavedAt: (p) => `  full plan saved to: ${p}`,
    lintFail: (n) => `Plan lint failed (${n}):`,
    topicPreviewHeader: '─── topic.md (preview) ───',
    topicPreviewFooter: '──────────────────────────────',
    gate1Confirm: 'Does the requirement match expectations?',
    gate1ChoiceConfirm: '✅ confirm — proceed to plan generation',
    gate1ChoiceEdit: '✏️  edit    — open editor to modify',
    gate1ChoiceCancel: '❌ cancel  — abandon this session',
    gate1AuditLabel: 'Requirement Confirmation Gate (Gate 1)',
    gate1Cancelled: 'Cancelled, no files written.',
    editTopicMsg: 'Edit topic.md',
    topicWritten: (p) => `topic written: ${p}`,
    planWritten: (p) => `phase plan written: ${p}`,
    phasePlanWritten: (p) => `phasePlan written: ${p}`,
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: 'Confirm this plan? (Final confirmation — writes phasePlan.json and the current phase plan)',
    gate2AuditLabel: 'Plan Confirmation Gate (Gate 2)',
    gate2Rejected: 'Not confirmed, abandoned. phasePlan.json was not written.',
    baselineLoaded: (kind, sources) => `loaded ${kind} baseline from: ${sources}`,
    baselineMissing: (workspace) => `incremental mode requires an existing project baseline in ${workspace} (topic / docs / plan / src).`,
    baselineLanguageOverride: (baseline, source, configured) =>
      `incremental mode: using baseline language ${baseline} from ${source} instead of config language ${configured}.`,
    topicTitle: '# Project Topic',
    topicPreamble: '> This file is the project topic frozen after requirement clarification. All subsequent V-model decomposition and every phase output use this file as the sole requirement input.',
    topicSecRequirement: '## Original requirement',
    topicSecClarify: '## Clarification record',
    topicSecAddenda: '## User addenda',
    topicSecBaseline: '## Existing project baseline',
  },
  inspect: {
    noPlanFound: 'No phasePlan.json found',
    digestLabel: 'digest:',
    stepNotFound: (id) => `Step ${id} not found`,
    secDescription: '— description —',
    secAcceptance: '— acceptance —',
    secSubtasks: '— subtasks —',
    secSystemPrompt: '— systemPrompt —',
    secOutputs: '— outputs —',
    secRecentAudit: (n) => `— recent audit (${n}) —`,
    planHeader: (p, language) => `${p} lang=${language}`,
    planStatusSummary: (total, done, ready, blocked, running) =>
      `steps=${total} done=${done} ready=${ready} blocked=${blocked} running=${running}`,
    planReadFailed: (p, message) => `${p} — ${message}`,
    stepHeader: (id, phase, title, state, attempts, maxAttempts) => `${id} ${phase} ${title} ${state} attempts=${attempts}/${maxAttempts}`,
    stepRoleTools: (role, tools) => `role=${role} tools=[${tools}]`,
    stepDependsOn: (ids) => `dependsOn: ${ids}`,
    outputStatus: (exists, p) => `${exists ? '✓' : '✗'} ${p}`,
    auditEntry: (ts, kind, message) => `${ts} ${kind} ${message}`,
  },
  execute: {
    forceLockOverride: '--force: overriding the workspace process lock; domain lifecycle state is unchanged.',
    manifestRecalibrated: (p) => `recalibrated ${p} (removed version pins / hallucinated names)`,
    manifestSeeded: (p) => `seeded ${p} from plan.dependencies`,
    auditPlanLoaded: (p) => `plan loaded: ${p}`,
    planLoaded: (p) => `Plan loaded: ${p}`,
    planSummary: (language, steps) => `  language=${language}, steps=${steps}`,
    preflightModelMissing: (names) => `LLM preflight: missing models, skipped for this run and lowered to the minimum dynamic score [${names}]`,
    preflightAutoAdded: (n) => `LLM preflight: auto-injected ${n} provider(s) (from ollama /api/tags)`,
    runInterrupted: (id, e, total) => `execution interrupted at ${id} (executed ${e}/${total})`,
    runReasonLabel: '  reason: ',
    runFailureLogHeader: '  --- failure log (tail, 40 lines) ---',
    runAllDone: (e, total) => `Plan fully completed (${e}/${total})`,
    projectAuditSummary: (errors, warnings) => `project audit: ${errors} error(s), ${warnings} warning(s)`,
    projectMemoryRefreshFailed: (message) => `project memory refresh failed: ${message}`,
    projectAuditCheck: (name, summary) => `[audit:${name}] ${summary}`,
    auditDocPresent: (p) => `${p} present`,
    auditDocMissing: (p) => `missing ${p}`,
    auditDeliveryDocPresent: 'delivery documentation present',
    auditDeliveryDocMissing: 'missing docs/08-functional-test.md',
    auditTestFilesFound: (count) => `found ${count} concrete test file(s)`,
    auditTestFilesMissing: 'no concrete test files found under tests/',
    auditEntrypointOk: (command) => `entrypoint ok: ${command}`,
    auditEntrypointFailed: (command) => `entrypoint failed: ${command}`,
    auditPackageJsonMissing: 'missing package.json',
    auditScriptMissing: (name) => `package.json has no ${name} script`,
    auditCommandOk: (name) => `${name} ok`,
    auditCommandFailed: (name, exitCode, timedOut) =>
      `${name} failed (exit=${exitCode}${timedOut ? ', timeout' : ''})`,
  },
  engine: {
    cachedTestGateStart: (id, testArgs) =>
      `  [Engine Gate] ${id} run_tests${testArgs.length > 0 ? `: ${testArgs.join(', ')}` : ': full test suite'}`,
    cachedTestGatePassed: (id) => `  [Engine Gate] ${id} current test gate passed`,
    cachedTestGateFailed: (id, exitCode, timedOut) =>
      `  [Engine Gate] ${id} current test gate failed (exit=${exitCode}${timedOut ? ', timeout' : ''})`,
    cachedTestArtifactsIncomplete: (id, missing) =>
      `  [Engine Gate] ${id} has incomplete phase artifacts; repairing this test phase: ${missing.join(', ')}`,
    missingPythonEntrypoint:
      'missing Python entrypoint: expected src/main.py, src/<package>/__main__.py, or an explicit CLI file such as src/cli.py',
    missingTypeScriptEntrypoint:
      'missing TypeScript entrypoint: expected package.json start/bin or one of src/main.ts, src/index.ts, src/main.tsx',
    invalidPythonEntrypointSource: (path) =>
      `invalid Python entrypoint source in ${path}: expected a real CLI entry structure such as def main(...), argparse.ArgumentParser, or if __name__ == "__main__"; placeholder/import-only files are not runnable applications.`,
    entrypointHelpOutputMissing: (command) =>
      `entrypoint probe \`${command}\` exited 0 but produced no meaningful help/usage text; implement --help instead of relying on an empty script exit.`,
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (injected into every Step\'s system prompt)',
    sectionDependencies: (manifestFile) => `## Dependencies (written to ${manifestFile})`,
    sectionBaselineSummary: '## Existing project baseline',
    labelSystemPrompt: '**System prompt (sole mandate):**',
  },
  prompts: {
    plannerSystem: (p) => buildPlannerSystem(p),
    plannerPhasePlanSystem: (p) => buildPlannerPhasePlanSystem(p),
    plannerPhaseDecomposeSystem: (p) => buildPlannerPhaseDecomposeSystem(p),
    plannerSelfMode: `SELF-BOOTSTRAP OVERRIDE (takes precedence over conflicting greenfield rules above):
- The target is the existing XCompiler repository. Preserve its current package.json, tsconfig, bin entries, CLI entrypoints, module layout, public exports, and documentation unless the requirement explicitly changes them.
- Do not create src/main.ts merely to satisfy a greenfield entrypoint convention. Reuse the entrypoints declared by the existing package.json.
- Do not list package.json or tsconfig.json as HIGH_LEVEL_DESIGN outputs unless this change genuinely needs to modify them.
- Every CODE/test output must be scoped to the requested delta. Never rebuild or replace the repository wholesale.
- Treat the stable host binary as generation N and the worktree candidate as N+1; do not design in-process hot replacement.`,
    plannerClarifySystem: PLANNER_CLARIFY_SYSTEM,
    plannerClarify: (raw, opts = {}) =>
      `The user's original requirement is:

"""
${raw}
"""

Generate ${opts.complex ? '8-10' : '7-10'} non-duplicate clarification questions about unresolved decisions whose answers materially affect implementation or acceptance. Never return an empty array; when the functional description is already detailed, ask for acceptance examples, failure behaviour, and explicit exclusions.

Return ONLY a JSON array. Every item must be shaped exactly as:
{"id":"Q1","category":"functionality|data|acceptance|boundary|quality|extensibility","question":"one concrete directly-answerable question","why":"what design or acceptance decision this answer affects","options":[{"label":"A","answer":"highest-priority feasible setting"},{"label":"B","answer":"second feasible setting"}]}

Question mix (functionality first):
- At least ${opts.complex ? '5' : '4'} function-focused questions categorized as functionality / data / acceptance, so functional questions remain the majority. Prioritize actors, core journeys, business rules and state transitions, inputs/outputs, failure behaviour, and verifiable acceptance examples.
- At least one boundary question defining in-scope, explicitly out-of-scope, external-system ownership, or compatibility limits.
- At least one quality question requesting measurable latency, throughput, volume, concurrency, accuracy, reliability, or security targets. Never ask only “Any performance requirements?”.
- At least one extensibility question identifying the most likely future business capability, extension axis, or interface that must remain stable. Never ask only “Should it be extensible?”.
- If the deliverable shape is unclear, include one boundary question asking whether this should be an API library/SDK/package, a runnable application/CLI/service, or a mixed deliverable with both.
- If the requirement needs access to external APIs, URLs, or third-party data sources, include one data or boundary question asking whether the user already has a usable API, key, token, or auth method. If they do not, the default for this delivery is to choose a public, no-key/no-token, verifiable API; do not generate placeholder URLs.
- Order by blocking impact: core functional/data decisions first, then scope and quality, then future evolution.
- One primary decision per question. Include useful business choices/examples; do not join unrelated questions with “and/or”.
- For every question, generate 2-5 feasible answer options ordered by priority. The option count is not fixed: use 2 for binary choices, 3 for common defaults, and 4-5 only when there are genuinely distinct viable settings. Do not pad or force every question to exactly 3 options.
- Label options sequentially from A through the last generated option, for example A-B, A-C, A-D, or A-E. A should be the recommended/default setting when one is apparent. Options must be concrete business/product settings, not vague placeholders.
- Do not include “Other”, “Custom”, or “Let the user decide” as an option. The CLI already allows the user to reply with one of the shown labels or enter a custom free-form answer.
${opts.projectShapeAmbiguous
  ? '- Required for this topic: ask the API library vs runnable application vs mixed-deliverable boundary explicitly.\n'
  : ''}
${opts.languageAmbiguous
  ? '- Required for this topic: include exactly one boundary question confirming the target development language. Options must be A. Python (default/recommended) and B. TypeScript / Node.js. The user may still answer with custom free-form text.\n'
  : ''}

${opts.languageAmbiguous
  ? `[Stack decision] XCompiler could not infer the target language from the topic or baseline. Ask only the development-language question described above; do not ask package manager, test framework, or OS questions. If the user does not choose, Python is the default.`
  : `[Hard constraint] The implementation stack is already fixed by the user's topic or existing project baseline. Do not reopen language/runtime/package-manager decisions.
**Do NOT** ask questions of these forms:
  - "Which programming language / framework / runtime should this use?"
  - "Which test framework / build tool / package manager?"
  - "Which OS is the target platform?"`}
${opts.intent && opts.intent !== 'greenfield'
  ? `This is an incremental ${opts.intent} request against an existing project${opts.hasBaseline ? ' with a separate baseline summary that will be provided during decomposition' : ''}. Ask ONLY delta questions; do not ask to rebuild the project from scratch.`
  : ''}The majority of questions must concern functional behaviour; performance, boundaries, and extensibility should eliminate ambiguities that affect this delivery.`,
    plannerDecompose: (raw, qa, addenda, opts = {}) =>
      `Original requirement:
"""
${raw}
"""

Clarification Q&A:
${qa || '(none)'}

${addenda ? `User addenda (must be strictly followed; takes priority over any vague parts of the original):\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `Incremental intent: ${opts.intent}

Generate an incremental ${opts.intent} plan on top of the existing project. Reuse the current architecture, files, tests and dependencies where possible instead of rebootstrapping the whole project. Outside the requested change, preserve existing behaviour.

Existing project baseline:
"""
${opts.baseline || '(missing baseline)'}
"""

`
  : ''}Planning depth rules:
- Unless the request is explicitly tiny (single function / toy script / one-file utility), do not collapse the solution into one source file and one test.
- If the requirement spans multiple concerns (domain logic, API/CLI surface, persistence, integration, orchestration, tests), reflect that with multiple architecture modules and Step.subTasks under HIGH_LEVEL_DESIGN/CODE/MODULE_TEST macro Steps.
- Assess project complexity in the plan and size implementationPhases from that assessment: simple => P1 current only; moderate => P1 current + at least P2 planned; complex => P1 current + at least P2/P3 planned. If the user explicitly requested phases/stages, use at least P1+P2 and set userForcedPhaseSplit=true. Materialize a full V-model cycle only for the current phase; planned phases remain goals until activated.
- Use HIGH_LEVEL_DESIGN/DETAILED_DESIGN steps to describe module boundaries, responsibilities, dependencies, and extension points that future incremental work can build on.
- When baseline files already exist, prefer editing/extending those modules over creating shadow implementations with duplicate behaviour.

Output a strict JSON plan per the system rules.`,
    plannerPhasePlan: (raw, qa, addenda, opts = {}) =>
      `Original requirement:
"""
${raw}
"""

Clarification Q&A:
${qa || '(none)'}

${addenda ? `User addenda (must be strictly followed; takes priority over vague original wording):\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `Incremental intent: ${opts.intent}

Generate a PhasePlan on top of the existing project. Reuse current architecture, files, tests, and dependencies where possible. Preserve existing behaviour outside the requested change.

Existing project baseline:
"""
${opts.baseline || '(missing baseline)'}
"""

`
  : ''}First generate only the high-level PhasePlan:
- Assess complexity and choose phase count: simple => P1 current only; moderate => P1 current + at least P2 planned; complex => P1 current + at least P2/P3 planned.
- P1 objective must be an independently deliverable and verifiable core slice.
- P2/P3 should contain only future enhancement goals, scope, deliverables, and verification gates. Do not expand any V-model Step.
- Every phase verificationGate must say failures are fed to Debugger, rolled back to the paired V-model phase, and followed by rerunning subsequent phases. Every deliveryGate must declare executable live real-user cases; \`--help\` alone is only an entrypoint smoke check.
- Return only PhasePlan JSON. Do not include steps, architectureModules, or dependencies.`,
    plannerPhaseDecompose: (raw, qa, addenda, opts) =>
      `Original requirement:
"""
${raw}
"""

Clarification Q&A:
${qa || '(none)'}

${addenda ? `User addenda (must be strictly followed; takes priority over vague original wording):\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `Incremental intent: ${opts.intent}

Generate the current phase's incremental V-model StepPlan on top of the existing project. Reuse current architecture, files, tests, and dependencies where possible.

Existing project baseline:
"""
${opts.baseline || '(missing baseline)'}
"""

`
  : ''}Frozen PhasePlan:
"""
${opts.phasePlan}
"""

Phase to expand now: ${opts.phaseId}

Return a full V-model StepPlan only for ${opts.phaseId}:
- Every Step.iterationId must equal "${opts.phaseId}".
- Do not output Steps for any other planned phase; P2/P3 detailed plans are generated only when they become the current phase.
- Treat every other planned phase as explicit excluded scope. Do not include its features, packages,
  artifacts, or acceptance criteria in requirementDigest, globalPrompt, dependencies,
  architectureModules, or steps.
- If ${opts.phaseId} spans multiple concerns (domain logic, CLI/API, file I/O, external integration, orchestration, tests), declare architectureModules for this phase and map module-level work under HIGH_LEVEL_DESIGN/CODE/MODULE_TEST subTasks.
- architectureModules.sourcePaths may only contain product source files under src/. Put product runtime non-code files in assetPaths. Do not register tests/fixtures, tests/utils, sample inputs, temporary outputs, directories, or docs as architecture modules.
- architectureModules.testPaths must be module-contract tests authored by HIGH_LEVEL_DESIGN and executed by MODULE_TEST (normally tests/modules/*). CODE must author separate unit tests and must not repeat these testPaths.
- dependencies contains only packages required by this phase; Python must include pytest; never output requirements.txt.
- This phase must contain the canonical eight V-model macro Steps and synchronous paired test-design outputs.

Return strict JSON StepPlan for the current phase only.`,
    executorSystem: (p) => buildExecutorSystem(p),
    executorDebugBlock: (reason: string, suggestions?: string) =>
      `\n\nYou are now in DEBUG retry mode. Previous failure reason: ${reason}\n` +
      'Use the Bug Ticket and compact failure evidence as the source of truth. In a requirement/design rollback, update only the current contract, test plan, or diagnostic outputs when the concrete source file belongs to a later Step; that later V-model Step will implement it. ' +
      'If the previous attempt stalled on read-only probes, do not repeat discovery: perform the next justified mutation or verification action.' +
      (suggestions ? `\n\n${suggestions}` : ''),
    executorGlobalBlock: (globalPrompt: string) => `\n\n## Project-wide constraints\n${globalPrompt}`,
    executorContextBlock: (context: string) => `\n\n# Assembled context\n${context}`,
    executorRoleBlock: (identity) => `\n\n## Your role\n${identity.rolePrompt}\n${identity.capabilityPrompt}`
      + (identity.prohibitions.length > 0
        ? `\n\nYou must not:\n${identity.prohibitions.map((rule) => `- ${rule}`).join('\n')}`
        : ''),
    executorStepBlock: (sp: string) =>
      `\n\n## Current Step prompt (sole mission — do not drift across steps)\n${sp}`,
    executorSkillBlock: (hints: string[]) =>
      `\n\n## Available skill guidance\n${hints.map((hint) => `- ${hint}`).join('\n')}`,
    executorUserPromptOutro: 'Now return the first round of JSON per the protocol.',
    executorFeedbackHeader: 'Tool results this round:',
    executorFeedbackVerifyOk:
      'outputs verified. If you are done, set done=true and actions=[].',
    executorFeedbackVerifyMissing: (paths: string) =>
      `outputs still missing: ${paths}. Please continue.`,
    executorFeedbackReadOnlyLoopWarning: (rounds: number, targets: string) =>
      `Loop guard warning: the last ${rounds} round(s) used only read/probe tools` +
      (targets ? ` (${targets})` : '') +
      '. Next response must include a successful repair action (apply_patch / replace_in_file / write_file / add_dependency) or a concrete verification action (run_tests / run_program). Do not continue with only read_file, list_dir, code_search, or http_fetch.',
    executorFeedbackReadOnlyRecoveryRequired:
      'Read-only recovery mode is active because the previous attempt already failed from probing. The next response must use existing failure evidence to patch/write/change dependency or run verification; one more read-only-only response will fail this retry.',
    executorFeedbackDiagnosticProbeAllowance: (remainingRounds, maxActionsPerRound) =>
      `Bounded diagnostic collection remains available for ${remainingRounds} round(s), with at most ${maxActionsPerRound} novel read/probe actions per round. ` +
      'Only inspect concrete paths or windows implicated by the current failure evidence; rereading a seen target is rejected. ' +
      'Apply the focused repair immediately once enough evidence is available.',
    executorFeedbackRepairEvidenceMissing:
      'Invalid DEBUG completion: this retry has not produced repair evidence yet. Before done=true, perform at least one successful repair action or successful verification run; otherwise stop only with a concrete blocker in thoughts.',
    executorFeedbackBugResolutionPlanMissing:
      'Invalid DEBUG Bug Ticket action: bugResolutionPlan is required before the first repair or verification action. Return JSON with the root-cause hypothesis, repair target, and validation command together with the needed action.',
    executorFeedbackPostMutationVerificationRequired:
      'The latest successful mutation is not verified. Preserve the current files and use the next action to run the smallest relevant compiler/test gate; do not spend another round only reading or rewriting.',
  },
  skills: {
    patcher:
      'Use apply_patch / replace_in_file for small in-place edits to existing files; never overwrite a whole file. ' +
      'replace_in_file requires args.path, args.find, and args.replace together. path must be a concrete workspace-relative file in the current Step writable allowlist; read_file that same path first when its current bytes are uncertain.',
    author:
      'Use write_file to create new files. It requires a non-empty args.path and string args.content; path must be a concrete workspace-relative path from the current Step outputs or writable allowlist.',
    tester:
      'Write and run pytest tests verifying function behaviour; on failure parse with analyze_error. ' +
      '[Path contract] Every read_file/write_file/append_file/replace_in_file call must include a concrete workspace-relative args.path; never omit it, use a path outside the project, or pass a directory as a file. ' +
      '[Self-contained fixtures] Tests **must NOT** open() a sample file that does not exist on disk. ' +
      'When the target function needs file input, first reuse a real user/workspace sample; if none exists, use http_fetch to get a small reference sample from official docs, the upstream repository, or a public standard/example, ' +
      'save it under tests/fixtures/<name>, and record the source. Only for simple text formats such as CSV/JSON/INI may you construct a minimal pytest tmp_path sample and immediately run_tests. ' +
      'Test phases and DEBUG mode already grant write permission to tests/fixtures/, sub-dirs are auto-mkdir\'d, and **fixture paths do NOT need to be pre-declared in outputs**. ' +
      'When generating tests, always emit every dependent resource so the Debugger does not loop on FileNotFoundError. ' +
      '[Fixture iteration] If a running test raises "Invalid syntax / Parse error / Malformed" from the target function, ' +
      'your fixture content does not match the format spec: read_file to inspect, then prefer a user sample or authoritative http_fetch reference before rewriting and running tests. ' +
      'After repeated failures on a complex domain format, stop inventing from memory and ask for a user sample or network reference. Never edit the implementation or assertions to "fix" a parse error.',
    dep_resolver: 'On ModuleNotFoundError, use add_dependency to write the package back into requirements.txt and rebuild the sandbox.',
    debugger:
      'Reproduce with run_tests/run_program only when no concrete failure log exists. When the error and a complete debug repair packet are already present, apply the smallest scoped patch or dependency change directly, then rerun the failing gate. Read again only when a required file is absent, explicitly truncated, or two replacements on that file have failed.',
    refactorer:
      'Refactors must preserve behaviour: run regression tests → modify → run regression tests again. ' +
      'Every file tool requires a concrete workspace-relative args.path; read_file the same target before a local replacement to confirm its current bytes.',
  },
  doctor: {
    cliDescription: 'check that config / LLM / sandbox / skills are ready',
    optStrict: 'treat warnings as failures (exit non-zero on any warn)',
    header: 'XCompiler environment check',
    sectionConfig: '[config]',
    sectionLLM: '[LLM]',
    sectionSandbox: '[sandbox]',
    sectionSkills: '[skills]',
    summaryOk: 'all checks passed.',
    summaryWarn: (n) => `passed with ${n} warning(s).`,
    summaryFail: (n) => `${n} failure(s) detected.`,
    configLoadOk: (path) => `config loaded: ${path}`,
    configLoadFail: (msg) => `failed to load config: ${msg}`,
    configLocale: (locale) => `locale=${locale}`,
    llmNoProviders: 'no LLM providers defined in config.llm.providers',
    llmProviderListed: (n) => `${n} provider(s) declared`,
    ollamaUnreachable: (baseUrl, msg) => `ollama unreachable @ ${baseUrl} — ${msg}`,
    ollamaReachable: (baseUrl, n) => `ollama reachable @ ${baseUrl} (${n} model(s))`,
    ollamaModelMissing: (provider, model, baseUrl) =>
      `provider "${provider}": model "${model}" NOT installed on ${baseUrl} (run \`ollama pull ${model}\`)`,
    ollamaModelOk: (provider, model) => `provider "${provider}": model "${model}" available`,
    openaiKeyMissing: (provider) => `provider "${provider}": api_key empty (set the provider env var such as OPENROUTER_API_KEY, or config.llm.providers.${provider}.api_key)`,
    openaiReachable: (provider, baseUrl) => `provider "${provider}": OpenAI endpoint reachable @ ${baseUrl}`,
    openaiUnreachable: (provider, baseUrl, msg) => `provider "${provider}": OpenAI /models check failed @ ${baseUrl} — ${msg}`,
    openaiModelListUnavailable: (provider, status) =>
      `provider "${provider}": endpoint is reachable but does not expose /models (HTTP ${status}); model membership was not verified`,
    openaiModelListMissing: (provider, model) =>
      `provider "${provider}": model "${model}" not in /models response (it may still work if your account has access)`,
    providerScoreZero: (provider) => `provider "${provider}" disabled (score=0)`,
    roleNoLiveProvider: (role) => `role "${role}" has no live provider (no candidate is reachable & enabled)`,
    roleOk: (role, provider) => `role "${role}" → ${provider}`,
    sandboxKind: (kind) => `sandbox=${kind}`,
    sandboxNetworkPolicy: (policy, ports) =>
      `network=${policy}` + (ports.length ? ` (expose_ports=[${ports.join(', ')}])` : ''),
    sandboxFullNoPorts:
      'network=full but no expose_ports configured — host-side cannot reach container services. ' +
      'Add `agent.sandboxes.<language>.<local|docker>.limits.expose_ports: [<port>]` in config.yaml.',
    sandboxNodeMissing: (detail) => `node unavailable (required by TypeScript subprocess sandbox): ${detail}`,
    sandboxNodeOk: (version) => `node OK (${version})`,
    sandboxNpmMissing: (detail) => `npm unavailable (required by TypeScript subprocess sandbox): ${detail}`,
    sandboxNpmOk: (version) => `npm OK (${version})`,
    sandboxNpxMissing: (detail) => `npx unavailable (required by TypeScript subprocess sandbox): ${detail}`,
    sandboxNpxOk: (version) => `npx OK (${version})`,
    sandboxPythonMissing: (detail) => `python3 unavailable (required by subprocess sandbox): ${detail}`,
    sandboxPythonOk: (version) => `python3 OK (${version})`,
    sandboxVenvMissing: (detail) =>
      `python3 venv module unavailable (install python3-venv / python3-virtualenv): ${detail}`,
    sandboxVenvOk: 'python3 venv module OK',
    sandboxDockerMissing: (bin) => `docker binary "${bin}" not found on PATH`,
    sandboxDockerOk: (version) => `docker OK (${version})`,
    sandboxDockerDaemonDown: (msg) => `docker daemon not reachable: ${msg}`,
    sandboxInContainerWarn:
      'XCompiler appears to be running inside a container; sandbox=docker is unsupported in this mode (use subprocess).',
    skillToolMissing: (skill, tool) => `skill "${skill}" references unknown tool "${tool}"`,
    skillOk: (n, tools) => `${n} skill(s) registered, ${tools} underlying tool(s)`,
  },
};

export default messages;
