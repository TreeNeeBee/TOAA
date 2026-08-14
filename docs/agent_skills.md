# XCompiler Agent Skills

XCompiler uses the [Agent Skills Specification](https://agentskills.io/specification) as the
contract for reusable Agent workflows. A Skill is a directory whose required `SKILL.md` contains
YAML frontmatter and Markdown instructions. Optional resources live under `references/`, `scripts/`,
or `assets/`.

This layer composes existing Tools. It does not own Project, Phase, Step, Ticket, permission, Git,
quality-gate, Record/Replay, or Debug Wiki lifecycle state.

## Loading Model

XCompiler applies three-level progressive disclosure:

1. **Planning metadata**: Build gives Planner only each Skill's `name` and `description`.
2. **Activated instructions**: Run loads a `SKILL.md` body only when a Step selects
   `skill:<name>` or Runtime activates a mode-specific Skill.
3. **On-demand resources**: an active Skill may read a file under `references/`, `scripts/`, or
   `assets/` with the read-only `skill_resource` Tool. Scripts are never executed by that Tool.

Unknown Skills, duplicate names, malformed frontmatter, directory/name mismatches, and references
to unknown Tools fail explicitly. The recommended 500-line `SKILL.md` size is authoring guidance,
not a runtime cap; larger workflows should split optional material into resources.

## Directory Contract

```text
skill-name/
  SKILL.md
  references/   # optional, loaded on demand
  scripts/      # optional, read-only through skill_resource
  assets/       # optional, loaded on demand
```

Minimal `SKILL.md`:

```markdown
---
name: example-check
description: Check a focused project contract. Use when that contract is part of a Step gate.
license: Apache-2.0
compatibility: XCompiler 0.3+
metadata:
  xcompiler.category: verification
allowed-tools: read_file code_search run_tests
---

# Example Check

Inspect the contract, run the narrowest falsifying test, and report attributable evidence.
```

`name` uses lowercase letters, digits, and hyphens, is at most 64 characters, and must equal the
parent directory name. `description` states both capability and trigger conditions. XCompiler's
`allowed-tools` is the specification's experimental field restricted to registered XCompiler Tool
names separated by spaces.

## Authority And Security

Selecting a Skill does not grant unrestricted access:

- Planner may select only registered Skill names.
- A Skill exposes only its declared Tools.
- Step/Ticket ownership, writable paths, Runtime permission decisions, sandbox policy, and
  EditGuard still constrain every Tool call.
- Skill resources are available only while that Skill is active and cannot traverse or follow a
  symbolic link outside the Skill directory.
- Plugin Skill metadata is validated before plugin module import. Plugin API 3 rejects conflicting
  names instead of overriding a built-in or earlier Plugin Skill.

Skills do not replace PM planning, Ticket routing, V-model transitions, Git ChangeSets, or delivery
gates. Those remain deterministic Runtime and Domain responsibilities.

## Built-In Catalog

| Skill | Purpose |
| --- | --- |
| `artifact-authoring` | Create declared Step outputs and new files in context-sized chunks |
| `focused-file-editing` | Patch existing files from current evidence |
| `file-operations` | Mixed workspace discovery and file mutation workflow |
| `web-resource-validation` | Validate APIs, URLs, public fixtures, and official references |
| `test-design` | Author S1-S4 paired baseline tests |
| `test-execution` | Inspect, freeze, run, and report S5-S8 verification suites |
| `record-replay-fixtures` | Guide external-data capture, replay, refresh, integrity, and routing while current tests still execute |
| `systematic-debugging` | Evidence-first Bug diagnosis, repair plan, patch, and verification |
| `debug-wiki-knowledge` | Evaluate prior fixes and feed back verified/counterexample evidence |
| `node-inspect-debugger` | Escalate Node/TypeScript failures to V8 inspector diagnostics |
| `python-debugger` | Escalate Python failures to pdb/debugpy diagnostics |
| `api-integration-debugging` | Diagnose HTTP authentication, status, schema, and fallback failures |
| `build-package-diagnostics` | Diagnose compile, install, module-resolution, and package failures |
| `dependency-resolution` | Apply dependency changes at the manifest-owning Step |
| `test-flake-investigation` | Isolate nondeterminism, timing, shared state, and race failures |
| `performance-profiling` | Measure KPI regressions before optimizing |
| `behavior-preserving-refactoring` | Refactor behind an established baseline |
| `change-request-implementation` | Apply an accepted upstream contract delta incrementally |
| `code-review` | Review correctness, architecture, security, and missing tests |
| `security-boundary-review` | Review paths, permissions, subprocess, network, plugin, and secret boundaries |
| `verification-before-delivery` | Require fresh evidence before delivery claims |
| `skill-authoring` | Create and validate Agent Skills for XCompiler Plugin API 3 |

Record/Replay and Debug Wiki use hybrid designs. Their Skills teach the Agent how to prepare,
evaluate, and route evidence; Runtime controllers retain mode selection, persistence, redaction,
hash chains, retrieval, feedback, and audit authority.

## Open-Source References

The built-in workflows are original XCompiler instructions adapted to its PM, V-model, Tool, and
security contracts. Their design also draws on:

- [Hermes Agent skills](https://github.com/NousResearch/hermes-agent/tree/main/skills) for explicit
  use/don't-use boundaries, evidence-first debugging, escalation, pitfalls, and verification.
- [Hermes Node Inspector Debugger](https://github.com/NousResearch/hermes-agent/blob/main/skills/software-development/node-inspect-debugger/SKILL.md)
  for debugger escalation after cheaper diagnostics are insufficient.
- [OpenHands Extensions](https://github.com/openhands/extensions) for focused code-review and
  behavior-preserving simplification workflows.
- [Superpowers skills](https://github.com/obra/superpowers/tree/main/skills) for systematic
  debugging, verification before completion, and testing Skill behavior itself.

Generic planning, worktree management, Git operations, permissions, and Ticket routing from other
Agent catalogs are intentionally not imported as Skills: XCompiler already owns those operations in
PM, Runtime, Domain policies, and guarded application services.

## Plugin API 3

A plugin declares Skill roots relative to its plugin root:

```json
{
  "id": "example.checks",
  "version": "1.0.0",
  "apiVersion": 3,
  "minXCompilerVersion": "0.3.0",
  "skills": ["skills"]
}
```

`loadPluginSources()` validates every declared Skill before importing plugin code, then registers
the directory through `registerSkillDirectory()`. Programmatically constructed plugins may call the
same API in `setup()`. See [Plugin API](plugin_api.md).

## Authoring Checklist

1. Define concrete triggers and non-goals in `description` and the body.
2. Declare only Tools the workflow genuinely needs.
3. Keep instructions procedural and move optional detail to one-level references.
4. Describe expected failures, escalation, security constraints, and completion evidence.
5. Test selection, non-selection, Tool expansion, malformed metadata, resource boundaries, and a
   realistic success/failure task before publishing.
