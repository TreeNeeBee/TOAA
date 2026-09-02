# Archived design and refactor plans

These documents drove the work that produced XCompiler 0.3. They are kept for the reasoning behind
decisions the code no longer explains on its own — why a boundary sits where it does, what was
rejected, and which alternatives were weighed.

**They are not current documentation.** Where an archived plan and the running system disagree, the
system is right. For how XCompiler works today, read [`../XCompiler_design.md`](../XCompiler_design.md).

| Document | Delivered in | What it decided |
|---|---|---|
| [XCompiler_refactor_plan.md](XCompiler_refactor_plan.md) | 0.3.0 | The 0.3 architecture: Runtime as the only business entry point, domain objects as the single source of truth, the object registry, and the intentionally breaking compatibility policy. |
| [XCompiler_worktree_mr_context_plan.md](XCompiler_worktree_mr_context_plan.md) | 0.3.0 (P1–P9; P10 optional, not started) | Ticket branches and worktrees, the merge-request gate, and the layered context assembler. |
| [XCompiler_cr_chain_plan.md](XCompiler_cr_chain_plan.md) | 0.3.0 | Change Request propagation as a PM-routed chain, replacing the flat `affectedStepIds` model. |
| [XCompiler_dependency_flow_plan.md](XCompiler_dependency_flow_plan.md) | 0.3.0 | HIGH_LEVEL_DESIGN as the sole owner of the dependency manifest; every need raised elsewhere reaches it as a Change Request. |
| [XCompiler_file_tree_refactor_plan.md](XCompiler_file_tree_refactor_plan.md) | 0.3.x | The project container layout, `worktrees/master/` as the only authoritative product tree, and the write-permission closure. |
| [XCompiler_pm_role_refactor_plan.md](XCompiler_pm_role_refactor_plan.md) | 0.3.0 | ProjectManager as a model role of its own, configured like any other rather than borrowing a planner's registration. |
| [domain-refactor-plan.md](domain-refactor-plan.md) | 0.2 | The earlier domain refactor, superseded by the 0.3 architecture plan above. |
| [HANDOVER_0.3_validation.md](HANDOVER_0.3_validation.md) | 0.3.0 | A point-in-time handover of the 0.3 live-validation state. Its gate counts describe that moment and are not a current claim. |

A plan that is still open belongs in `docs/`, not here. `docs/XCompiler_user_fixture_plan.md` is the
one such document today: the design is settled, the implementation is not.
