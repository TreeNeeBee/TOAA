# XCompiler Major Change Audit Index

This directory contains two deliberately separated kinds of audit data:

- whitelisted repository records such as this index and major architecture audits;
- ignored local session timelines, which may contain prompts, host paths, or runtime context and must not be committed.

Runtime execution logs remain under each generated project's `.xcompiler/` directory and are not substitutes for these repository records. The production audit implementation remains in `src/audit/`; it is source code, not a second audit-record store.

| Audit ID | Date | Change | Status | Record |
| --- | --- | --- | --- | --- |
| `XC-AUDIT-2026-08-01-DOMAIN-001` | 2026-08-01 | Runtime domain and ticket-driven V-model refactor | Complete, commit pending | [2026-08-01-runtime-domain-refactor.md](2026-08-01-runtime-domain-refactor.md) |

## Record Rules

- Never include credentials, API keys, tokens, private endpoints, or generated-project customer data.
- Record the pre-change baseline commit and the final change commit separately.
- Preserve failed validation attempts together with their classification and resolution.
- State compatibility breaks and recovery instructions explicitly.
- Update `Final change commit` after the audited change is committed.
