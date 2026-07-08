# Factory Droid test fixtures

These files are **synthetic examples derived from the documented `droid exec`
JSON output schema** (https://docs.factory.ai/cli/droid-exec/overview), not the
output of any real `droid` run. They exist so the mock/dry-run Factory execution
boundary can be tested against the verified output shape without executing a real
Factory task or consuming credits.

Documented JSON fields: `type`, `subtype`, `is_error` (boolean), `duration_ms`
(number), `num_turns` (number), `result` (string), `session_id` (string).

Usage-limit / quota / authentication failure message text is **not documented**
by Factory, so those classification patterns remain best-effort and unverified.
