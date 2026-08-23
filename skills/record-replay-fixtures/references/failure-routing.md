# Record/Replay Failure Routing

| Failure | Owner | Required response |
|---|---|---|
| `replay_miss` with a stable valid request | Test design or verification supplement | Record the missing case through an authorized live run, then freeze and replay it. |
| `replay_miss` with unstable request fields | Calling implementation or test harness | Normalize only nondeterministic identity fields; preserve behavior-significant fields. |
| `replay_ambiguous` | Fixture history | Inspect supersession links and retain exactly one active chain head. |
| `record_corrupt` | Fixture storage/integrity | Preserve evidence, quarantine the corrupt record, and reacquire data; never overwrite history silently. |
| `secret_detected` | Capture request/response design | Redact or exclude the secret before persistence. Do not weaken detection. |
| Replay is green but live Phase gate fails | Product/API contract or external dependency | Preserve the live scene and submit it to PM intake; do not refresh the fixture to hide drift. |

Fixture repair and product repair are separate changes. A fixture may be refreshed only after the
contract change is accepted and its provenance is recorded.
