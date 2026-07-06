# Deploying Hephaestus on a Linux VPS

The VPS is the intended live environment: Codex's `workspace-write` sandbox is
kernel-enforced on Linux, and the machine can run around the clock.

## 1. Bootstrap

As root on a fresh Ubuntu/Debian VPS:

```sh
curl -fsSL https://raw.githubusercontent.com/OutisNanashi/Hephaestus/master/deploy/vps-setup.sh | bash
```

This installs Node 20, the GitHub CLI, and the Codex CLI, clones Hephaestus to
`/opt/hephaestus`, creates `/srv/projects`, and copies `.env.example` to `.env`.

## 2. One-time interactive logins

```sh
codex login      # OpenAI account used by the coding agent
gh auth login    # GitHub account used for PRs and merges
```

## 3. Secrets

Edit `/opt/hephaestus/.env`:

```
OPENAI_API_KEY=...        # brain (GPT decisions and merge approvals)
TELEGRAM_BOT_TOKEN=...    # optional notifications
TELEGRAM_CHAT_ID=...
```

## 4. Live configuration

Create `/opt/hephaestus/hephaestus.vps.config.json` (not tracked by git):

```json
{
  "allowedRoot": "/srv/projects",
  "registryPath": "./projects.vps.json",
  "logDirectory": "./logs",
  "brain": { "provider": "openai", "model": "gpt-5.4-mini" },
  "notifications": {
    "telegram": { "enabled": true, "botTokenEnv": "TELEGRAM_BOT_TOKEN", "chatIdEnv": "TELEGRAM_CHAT_ID" }
  }
}
```

And `/opt/hephaestus/projects.vps.json` listing each real project:

```json
{ "projects": [ { "id": "kioku", "path": "kioku" } ] }
```

## 5. Onboarding a project

Each project lives under `/srv/projects/<id>` and must:

- be a **git repository** with a GitHub remote (Codex refuses folders without version control),
- contain `PLAN.md`, `BUILDING_REFERENCE.md`, `BUILD_LOG.md`, `CURRENT_TASK.md`, and a valid `STATE.json`,
- contain a `TESTS.json` declaring the required test commands; give each
  command an `argv` array so the conductor can run it and record evidence, e.g.
  `{ "requiredCommands": [{ "id": "unit", "outputRequired": true, "argv": ["npm", "test"] }], "watchedFiles": ["src/index.js"] }`,
- gitignore nothing special — conductor artifacts (`STATE.json` churn, `out/`, `merge-inbox/`) are ignored by the merge gate's dirty-tree check automatically.

Verify before enabling automation:

```sh
cd /opt/hephaestus
node src/cli.js validate --config hephaestus.vps.config.json --project <id>
node src/cli.js agent-codex-readonly-smoke --config hephaestus.vps.config.json --project <id>
node src/cli.js live-brain --config hephaestus.vps.config.json --project <id>
```

## 6. Running

One supervised burst (up to 5 brain/agent cycles):

```sh
node src/cli.js run-live --config hephaestus.vps.config.json --project <id>
```

This is **Manual-merge Mode**, the default. It runs the live worker loop and
does not open/update a PR, request GPT merge approval, or execute a merge.
To opt into **Auto-merge Mode** for a finished task:

```sh
node src/cli.js run-live --config hephaestus.vps.config.json --project <id> --auto-merge
```

Auto-merge Mode drives the **whole project**: for each PLAN.md phase it runs
the build loop, and only after exact `task-complete` commits the work, records
test evidence (`record-tests`), opens the PR, gets scoped GPT approval, merges,
and advances to the next phase (the brain reads PLAN.md and the build log to
decide the next task). It repeats until the plan is complete, something blocks
or pauses, or the phase budget is hit. GPT approval and merge gates still
decide whether anything merges. So a supervised full build is one command:

```sh
node src/cli.js run-live --config hephaestus.vps.config.json --project <id> --auto-merge
```

Unattended, via systemd (one timer per project):

```sh
cp deploy/systemd/hephaestus@.service deploy/systemd/hephaestus@.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hephaestus@<id>.timer
```

The timer re-runs the loop every 15 minutes. Blocked or paused projects exit
immediately without doing anything, and each terminal event notifies Telegram
exactly once (deduplicated across runs).

## 7. Merging a finished task

The manual chain remains available:

```sh
node src/cli.js git-commit --config hephaestus.vps.config.json --project <id> --message "<summary>"
node src/cli.js record-tests --config hephaestus.vps.config.json --project <id>
node src/cli.js pr-open --config hephaestus.vps.config.json --project <id> --provider github
node src/cli.js merge-approve --config hephaestus.vps.config.json --project <id>
node src/cli.js merge-execute --config hephaestus.vps.config.json --project <id>
```

`merge-execute` re-checks every gate (tests, retest, scoped GPT approval, clean
tree, open mergeable PR) against live GitHub data and refuses with a list of
blockers if anything is off.

## Day-2 operations

- Paused by a usage limit: `node src/cli.js resume --config hephaestus.vps.config.json --project <id>` once the limit resets.
- Status overview: `node src/cli.js status --config hephaestus.vps.config.json` or `dashboard`.
- Update Hephaestus: `cd /opt/hephaestus && git pull --ff-only && npm test`.
