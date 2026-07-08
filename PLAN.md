Personal AI Build Factory Plan
1. Purpose
The project is a personal automation system that removes the need for manual copy pasting between GPT and coding agents.
The user still creates the project plan manually.
The system automates the building phase.
The goal is to let multiple projects build in parallel with different coding agents, while GPT acts as the central brain for each project.
The user is not trying to automate creativity, planning, or project ownership.
The user is trying to automate the repetitive execution loop that currently consists of copying GPT prompts into coding agents, copying coding-agent outputs back into GPT, approving commands blindly, waiting for results, and repeating the same process until the project phase is complete.
2. Core idea
The system replaces this manual loop.
```text
GPT creates coding prompt
User copies prompt
User pastes into coding agent
Coding agent works
User approves commands blindly
Coding agent runs tests
Coding agent reports result
User copies coding agent result
User pastes result into GPT
GPT creates next prompt
Repeat
```
With this automated loop.
```text
GPT brain reads project state
GPT brain creates next prompt
Conductor sends prompt to coding agent
Coding agent builds inside container
Coding agent auto-runs commands inside container
Coding agent runs tests
Coding agent reports result
Conductor sends result back to GPT brain
GPT decides next step
Coding agent continues, repairs, merges, or reports blocker
Loop repeats
```
The user should no longer be the copy-paste middleman.
The user should only be involved when something is truly manual or cannot be safely automated.
3. User role
The user is not the operator of the build loop.
The user is the project owner and architect.
The user does these things manually.
```text
Create the rough idea
Create PLAN.md
Create project phases
Define what the project should become
Define important constraints
Understand the project enough to keep ownership
Handle real manual actions when required
```
The user does not do these things during automation.
```text
No copying prompts
No pasting agent outputs
No reading every command
No clicking approve
No manually running tests
No manually deciding every repair prompt
No manually merging
No manually moving from one phase to the next
```
The user’s desired role is this.
```text
Henri creates the plan.
GPT acts as chief engineer.
Coding agents execute.
The conductor moves messages and state.
The coding agent merges after GPT approval.
Henri is notified only for true manual blockers.
```
4. System name
Suggested name.
```text
Build Conductor
```
Other possible names.
```text
Forge
Project Conductor
Agent Factory
Build Factory
Henri Build System
AI Build Factory
Software Factory
```
5. Main components
A. GPT brain
GPT is the strategic brain.
GPT does not directly run the terminal.
GPT does not directly edit files unless used through a coding agent.
GPT reads the project plan, reads the latest coding-agent report, decides what should happen next, and writes the next instruction.
Responsibilities.
```text
Read PLAN.md
Read BUILDING_REFERENCE.md
Read BUILD_LOG.md
Read STATE.json
Read CURRENT_TASK.md
Read AGENT_OUTPUT.md
Read coding-agent reports
Interpret test failures
Decide whether to continue, repair, retry, switch agent, merge, pause, or stop
Create next coding-agent prompt
Create repair prompts
Approve or reject merge readiness
Create summaries when context gets long
Decide when user notification is required
```
GPT is the decision maker.
It decides what the coding agent should do next.
It decides whether a phase is complete.
It decides whether merge approval is allowed.
B. Build Conductor
The conductor is the messenger and controller.
It does not need to be very intelligent.
It replaces the user’s blind copy-paste role.
Responsibilities.
```text
Start project loops
Assign coding agents to projects
Start containers
Send prompts from GPT to coding agents
Capture coding-agent outputs
Save logs
Send coding-agent outputs back to GPT
Manage project state files
Manage branches and worktrees if needed
Manage usage-limit pauses
Resume agents when available
Send notifications
Relay GPT’s merge approval to the coding agent
Record merge results
Keep each project loop moving
```
The conductor does not decide whether to merge.
The conductor does not judge project quality.
The conductor does not replace GPT.
The conductor does not replace the coding agent.
The conductor is the automated messenger and state machine.
C. Coding agents
Coding agents are the workers.
Each coding agent should work on one project or one isolated task at a time.
The intended initial Hephaestus builder-agent stack is.
```text
Claude Code
OpenAI Codex
Cursor Agent
OpenCode + GLM-5.2
Devin
Factory Droid
```
Other coding agents may be useful later, but they are examples only and are not part of the intended initial stack unless explicitly promoted.
Examples outside the initial stack.
```text
Cline
Aider
Jules
Sourcegraph Amp
v0
Bolt
Replit Agent
GitHub Copilot coding agent
Kiro
JetBrains Junie
```
Responsibilities.
```text
Read the prompt
Edit files
Run commands
Run tests
Run build
Run lint
Run typecheck
Fix failures
Open or update PRs
Apply GPT’s repair instructions
Rerun tests after fixes
Merge after GPT approval
Update BUILD_LOG.md and STATE.json when instructed
Report blockers
```
The coding agent is the executor.
It builds, tests, fixes, and merges.
D. Containers
Each project should run inside an isolated container.
A container is not just a folder.
A folder is only the project location.
A container is a separate isolated environment where the coding agent can work without touching the rest of the machine.
The coding agent can be auto-approved inside the container because damage is limited.
The correct rule is this.
```text
Auto-approve everything inside the isolated project container.
```
The incorrect rule is this.
```text
Auto-approve everything on the real PC or VPS.
```
The normal project folder can be mounted into the container so changes appear directly in Windows File Explorer.
Example.
```text
C:\Projects\Kioku
mounted as
/workspace
inside Docker
```
If the coding agent edits this file.
```text
/workspace/src/app/page.tsx
```
The same file appears here on Windows.
```text
C:\Projects\Kioku\src\app\page.tsx
```
So when the container work is finished, there is usually nothing to transfer.
The files are already in the normal project folder.
6. Container versus folder
A folder is not enough by itself.
A folder tells the agent where to work.
A container limits what the agent can touch.
Easy explanation.
```text
A folder means work at this desk.

A container means work inside this locked room with only the tools and files provided.
```
A folder alone is weaker because a terminal-capable agent may still be able to run commands outside the folder.
A container is safer because it limits the environment.
Comparison.
```text
Folder
Holds project files
Does not reliably isolate the rest of the system
Does not isolate dependencies
Risky for full auto-approval

Container
Holds or mounts project files
Isolates the work environment
Can isolate dependencies
Can be deleted and recreated
Much safer for full auto-approval
Correct for overnight autopilot
```
The target system should use both.
```text
Project folder
C:\Projects\Kioku

Container workspace
/workspace

Mounted relation
C:\Projects\Kioku -> /workspace
```
7. Existing projects
The system must work for both new projects and already-started projects.
Already-started projects do not need to be restarted.
To use the system with an existing project.
```text
Keep the existing project folder
Add Docker setup around it
Mount the existing folder into the container
Make sure dependencies install inside the container
Make sure tests run inside the container
Start the conductor loop
```
Example.
```text
Existing project
C:\Projects\Hermes

Container workspace
/workspace

The coding agent works in
/workspace

Windows still sees files in
C:\Projects\Hermes
```
Before assigning the project to an automated coding agent, the container should ideally be able to run these.
```text
Install dependencies
Run tests
Run build
Run lint
Run typecheck
Start dev server if needed
```
8. Project folder structure
Each project should have a predictable structure.
```text
C:\Projects\Kioku
  PLAN.md
  BUILDING_REFERENCE.md
  BUILD_LOG.md
  STATE.json
  CURRENT_TASK.md
  AGENT_OUTPUT.md
  HUMAN_NEEDED.md
  docker
    Dockerfile
    docker-compose.yml
  out
    prompts
    agent_outputs
    summaries
    test_reports
    merge_reports
```
The structure should be consistent across projects so the conductor can operate automatically.
9. File purposes
PLAN.md
The main project plan.
Created manually by the user.
Contains.
```text
Goal
Architecture
Features
Phases
Tests
Constraints
Completion criteria
Phase gates
What each phase must build
What each phase must prove
```
BUILDING_REFERENCE.md
The permanent construction rules.
Contains.
```text
What must not be changed
Architecture rules
Naming rules
Testing rules
Security rules
Project-specific principles
Important past decisions
Forbidden simplifications
Known fragile areas
How agents should interpret the plan
```
BUILD_LOG.md
Chronological history of what happened.
Updated automatically by the coding agent or conductor when instructed.
Contains.
```text
Date
Agent used
Prompt summary
Files changed
Tests run
Result
Merge status
Next step
```
STATE.json
Machine-readable state.
Contains.
```text
Current phase
Current task
Current branch
Current PR
Assigned agent
Attempt count
Blocked status
Usage-limit status
Last successful step
Merge status
Container status
Last GPT decision
Next action
```
CURRENT_TASK.md
The current task being executed.
Contains.
```text
Task objective
Allowed files
Forbidden files
Expected result
Tests the coding agent must run
Stop conditions
Merge conditions
```
AGENT_OUTPUT.md
Latest coding-agent response.
Contains.
```text
What the agent did
What files changed
What tests ran
What passed
What failed
What is blocked
What the agent recommends next
```
HUMAN_NEEDED.md
Only used when the system requires the user.
Contains.
```text
Manual action required
Why automation cannot continue
Exact thing the user must do
What file to edit if needed
What command to run if needed
What credential or login is needed
What to report back
```
10. Normal build loop
The normal loop works like this.
```text
1. Conductor reads project files

2. Conductor sends project state to GPT brain

3. GPT brain decides the next action

4. GPT brain creates exact coding-agent prompt

5. Conductor sends prompt to assigned coding agent

6. Coding agent works inside project container

7. Coding agent uses auto-approval inside the container

8. Coding agent edits files

9. Coding agent runs the required tests itself

10. Coding agent fixes failures when possible

11. Coding agent reports result

12. Conductor saves the output

13. Conductor sends output back to GPT brain

14. GPT brain decides whether to continue, repair, merge, pause, switch agent, or notify the user

15. Loop continues
```
The conductor replaces the blind copy-paste loop.
The coding agent replaces the blind approval loop.
GPT replaces the manual “what next” loop.
11. Parallel project model
Each project gets its own loop.
Example.
```text
Hermes
uses Claude Code

Kioku
uses OpenAI Codex

Alfred
uses Cursor Agent

Mimir
uses OpenCode + GLM-5.2

Long migration
uses Devin

Factory lane
uses Factory Droid
```
All projects can run at the same time.
Each project must have.
```text
Separate folder
Separate branch
Separate container
Separate logs
Separate state file
Separate assigned agent
Separate merge status
```
The conductor can run multiple loops at once.
Example.
```text
Hermes loop
GPT brain + Claude Code

Kioku loop
GPT brain + OpenAI Codex

Alfred loop
GPT brain + Cursor Agent

Mimir loop
GPT brain + OpenCode + GLM-5.2

Long migration loop
GPT brain + Devin

Factory lane loop
GPT brain + Factory Droid
```
Each loop is independent.
No coding agent should work on the same branch as another coding agent unless GPT explicitly plans that coordination.
12. Approval model
The user normally approves everything blindly.
The automation should replace this by auto-approval inside containers.
Correct rule.
```text
Auto-approve everything inside the isolated container.
```
Incorrect rule.
```text
Auto-approve everything on the real PC or VPS.
```
Safe auto-approval is allowed only when.
```text
The project is isolated
The agent cannot touch unrelated folders
The agent cannot access secrets by default
The agent cannot deploy production systems by default
The agent cannot spend money
The agent cannot access private accounts unless explicitly allowed
The agent is working inside a container or equivalent sandbox
The mounted folder is the intended project folder
The agent has no broad access to personal files
```
The goal is to remove all normal permission clicking.
The user should not have to sit at the PC.
The coding agent should be configured to continue automatically inside the safe work area.
13. Testing model
The coding agent runs the tests.
The conductor does not need to be the main tester in version 1.
Every coding prompt should instruct the agent to.
```text
Run relevant tests
Run build if applicable
Run lint if applicable
Run typecheck if applicable
Fix failures
Report exact commands run
Report exact results
Report any tests that could not be run
```
Later, the conductor can add a second verification layer.
Version 1 can rely on the coding agent’s report.
However, the phase is not complete unless the coding agent reports that the required tests passed after all implementation and repair fixes.
14. Phase completion and merge model
For every phase, the process is fixed.
```text
1. GPT reads PLAN.md, BUILDING_REFERENCE.md, BUILD_LOG.md, STATE.json, and the latest coding-agent report

2. GPT writes the next coding-agent prompt

3. The coding agent implements the phase inside the project container

4. The coding agent runs the planned tests from PLAN.md

5. If tests fail, the coding agent fixes the failures until the required tests pass or it reports a blocker

6. The coding agent opens or updates the PR

7. If tests pass, GPT gives merge approval

8. The coding agent performs the merge

9. The coding agent updates BUILD_LOG.md and STATE.json

10. GPT starts the next phase or next task
```
The user does not merge manually.
The conductor does not decide whether to merge.
The conductor does not normally perform the merge.
The conductor only relays GPT’s merge approval and records the result.
The coding agent performs the merge after GPT approval.
A phase is complete only when all of the following are true.
```text
The implementation matches PLAN.md
The planned tests pass
The coding agent reruns tests after fixes
GPT gives explicit merge approval
The coding agent merges
BUILD_LOG.md and STATE.json are updated
The next phase is started only after the merge
```
15. Merge authority
Merge authority is split clearly.
```text
GPT decides whether merge is allowed.
Coding agent performs the merge.
Conductor relays messages and records state.
User does not merge manually.
```
The coding agent should not merge before GPT gives explicit merge approval.
GPT should not approve merge unless the phase gates are satisfied.
The conductor should not independently decide that a merge is safe.
16. When the user is contacted
The user should only be contacted for real manual blockers.
Examples.
```text
Login required
Captcha required
Payment required
Subscription decision required
API key must be created manually
VPS root access required
Production deployment approval needed
Architecture decision cannot be resolved from PLAN.md
Agent failed several repair loops
Repository is corrupted
Merge conflict cannot be resolved confidently
Provider usage limit blocks all progress
External website needs human interaction
Manual file upload or download is required
```
The notification should be short and precise.
Example.
```text
Project
Kioku

Status
Blocked

Reason
Needs GitHub token with repo access

Manual action
Create token and paste it into the local .env file

After done
Reply resume Kioku
```
The notification should not ask the user to inspect normal coding details.
It should only request the specific real-world action needed.
17. Notifications
Use Telegram first.
Possible notification types.
```text
Phase completed
Project blocked
Manual action needed
Agent switched
Usage limit reached
Usage limit reset
Merge completed
Tests failed repeatedly
PR ready
Container failed
Agent failed
Project paused
Project resumed
```
Example.
```text
Kioku
Phase 2 completed and merged.
Phase 3 started.
No action needed.
```
Example.
```text
Hermes
Blocked.
Manual action needed.
Create API key and add it to .env.
```
18. Usage-limit handling
The conductor tracks each agent separately.
Example.
```text
Claude near usage limit
Pause Claude projects

Codex still available
Continue OpenAI Codex projects

OpenCode still available
Continue OpenCode + GLM-5.2 projects

Cursor Agent still available
Continue Cursor Agent projects

Devin still available
Continue Devin projects

Factory Droid still available
Continue Factory Droid projects

All builder agents limited
Only summarize logs and prepare next prompts
```
The system must not attempt to bypass usage limits.
It only pauses and resumes intelligently.
The conductor should detect usage-limit messages dynamically where possible.
The conductor should avoid starting new tasks on an agent close to its limit.
The conductor should continue other projects with other agents when available.
19. Agent assignment strategy
Use the six intended builder lanes for different project types.
Claude Code
Use for.
```text
Complex architecture
Deep debugging
Refactors
Backend logic
Hard repo reasoning
Sensitive repo-wide changes
```
OpenAI Codex
Use for.
```text
Parallel coding tasks
GitHub-connected work
PR-style implementation
Bug fixes
Test repair
Cloud tasks
Isolated feature branches
```
Cursor Agent
Use for.
```text
Hands-on IDE work
Fast UI iteration
Manual supervised edits
Autocomplete-heavy development
Editor-native refactors
```
OpenCode + GLM-5.2
Use for.
```text
Extra local or container workers
Small features
Simple implementation tasks
Config work
Tooling
Repo chores
Cost-sensitive coding tasks
```
Devin
Use for.
```text
Larger independent engineering tasks
Multi-repo chores
Migrations
Autonomous project execution
Longer-running build work
```
Factory Droid
Use for.
```text
Additional parallel agent lanes
Headless or CI-friendly automation
Structured artifact-producing tasks
Factory Missions
Agent-readiness and review workflows
Policy-controlled execution
```
Other agents such as Sourcegraph Amp, GitHub Copilot coding agent, Jules, Kiro, Junie, v0, Bolt, Replit Agent, Cline, and Aider are examples only.
They are not part of the intended initial Hephaestus builder-agent stack.
Use them later only if GPT explicitly promotes an additional lane.
Example later-only uses.
```text
UI prototypes
Dashboards
Landing pages
React components
Design exploration
Fast frontend drafts
Small MVPs
Quick web apps
Standalone prototypes
Hosted experiments
```
20. Brain model strategy
The automated brain should use the strongest GPT reasoning model available through a proper programmatic interface.
The goal is to make the automated GPT brain behave like the manual ChatGPT brain in the user’s current process.
The automated system should not rely on fragile browser automation of ChatGPT chats.
Preferred direction.
```text
Use GPT through API or an equivalent official programmatic interface.
Use separate project state files for each project.
Use GPT as the brain for each project loop.
```
The user can still use ChatGPT manually for planning, high-level strategy, and improving PLAN.md.
The automated loop should use a programmatic GPT brain for execution.
21. Security and isolation rules
The system should automate approvals only inside safe boundaries.
Important rules.
```text
No broad access to the whole PC
No broad access to the VPS root environment
No secrets available by default
No production deploy by default
No payment actions
No force push unless explicitly allowed by project rules
No deletion outside the mounted project folder
No access to unrelated project folders
No public GitHub comment should trigger privileged actions directly
No agent should merge without GPT approval
No phase should continue without passing its gates
```
The point is not to make the system passive and dangerous.
The point is to replace blind human approval with a controlled isolated environment.
22. First version
Version 1 should be simple.
No complex website first.
Build a terminal conductor.
Commands.
```text
conductor start Kioku codex
conductor start Hermes claude
conductor start Alfred opencode
conductor status
conductor pause Kioku
conductor resume Kioku
conductor stop Kioku
```
Version 1 responsibilities.
```text
Read project files
Ask GPT for next prompt
Save prompt
Start the coding agent inside the project container with auto-approval enabled inside that container
Save agent output
Send output back to GPT
Update logs
Send notification if blocked
Pause when usage limit is reached
Resume when possible
Relay GPT merge approval to the coding agent
Record merge result
```
Version 1 does not need a fancy dashboard.
Version 1 should prove the loop works.
23. Later version
Version 2 can add a dashboard.
Dashboard shows.
```text
Project name
Assigned agent
Current phase
Current task
Status
Last result
Blocked or not
Manual action needed
Last merge
Latest tests
Usage state
Container status
```
Example.
```text
Hermes
Claude Code
Phase 3
Running
Fixing tests

Kioku
OpenAI Codex
Phase 2
Merged
Starting Phase 3

Alfred
Cursor Agent
Blocked
Needs VPS manual action

Mimir
OpenCode + GLM-5.2
Running
Fixing tests
```
The dashboard should not be required for the first working version.
It should only make supervision easier later.
24. Final mental model
The final system is.
```text
Henri
architect and owner

GPT
chief engineer and brain

Build Conductor
messenger and controller

Coding agents
workers

Containers
safe workrooms

Tests
quality gate

GitHub
paper trail

Telegram
alarm system
```
The user creates the direction.
GPT decides the execution.
Coding agents act.
Containers isolate.
The conductor keeps everything moving.
25. Main principle
The system should automate everything that is currently only blind copy paste.
It should not automate the parts where the user actually thinks.
The user keeps ownership of ideas, plans, and major direction.
The system handles execution.
The system should remove the need for the user to sit in front of the PC.
The system should be able to run overnight.
The system should only interrupt the user for true manual blockers.
26. Final target
The final target is a personal AI software factory that can run multiple projects at once.
It should allow this.
```text
The user creates PLAN.md for each project.

The conductor starts one automated build loop per project.

GPT acts as brain for each loop.

Each coding agent builds inside an isolated container.

Auto-approval is enabled inside that container.

The coding agent runs tests.

The coding agent reports results.

GPT decides the next step.

The coding agent applies GPT’s repair instructions when needed.

The coding agent reruns tests.

GPT approves the merge when gates pass.

The coding agent performs the merge.

The user does not merge manually.

The next phase starts only after the previous phase has passed tests, repair, retesting, GPT approval, and coding-agent merge.

The user is notified only for real manual actions.
```
This is the system to build.
27. Hephaestus build phases
This section defines how to build this system itself.
The earlier sections describe the target system.
This section turns the target system into a one-piece-at-a-time implementation roadmap.
The system name used during implementation can be this.
```text
Hephaestus
```
Meaning.
```text
Hephaestus is the personal AI build factory.
Build Conductor is the internal conductor component inside Hephaestus.
```
The distinction is this.
```text
Hephaestus
The whole system.

Build Conductor
The orchestration component that moves messages, state, logs, containers, agents, and notifications.
```
The plan must be built in phases.
One phase should build one usable layer.
No phase should start until the previous phase has passed its completion gate.
No phase should depend on vague agent confidence.
Each phase must prove something concrete.
Each phase must leave the repository in a cleaner, safer, more testable state than before.
Each phase should be small enough that a coding agent can implement it without trying to build the whole system at once.
Each phase must have.
```text
Purpose
What to build
What not to build yet
Required tests
Completion gate
Stop conditions
```
The purpose of this roadmap is to prevent the coding agent from building a large, fragile automation system in one uncontrolled pass.
The coding agent must not skip ahead.
The coding agent must not silently build later-phase features early unless GPT explicitly approves the change.
The coding agent must not mark a phase complete only because code was written.
The coding agent must mark a phase complete only when the required tests, safety checks, and completion gate pass.
Phase 0: Repository and safety skeleton
Purpose.
```text
Create the initial repository, file structure, configuration system, and safety boundaries.
```
What to build.
```text
CLI skeleton
Project registry file
Logging folder structure
Basic config loader
Basic STATE.json schema
Basic project file schema
Example project fixture
Allowed root directory setting
Safe path resolver
Basic error handling
Basic test harness
```
What not to build yet.
```text
No GPT calls
No coding-agent control
No GitHub merging
No Telegram
No parallel projects
No real autonomous loop
```
Required tests.
```text
Unit test config loading
Unit test STATE.json validation
Unit test project registry validation
Unit test project folder detection
Unit test safe path resolution
Unit test refusal when required files are missing
Unit test refusal when project path is outside the allowed root
Unit test refusal when path traversal is attempted
Unit test log directory creation
Unit test CLI help command
```
Completion gate.
```text
The CLI runs.
The repository has a clean initial structure.
The test suite runs.
Invalid config fails safely.
Missing project files fail safely.
No command can touch paths outside the allowed project root.
No real agent or GPT execution exists yet.
```
Stop conditions.
```text
Stop if the project can access arbitrary host paths.
Stop if invalid config is accepted silently.
Stop if the CLI can continue without required project files.
Stop if tests cannot run locally.
```
Phase 1: Project state reader
Purpose.
```text
Make Hephaestus correctly read one project’s files and produce a normalized project state.
```
What to build.
```text
Read PLAN.md
Read BUILDING_REFERENCE.md
Read BUILD_LOG.md
Read STATE.json
Read CURRENT_TASK.md
Read AGENT_OUTPUT.md if it exists
Detect missing required files
Detect malformed STATE.json
Create normalized in-memory project-state object
Create read-only inspect command
Save inspection report to out/summaries if requested
```
What not to build yet.
```text
No GPT calls
No agent execution
No file mutation during inspection
No container execution
No PR workflow
```
Required tests.
```text
Reads a valid project fixture
Fails safely on missing PLAN.md
Fails safely on missing STATE.json
Fails safely on invalid STATE.json
Fails safely on missing CURRENT_TASK.md when a task is required
Preserves exact project path
Preserves exact current phase
Preserves exact current task
Does not modify files during read-only inspection
Produces deterministic normalized state for the same fixture
```
Completion gate.
```text
One project can be inspected reliably.
The conductor can tell what phase and task the project is in.
The conductor can detect missing or invalid project state.
No agent execution exists yet.
```
Stop conditions.
```text
Stop if inspection modifies project files.
Stop if malformed state is accepted.
Stop if missing required files are ignored.
Stop if the state reader guesses instead of reporting uncertainty.
```
Phase 2: Prompt generation loop with mocked agent output
Purpose.
```text
Prove the GPT brain loop before connecting real coding agents.
```
What to build.
```text
Create a brain request object from project state
Send project state to GPT or a mocked GPT provider
Receive next-action decision
Receive coding-agent prompt
Save generated prompt to out/prompts
Save GPT decision to STATE.json
Load mocked agent output fixture
Save mocked agent output to AGENT_OUTPUT.md
Append loop event to BUILD_LOG.md
```
What not to build yet.
```text
No real coding-agent process
No real terminal command execution
No container runner
No GitHub merge
No Telegram notification unless needed for fatal failure
```
Required tests.
```text
Prompt file is created
Prompt includes project goal
Prompt includes current phase
Prompt includes current task
Prompt includes allowed files
Prompt includes required tests
Prompt includes stop conditions
STATE.json updates correctly after GPT decision
Empty GPT response is rejected
Malformed GPT decision is rejected
GPT/API failure becomes blocked or retryable state
Mock agent output is saved correctly
BUILD_LOG.md receives append-only entry
No real terminal command is executed
```
Completion gate.
```text
Hephaestus can perform one full brain cycle using mocked agent output.
The loop can produce the next coding-agent prompt.
The loop can record GPT’s decision.
The loop can update logs and state without running real code.
```
Stop conditions.
```text
Stop if GPT output can directly mutate files without validation.
Stop if empty or malformed decisions are accepted.
Stop if prompts omit tests or stop conditions.
Stop if BUILD_LOG.md is overwritten instead of appended.
```
Phase 3: Local command runner inside sandbox
Purpose.
```text
Run controlled commands inside an isolated container and capture exact results.
```
What to build.
```text
Container startup command
Project folder mount
Command allowlist
Command timeout
Stdout capture
Stderr capture
Exit-code capture
Command report file
Container health check
Safe environment variable handling
Container cleanup command
```
What not to build yet.
```text
No real coding-agent automation
No GPT-controlled shell
No merge logic
No parallel projects
```
Required tests.
```text
Container starts
Mounted project path exists inside container
Allowed command runs
Forbidden command is rejected
Command stdout is captured
Command stderr is captured
Command exit code is captured
Failed command is recorded as failed
Timeout kills long-running command
Path escape attempt fails
Command cannot access unrelated host folders
Command report is saved
Container cleanup works
```
Completion gate.
```text
Hephaestus can run allowlisted commands inside a container.
Hephaestus can capture exact command evidence.
Hephaestus refuses unsafe commands.
Hephaestus cannot touch unrelated host folders.
```
Stop conditions.
```text
Stop if commands can run on the host instead of the container.
Stop if arbitrary host paths are visible.
Stop if forbidden commands are accepted.
Stop if command failures are not recorded.
Stop if timeouts do not work.
```
Phase 4: Single-agent execution loop
Purpose.
```text
Connect one coding agent to one project and run one task inside the safe work area.
```
What to build.
```text
Agent adapter interface
One real agent adapter
Agent startup command
Prompt delivery to agent
Agent output capture
Agent exit-status capture
AGENT_OUTPUT.md update
BUILD_LOG.md update
STATE.json update
Basic retry state
Basic blocked state
Basic usage-limit pause state
```
What not to build yet.
```text
No multi-project execution
No merge automation
No advanced dashboard
No automatic phase advancement unless explicitly gated
```
Required tests.
```text
Agent adapter receives prompt
Agent output is captured
Agent output is saved to AGENT_OUTPUT.md
Empty agent output becomes blocked state
Agent crash becomes blocked state
Usage-limit text becomes paused state
BUILD_LOG.md receives append-only entry
STATE.json reflects running state
STATE.json reflects completed state
STATE.json reflects failed state
STATE.json reflects paused state
Retry count increments correctly
The same task is not duplicated accidentally
```
Completion gate.
```text
One project can run one coding-agent task safely.
The task result is captured.
The state file reflects what happened.
The log file records what happened.
The system can stop cleanly when blocked or paused.
```
Stop conditions.
```text
Stop if agent output is lost.
Stop if agent crash is treated as success.
Stop if usage-limit states are ignored.
Stop if retries loop infinitely.
Stop if the agent can operate outside the intended project container.
```
Phase 5: Test-result verification
Purpose.
```text
Stop relying on vague agent claims and require structured test evidence.
```
What to build.
```text
Test-command declaration per task
Test report schema
Test evidence parser
Required command list
Pass/fail detector
Missing-test detector
Post-fix retest requirement
Test report storage in out/test_reports
Phase-completion blocker when tests are missing
```
What not to build yet.
```text
No merge automation
No multi-agent parallel execution
No dashboard
```
Required tests.
```text
Passing test report is accepted
Failing test report is rejected
Missing test report is rejected
Missing required command is rejected
“Tests passed” without command evidence is rejected
Test command without exit code is rejected
Test command without output is rejected when output is required
Post-fix retest is required after changes
Phase completion is blocked when required tests were not run
Phase completion is blocked when tests failed
```
Completion gate.
```text
A task cannot be marked done unless required test evidence exists.
A phase cannot be marked complete unless required tests passed.
The system can distinguish real test evidence from vague agent wording.
```
Stop conditions.
```text
Stop if vague natural-language claims count as test success.
Stop if failed tests can pass the gate.
Stop if a fix can be accepted without rerunning tests.
Stop if missing test commands are ignored.
```
Phase 6: Git branch and PR workflow
Purpose.
```text
Let a coding agent work on a controlled branch and open or update a PR without allowing uncontrolled merge.
```
What to build.
```text
Branch creation
Branch naming rules
Dirty-tree detection
Commit creation
Commit metadata capture
PR creation
PR update
PR URL storage
PR status storage
Merge-block flag
Force-push protection by default
```
What not to build yet.
```text
No automatic merge
No multi-project orchestration
No production deployment
```
Required tests.
```text
Branch is created correctly
Branch name includes project and task identity
Dirty tree is detected before branch switch
Dirty tree is detected before merge attempt
Commit is created only when files changed
Empty commit is rejected unless explicitly allowed
Commit metadata is saved
PR URL is saved
PR status is saved
Merge is impossible without GPT approval
Force push is disabled by default
```
Completion gate.
```text
Hephaestus can create or update a PR for one completed task.
The PR is traceable in STATE.json and BUILD_LOG.md.
No merge can happen yet without later merge-gate logic.
```
Stop conditions.
```text
Stop if merge can happen without approval.
Stop if branch state is unclear.
Stop if dirty-tree state is ignored.
Stop if PR metadata is not recorded.
Stop if force push is enabled by default.
```
Phase 7: Merge gate
Purpose.
```text
Allow merge only after implementation, tests, retests, and GPT approval are all satisfied.
```
What to build.
```text
Merge-readiness checker
Implementation status checker
Required-test checker
GPT approval checker
Dirty-tree checker
Branch-status checker
Merge command relay
Merge result capture
Post-merge BUILD_LOG.md update
Post-merge STATE.json update
Next-phase start condition
```
What not to build yet.
```text
No deployment automation
No automatic production release
No multi-project dependency coordination
No dashboard requirement
```
Required tests.
```text
Merge blocked without test evidence
Merge blocked with failed tests
Merge blocked with missing retest after fixes
Merge blocked without explicit GPT approval
Merge blocked on dirty tree
Merge blocked on wrong branch
Merge blocked if PR metadata is missing
Merge allowed only when all gates pass
Merge result is recorded
BUILD_LOG.md is updated after merge
STATE.json is updated after merge
Next phase starts only after merge
```
Completion gate.
```text
Hephaestus can complete one full phase correctly.
A phase cannot be merged by accident.
A phase cannot be marked complete without passing all gates.
The next phase cannot start before merge completion is recorded.
```
Stop conditions.
```text
Stop if merge can happen without GPT approval.
Stop if failed or missing tests do not block merge.
Stop if next phase can begin before merge is recorded.
```
Phase 8: Telegram notifications
Purpose.
```text
Notify the user only for true blockers, important milestones, and required manual actions.
```
What to build.
```text
Telegram bot configuration
Notification templates
Manual-blocker notification
Phase-complete notification
Merge-complete notification
Usage-limit notification
Agent-failure notification
Container-failure notification
Notification deduplication
Secret redaction
Notification failure handling
```
What not to build yet.
```text
No dashboard dependency
No noisy detailed logs in Telegram
No full chat interface unless explicitly planned later
No sensitive secret transmission
```
Required tests.
```text
Sends manual-blocker notification
Sends phase-complete notification
Sends merge-complete notification
Sends usage-limit notification
Does not send normal internal logs
Does not spam duplicate notifications
Redacts secrets
Handles Telegram failure gracefully
Records notification result in BUILD_LOG.md or notification log
```
Completion gate.
```text
The user can leave Hephaestus running and be notified only when action is needed or a major milestone happens.
Normal coding details stay in logs, not Telegram spam.
```
Stop conditions.
```text
Stop if secrets can be sent to Telegram.
Stop if every log line creates a notification.
Stop if notification failure crashes the project loop.
Stop if blockers are not surfaced to the user.
```
Phase 9: Multi-project parallel loops
Purpose.
```text
Run multiple independent projects safely without state contamination.
```
What to build.
```text
Project registry
One loop per project
One container per project
One assigned agent per project
Independent logs per project
Independent state files per project
Independent prompt directories per project
Independent test reports per project
Project-level pause
Project-level resume
Project-level stop
Global status command
```
What not to build yet.
```text
No shared branch between agents unless explicitly planned
No cross-project file access
No automatic dependency coordination between projects unless explicitly planned
No dashboard requirement
```
Required tests.
```text
Two projects run independently
One blocked project does not stop another project
One paused project does not stop another project
Agent usage limit pauses only affected projects
Logs never mix between projects
STATE.json files never cross-write
Prompt files never cross-write
Containers remain isolated
Project A cannot access Project B files
Global status shows each project separately
```
Completion gate.
```text
Hephaestus can run multiple projects at once.
Each project has isolated state, logs, prompts, test reports, container, and agent assignment.
A failure in one project does not corrupt or stop the others.
```
Stop conditions.
```text
Stop if logs mix between projects.
Stop if state files cross-write.
Stop if one project can access another project’s files.
Stop if one usage limit pauses unrelated agents or unrelated projects.
```
Phase 10: Dashboard after the terminal conductor works
Purpose.
```text
Add a dashboard only after the terminal conductor has proven the core loop.
```
What to build.
```text
Read-only project status dashboard
Project list
Current phase display
Current task display
Assigned agent display
Container status display
Test status display
Merge status display
Blocked/manual action display
Latest notification display
Latest log summary display
```
What not to build yet.
```text
No dashboard-first architecture
No dashboard dependency for core automation
No editing project files from dashboard unless explicitly approved later
No complex analytics before the core loop works
```
Required tests.
```text
Dashboard reads project registry
Dashboard reads project state
Dashboard displays blocked project correctly
Dashboard displays running project correctly
Dashboard displays merged project correctly
Dashboard does not mutate state in read-only mode
Dashboard handles missing project gracefully
Dashboard does not expose secrets
```
Completion gate.
```text
The dashboard makes supervision easier but is not required for the build loop.
The terminal conductor remains the source of truth.
The dashboard can be deleted without breaking automation.
```
Stop conditions.
```text
Stop if dashboard mutates state without explicit design.
Stop if dashboard becomes required for the conductor to work.
Stop if dashboard exposes secrets.
Stop if dashboard work delays the core automation loop before it is stable.
```
28. Universal task template
Every coding-agent task should use the same basic structure.
This prevents vague prompts.
This prevents agents from doing too much.
This prevents accidental phase skipping.
Template.
```md
# Task

## Project
<project name>

## Current phase
<phase number and name>

## Objective
<one concrete objective>

## Context files to read
- PLAN.md
- BUILDING_REFERENCE.md
- BUILD_LOG.md
- STATE.json
- CURRENT_TASK.md

## Allowed changes
<files or directories the agent may change>

## Forbidden changes
<files or directories the agent must not change>

## What to build
<exact implementation requirements>

## What not to build yet
<later features that must not be implemented in this task>

## Required tests
<exact test commands or test categories>

## Required evidence
- Commands run
- Exit codes
- Relevant output
- Files changed
- Tests passed or failed
- Any tests not run and why

## Stop conditions
Stop and report blocker if:
- Required files are missing
- Required tests cannot run
- Scope is unclear
- Implementation requires secrets or credentials
- The task would require changing forbidden files
- The task would require production deployment
- The task would require spending money
- The task would require bypassing safety rules

## Completion criteria
The task is complete only if:
- The requested change is implemented
- Required tests pass
- Test evidence is reported
- BUILD_LOG.md is updated if instructed
- STATE.json is updated if instructed
- No forbidden files were changed
- No later-phase features were added without approval
```
The conductor should generate prompts in this shape whenever possible.
GPT can customize the prompt, but should not remove the required tests, evidence, forbidden changes, stop conditions, or completion criteria.
29. Universal phase gate checklist
A phase is not complete because code exists.
A phase is complete only when the gate passes.
Universal phase gate.
```text
1. The implementation matches PLAN.md.
2. The implementation respects BUILDING_REFERENCE.md.
3. The task stayed inside allowed scope.
4. No forbidden files were changed.
5. Required tests were run.
6. Required tests passed.
7. Test evidence was saved.
8. If fixes were made, tests were rerun after the fixes.
9. GPT gave explicit merge approval.
10. The coding agent merged only after GPT approval.
11. BUILD_LOG.md was updated.
12. STATE.json was updated.
13. The next phase was not started before the merge was recorded.
```
If any item fails, the phase remains incomplete.
If a gate cannot be evaluated, the phase remains incomplete.
If an agent is unsure, it must report a blocker instead of guessing.
30. Test categories required across the project
Hephaestus needs multiple kinds of tests because it is not just a normal app.
It is an automation system that can run agents, commands, containers, Git operations, and notifications.
The test categories are these.
Unit tests
Purpose.
```text
Prove that small internal functions behave correctly.
```
Examples.
```text
Config parsing
STATE.json validation
Safe path resolution
Prompt file naming
Log appending
Notification formatting
```
Integration tests
Purpose.
```text
Prove that multiple components work together.
```
Examples.
```text
Read project state and create GPT request
Receive mocked GPT decision and save prompt
Run command in container and save report
```
End-to-end tests
Purpose.
```text
Prove that a full loop works on a fixture project.
```
Examples.
```text
One project, mocked GPT, mocked agent, task completed
One project, mocked failure, blocker recorded
One project, tests fail, repair loop triggered
One project, all gates pass, merge allowed
```
Sandbox and security tests
Purpose.
```text
Prove that automation cannot damage unrelated files or escape its boundaries.
```
Examples.
```text
Path traversal rejected
Outside-root project rejected
Forbidden command rejected
Unrelated host folder inaccessible
Secrets absent by default
Production deploy command rejected unless explicitly allowed
Payment-related action rejected
```
Contract tests
Purpose.
```text
Prove that files and components keep stable formats.
```
Examples.
```text
STATE.json schema
Project registry schema
Agent output schema
Test report schema
GPT decision schema
Notification event schema
```
Regression tests
Purpose.
```text
Prove that a previously fixed failure does not come back.
```
Examples.
```text
Usage-limit state does not loop forever
BUILD_LOG.md append-only behavior remains intact
Merge gate still blocks missing tests
Project A never writes to Project B state
```
Failure-mode tests
Purpose.
```text
Prove that Hephaestus fails safely when real-world problems happen.
```
Examples.
```text
GPT API unavailable
Coding agent crashes
Container fails to start
Test command times out
GitHub unavailable
Telegram unavailable
Usage limit reached
Malformed agent output
Merge conflict occurs
```
Golden-path tests
Purpose.
```text
Prove that the normal intended workflow works from beginning to end.
```
Examples.
```text
Read project files
Ask GPT for next prompt
Run agent
Capture output
Run tests
Open PR
Get GPT approval
Merge
Update state
Start next phase
```
Golden-path tests are not enough by themselves.
Failure-mode tests are mandatory because this system will often run without the user watching.
31. Definition of done for Hephaestus phases
A phase is done only when all required conditions are true.
Definition of done.
```text
The phase objective is implemented.
The phase does not include unapproved later-phase features.
All required tests pass.
The test evidence is stored.
The safety rules still pass.
The project state is valid.
The build log is updated.
The implementation respects the architecture boundaries.
The phase can be repeated or resumed without corrupting state.
Failure cases fail safely.
A fresh clone or fresh environment can run the relevant tests.
```
A phase is not done when.
```text
The agent says it is done but did not run tests.
The agent says tests passed but gives no command evidence.
The implementation works only manually.
The implementation requires hidden local state.
The implementation skips safety checks.
The implementation changes forbidden files.
The implementation makes future phases harder.
The implementation silently catches errors and continues.
The implementation creates broad access to the host machine.
```
32. Phase transition rules
The next phase may start only when the current phase is complete.
Rules.
```text
Do not start the next phase before tests pass.
Do not start the next phase before GPT gives explicit approval.
Do not start the next phase before BUILD_LOG.md is updated.
Do not start the next phase before STATE.json is updated.
Do not start the next phase if there is an unresolved blocker.
Do not start the next phase if the repository is dirty in an unsafe way.
Do not start the next phase if the current branch or PR state is unclear.
```
If the coding agent accidentally implements part of a later phase, GPT must decide whether to keep, revert, or isolate the change.
The conductor must not make that decision alone.
33. First minimal version to actually build
The first useful version should not try to be the full software factory.
The first useful version should prove the smallest safe loop.
Minimum viable Hephaestus.
```text
One project
One container
One coding agent
One GPT brain loop
One task at a time
Prompt saved
Agent output saved
Tests required
Logs updated
State updated
Blockers reported
No automatic merge until gates exist
```
The first version should not include.
```text
No dashboard
No parallel projects
No automatic GitHub merge
No production deployment
No multi-agent scheduling
No long-term analytics
```
The reason is simple.
```text
First prove that one project can move one task forward safely.
Then prove that one full phase can pass gates.
Then prove that one project can merge safely.
Then prove that multiple projects can run independently.
Only then add dashboard and convenience features.
```
34. Hephaestus anti-failure principles
The most dangerous failure is not that Hephaestus stops.
The most dangerous failure is that Hephaestus continues when it should stop.
Therefore the system should prefer safe blockage over blind progress.
Core anti-failure rules.
```text
If state is unclear, block.
If tests are missing, block.
If merge readiness is unclear, block.
If file boundaries are unclear, block.
If required credentials are missing, block.
If an agent contradicts logs, block.
If the project path is unsafe, block.
If production impact is possible, block.
If the system would need to guess, block and ask GPT or the user depending on severity.
```
The system should not ask the user for ordinary coding decisions.
The system should ask the user only when a real manual blocker or major ownership decision exists.
Examples of things that should not go to the user.
```text
Normal test failure
Normal lint failure
Normal type error
Normal refactor decision inside the current plan
Normal prompt repair
Normal retry after agent crash
Normal usage-limit pause when another agent can continue
```
Examples of things that should go to the user.
```text
Payment needed
Login needed
Captcha needed
API key needed
Subscription decision needed
Production deployment approval needed
Architecture decision missing from PLAN.md
Conflicting project goals
Repeated failed repair loops
Possible data loss
Repository corruption
Unclear merge conflict
```
35. Hephaestus quality standard
Hephaestus should not be judged by how much code it writes.
It should be judged by whether it reliably moves projects forward without destroying state, skipping tests, or bothering the user unnecessarily.
The quality standard is this.
```text
Small phases
Explicit gates
Exact logs
Structured state
Container isolation
Command evidence
Retest evidence
Explicit GPT approval
Safe failure
Minimal user interruption
No silent guessing
No uncontrolled merge
No host-machine auto-approval
```
If a proposed feature weakens any of these standards, it should be delayed or rejected.
If a proposed shortcut makes the system look more autonomous but less verifiable, it should be rejected.
If a proposed implementation cannot be tested, it should be redesigned until it can be tested.
36. Final build order summary
The build order is this.
```text
0. Repository and safety skeleton
1. Project state reader
2. Prompt generation loop with mocked agent output
3. Local command runner inside sandbox
4. Single-agent execution loop
5. Test-result verification
6. Git branch and PR workflow
7. Merge gate
8. Telegram notifications
9. Multi-project parallel loops
10. Dashboard after the terminal conductor works
```
Each step must be useful by itself.
Each step must be tested before the next step starts.
Each step must reduce uncertainty.
Each step must preserve the separation of roles.
```text
GPT decides.
Build Conductor controls movement and state.
Coding agents execute.
Containers isolate.
Tests verify.
Telegram alerts.
Henri owns the direction.
```
