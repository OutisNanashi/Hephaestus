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
node src/cli.js run-live --project <id> [--max-cycles n]  # Manual-merge Mode
node src/cli.js run-live --project <id> --auto-merge      # Auto-merge Mode
node src/cli.js record-tests --project <id>               # run declared tests, record evidence
node src/cli.js pr-open --project <id> --provider github  # open/update the real PR
node src/cli.js merge-approve --project <id>              # scoped GPT merge verdict
node src/cli.js merge-execute --project <id>              # gated real merge
```

Fixture/mocked variants of every stage remain available for testing; run
`node src/cli.js --help` for the complete list.

`run-live` defaults to **Manual-merge Mode**: it stops after the worker loop
reaches `task-complete`, leaving `pr-open`, `merge-approve`, and
`merge-execute` as a separate manual chain. **Auto-merge Mode** is explicit:
`run-live --auto-merge` runs that existing chain only after exact
`task-complete`, with GPT approval and merge gates still authoritative.

## Safety model

- Codex may only write inside the selected project; conductor-owned files
  (PLAN.md, STATE.json, BUILD_LOG.md, …) are fingerprinted and any tampering
  blocks the run.
- No merge happens without passing test evidence, a retest after the last
  change, and GPT approval pinned to the exact PR head commit.
- Usage limits pause the project instead of failing it; blockers notify
  Telegram once and wait for the owner.
