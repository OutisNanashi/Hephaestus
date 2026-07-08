# Provider Adapter Contract Proposal

This proposal keeps Codex as the reference backend while making room for the
initial builder-agent stack: Claude Code, OpenAI Codex, Cursor Agent,
OpenCode + GLM-5.2, Devin, and Factory Droid. It is a design document only;
no new adapter implementation is included here.

## Existing Execution Flow Inspected

Current Hephaestus execution is Codex-centered:

- `src/agent-adapters.js` is a small registry with fixture agents plus real
  `codex`, `claude-code`, and `opencode` entries.
- `src/config.js` validates an optional `adapters` block, currently limited to
  `{ enabled: boolean }` for known adapter ids.
- `src/agent-preflight.js` runs harmless `--version` probes with `shell:false`
  and a reduced environment.
- `src/agent.js` runs fixture agents, delivers prompts to
  `out/agent_runs/current/prompt.md`, captures output in `AGENT_OUTPUT.md`,
  classifies usage limits/blockers/failures, and updates `STATE.json`.
- `src/agent-codex-workspace-exec.js` is the real Codex reference path:
  it runs `codex exec --sandbox workspace-write --color never <prompt>` in the
  project directory, closes stdin, redacts output, fingerprints protected files,
  writes `AGENT_OUTPUT.md`, writes `out/agent_runs/<runId>.json`, appends
  `BUILD_LOG.md`, and updates state.
- `src/live-loop.js` hardwires the brain-to-agent loop to
  `runCodexWorkspaceExec`.
- `src/run-live-orchestrator.js` prepares task branches, runs the live loop,
  and optionally chains merge/advance in Auto-merge Mode.
- `src/auto-merge.js`, `src/github-workflow.js`, and `src/merge-gate.js` keep
  branch, commit, PR, approval, merge, and next-phase gates in conductor-owned
  code.

## Proposed Adapter Contract

The first implementation should expose adapters as objects or modules with this
shape. Method names mirror current Codex behavior, but providers may declare
that the conductor owns a step.

```text
ProviderAdapter
- id
- displayName
- configSchema
- capabilities
- preflight(projectContext)
- prepareRun(taskContext)
- deliverPrompt(taskContext)
- runTask(runContext)
- captureOutput(runContext)
- collectArtifacts(runContext)
- classifyResult(runResult)
- detectUsageLimit(runResult)
- relayMergeApproval(mergeContext)
- cleanup(runContext)
- status(runContext)
```

### Core Data

`ProviderIdentity`

```text
id: stable adapter id, e.g. codex, factory-droid, claude-code
displayName: human label
kind: fixture | local-process | local-container | cloud-session | ide-session
providerFamily: codex | factory | anthropic | opencode | cursor | devin
versionCommand: harmless preflight command, if local
defaultEnabled: false for real providers until explicitly configured
```

`AdapterConfig`

```text
enabled: boolean
executable: optional local executable override from a trusted config source
model: optional model or backend label, e.g. GLM-5.2
timeoutMs: optional provider-specific run timeout
sandboxMode: required sandbox/worktree mode
environmentPolicy: exact allowlist of environment variables
auth: references to existing provider login/session, never raw secrets in plans
extra: adapter-owned validated settings only
```

`ProjectContext`

```text
allowedRoot
projectId
projectPath
state
config
registryEntry
```

`TaskContext`

```text
projectContext
promptPath
promptText
taskId
phase
runId
branch
timeoutMs
mergeMode
```

`RunResult`

```text
adapterId
runId
status: completed | blocked | failed | paused
exitCode
classification
startedAt
finishedAt
stdout
stderr
summary
usageLimitDetected
retryAfter
blockerDetected
errorCategory
manualAction
artifacts
statePatch
```

## Capability Flags

Capabilities should be explicit booleans or enums so orchestration can choose
safe paths without provider-specific conditionals.

```text
execution:
  localProcess
  localContainer
  cloudSession
  ideSession
  headless
  nonInteractive
  longRunning

prompt:
  directPromptArg
  stdinPrompt
  promptFile
  externalSessionInstruction

safety:
  nativeSandbox
  requiresContainer
  supportsWorkspaceWrite
  supportsReadOnly
  protectedFileFingerprintingRequired
  shellFalseSupported
  safeEnvAllowlistSupported

artifacts:
  stdoutCapture
  stderrCapture
  structuredReport
  fileDiffCapture
  externalUrlCapture
  sessionTranscriptCapture

limits:
  usageLimitDetectable
  retryAfterDetectable
  rateLimitIsProviderScoped

git:
  canEditWorktree
  canCommit
  canOpenPr
  canMergeAfterApproval
  conductorOwnsGit

merge:
  canReceiveApprovalRelay
  canPerformApprovedMerge
  externalMergeOnly

operations:
  supportsPreflight
  supportsCleanup
  supportsStatusPolling
  supportsCancellation
```

## Classification Contract

Adapters should map provider-specific output to common classifications:

```text
PASS
ADAPTER_NOT_INSTALLED
ADAPTER_NOT_AUTHENTICATED
USAGE_LIMIT
TIMEOUT
EXIT_NONZERO
EMPTY_OUTPUT
AGENT_BLOCKER
PROTECTED_FILES_MODIFIED
INTERACTIVE_REQUIRED
GIT_REPO_REQUIRED
SANDBOX_UNAVAILABLE
SANDBOX_DOWNGRADED
CONFIG_INVALID
EXTERNAL_SESSION_PENDING
EXTERNAL_SESSION_FAILED
```

The conductor maps these to existing state transitions:

```text
PASS -> completed, nextAction=agent-completed
USAGE_LIMIT -> paused, nextAction=agent-usage-limit-paused
AGENT_BLOCKER/EMPTY_OUTPUT/PROTECTED_FILES_MODIFIED/GIT_REPO_REQUIRED/SANDBOX_* -> blocked
NOT_INSTALLED/NOT_AUTHENTICATED/TIMEOUT/EXIT_NONZERO/INTERACTIVE_REQUIRED/CONFIG_INVALID -> failed or blocked based on manualAction
EXTERNAL_SESSION_PENDING -> running or blocked depending on provider status age
```

## Codex Mapping

Codex remains the reference implementation.

```text
id: codex
kind: local-process
preflight: codex --version
deliverPrompt: copy prompt to out/agent_runs/current/prompt.md
runTask: codex exec --sandbox workspace-write --color never <prompt>
cwd: projectPath
stdin: closed empty input
env: LANG, PATH, HOME/USERPROFILE/APPDATA/LOCALAPPDATA/CODEX_HOME only
output: stdout/stderr redacted, AGENT_OUTPUT.md, JSON run report
artifacts: out/agent_runs/<runId>.json, AGENT_OUTPUT.md, BUILD_LOG.md entry
usage limits: detected from Codex usage/rate/quota text and retry hints
protected files: fingerprint PLAN.md, CURRENT_TASK.md, STATE.json, BUILD_LOG.md, TESTS.json, .env
git/PR/merge: conductor-owned today
cleanup: remove only known run-scoped artifacts if a future cleanup command asks for it
status: synchronous process result
```

## Factory Droid Mapping

Factory Droid should be the first non-Codex spike because its lane is expected
to be headless and artifact-producing.

```text
kind: local-process or cloud-session, depending on verified Factory CLI/API
preflight: verify Factory auth, project access, and command availability
prompt delivery: mission/task payload or prompt file, not ad hoc shell text
runTask: start a Droid/Mission against an isolated branch/worktree
output capture: structured mission result plus transcript/log URL if available
artifact capture: changed files, reports, review artifacts, mission ids
usage limits: classify Factory quota/concurrency/session-cap messages
git/PR: prefer conductor-owned commit/PR/merge until Droid PR behavior is proven
merge approval relay: send GPT approval as a supervised instruction only if Factory can target the exact PR head
cleanup: close/cancel stale missions and collect final artifacts
status: poll mission status if runs are asynchronous
```

## Claude Code Mapping

Claude Code should be the second non-Codex spike.

```text
kind: local-process
preflight: claude --version plus auth/session availability if a harmless probe exists
prompt delivery: verified non-interactive prompt path only
runTask: use the safest confirmed headless invocation with project cwd and no broad filesystem access
output capture: stdout/stderr transcript and project-local report
artifact capture: files changed, run transcript, any tool-use summary available
usage limits: classify Claude usage-limit and subscription-limit text
sandbox: require container/worktree isolation unless a native workspace-write equivalent is verified
git/PR/merge: conductor-owned for the spike
merge approval relay: later, only as exact-head instruction after merge gate passes
cleanup: terminate stale local processes and remove run-scoped temp files
status: synchronous process result unless CLI exposes session polling
```

## Other Provider Notes

`OpenCode + GLM-5.2` should be modeled as a cost-sensitive local/container
lane. It likely needs `requiresContainer=true`, explicit model/backend config,
strict env allowlists, and conductor-owned git/merge behavior.

`Cursor Agent` should stay in registry/preflight-only mode until exact local
headless CLI flags are verified. Treat it as `ideSession` or `local-process`
only after confirming non-interactive prompt delivery and output capture.

`Devin` should be modeled as `cloudSession`, not a normal local process. Its
adapter should start or update an external supervised session, poll status,
capture URLs/transcripts/artifacts, and leave local branch/commit/merge control
with the conductor unless Devin can prove exact-head PR behavior.

## Required Code Touchpoints

```text
src/agent-adapters.js
  Replace static metadata-only entries with adapter descriptors and capability flags.

src/config.js
  Expand adapters.<id> validation beyond enabled to typed, adapter-owned config.

src/agent-preflight.js
  Delegate harmless probes to adapter.preflight(projectContext).

src/agent-run-plan.js
  Render provider-specific dry-run plans from capabilities.

src/agent-codex-workspace-exec.js
  Keep as Codex reference, then split reusable lifecycle helpers from Codex-specific invocation.

src/agent.js
  Reuse output/state helpers, or move them into an adapter runtime module.

src/live-loop.js
  Replace direct runCodexWorkspaceExec call with adapter selection and adapter.runTask.

src/run-live-orchestrator.js
  Pass assigned adapter/provider context into the loop.

src/auto-merge.js and src/github-workflow.js
  Keep conductor-owned initially; later call adapter.relayMergeApproval only when capability flags allow it.

test/
  Add contract tests for capability validation, Codex parity, Factory/Claude dry-run spikes, and non-Codex disabled-safe behavior.
```

## Recommended First Implementation Step

Create a `src/provider-adapter-contract.js` module that defines the shared
classification constants, capability defaults, and validation helpers. Then
wrap the existing Codex workspace executor in a `codex` adapter without
changing behavior. The first passing milestone should prove that
`run-live --project <id>` still produces the same Codex classifications,
artifacts, state transitions, and merge behavior through the adapter boundary.

After Codex parity, add preflight/dry-run-only descriptors for `factory-droid`
and `claude-code`; enable real execution only after their exact safe invocation
contracts are verified locally.

## Risks And Unknowns

- Factory Droid invocation, auth, mission polling, artifact schema, and PR
  behavior need live verification.
- Claude Code headless flags, sandbox behavior, and non-interactive output
  contract need live verification.
- Cursor Agent must wait for verified headless CLI flags.
- OpenCode + GLM-5.2 needs container and model/backend configuration details.
- Devin is asynchronous/cloud-supervised, so polling, cancellation, URL capture,
  and stale-session handling must be first-class.
- Provider output formats may drift; classification must be conservative.
- Merge relay is easy to over-permission. Default should remain
  conductor-owned commit/PR/merge until exact-head provider behavior is proven.
- Secret handling must stay provider-specific and allowlist-based; brain API
  keys must never leak into coding-agent environments.
