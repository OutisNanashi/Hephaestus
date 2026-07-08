# Hephaestus

Hephaestus is a personal AI build factory: a GPT brain decides the next bounded
task, the Codex CLI executes it inside its workspace-write sandbox (writes
confined to the project folder, no approval prompts, bypass flags rejected),
and a merge gate allows the real GitHub merge only after tests, retests, and a
scoped GPT approval all pass. See [PLAN.md](PLAN.md) for the full design and
[deploy/DEPLOY.md](deploy/DEPLOY.md) for running it live on a VPS.

## Core commands

```sh
npm test                                                  # full suite
node src/cli.js status                                    # read-only project overview
node src/cli.js validate --project <id>                   # check a registered project
node src/cli.js run-live --project <id> [--max-cycles n]  # Manual-merge Mode (one phase)
node src/cli.js run-live --project <id> --auto-merge      # Auto-merge Mode (whole project)
node src/cli.js next-phase --project <id>                 # advance a merged project one phase
node src/cli.js record-tests --project <id>               # run declared tests, record evidence
node src/cli.js pr-open --project <id> --provider github  # open/update the real PR
node src/cli.js merge-approve --project <id>              # scoped GPT merge verdict
node src/cli.js merge-execute --project <id>              # gated real merge
```

Fixture/mocked variants of every stage remain available for testing; run
`node src/cli.js --help` for the complete list.

**Auto-merge Mode** (`run-live --auto-merge`) drives a whole project by
itself: for each PLAN.md phase it runs the brain-to-Codex build loop, then —
only after exact `task-complete` — commits, records tests, opens the PR, gets
scoped GPT approval, merges, and advances to the next phase (the brain reads
the plan to decide it). It repeats until the plan is complete, something
blocks or pauses, or a phase budget is reached; the systemd timer resumes it.
GPT approval and every merge gate stay authoritative. With the timer enabled,
onboarding a project is: write its `PLAN.md`, register it, run once.

**Manual-merge Mode** (the default) runs one build loop and stops at
`task-complete`, leaving `pr-open`, `merge-approve`, `merge-execute`, and
`next-phase` as a supervised chain you drive yourself.

## Providers

Each registered project may declare which coding-agent provider it uses via an
optional `provider` field in the project registry:

```json
{
  "projects": [
    { "id": "prism", "path": "prism", "provider": "codex" }
  ]
}
```

- **Default:** a project with no `provider` field defaults to `codex`, so
  existing registries keep working unchanged.
- **Codex is currently the only executable provider.** `run-live` resolves the
  project's provider through the live-execution gate (`selectLiveProvider`)
  before any branch prep or task execution; only Codex passes today.
- **Factory Droid (`factory-droid`) is preflight-only.** It is a *known*
  provider — you can register it and run preflight/status inspection against the
  `droid` CLI — but it is not live-executable. A project declaring
  `factory-droid` is accepted by the registry yet fails fast with a clear
  `PROVIDER_NOT_LIVE_EXECUTABLE` error before any task runs, until the real
  Factory execution adapter is implemented. Enabling it in the `providers`
  config block does not bypass this; the adapter capability gate still blocks it.
- Unknown provider ids are rejected at registry load with `INVALID_REGISTRY`.
- Live execution can be gated per provider in `hephaestus.config.json` via an
  optional `providers` block (`{ "<id>": { "enabled": bool, "executionEnabled": bool } }`);
  a missing block leaves Codex live-executable and every non-capable provider off.

## Safety model

- Codex may only write inside the selected project; conductor-owned files
  (PLAN.md, STATE.json, BUILD_LOG.md, …) are fingerprinted and any tampering
  blocks the run.
- No merge happens without passing test evidence, a retest after the last
  change, and GPT approval pinned to the exact PR head commit.
- Usage limits pause the project instead of failing it; blockers notify
  Telegram once and wait for the owner.
