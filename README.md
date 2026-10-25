# Herdr Team Workflows

A pixel-art agent office backed by an opt-in, evidence-oriented team workflow.
Configure your team, inspect the actual plan, approve its exact revision, and
follow implementation and independent review in visible Herdr agent sessions.

The Office is the interface. The workflow state and its evidence are the source
of truth. This is an executable MVP, not an alternative IDE or an agent sandbox.

## Requirements

- macOS for the Herdr plugin and native browser launcher.
- Python 3.11+, Git, and Herdr 0.9.5+.
- For real execution: Devin CLI and **Herdr Workflows (HWF) 0.15.1+**, installed
  explicitly and available to the server. HWF installation:
  <https://github.com/aorumbayev/herdr-workflows>.
- Node 22+ and Chrome are needed for development checks, not for serving the UI.

There are no third-party Python or JavaScript runtime packages to install.

## Run locally

From a terminal inside the Herdr workspace you want to use:

```sh
python3 server.py --port 8427 --open
```

Use `--port 0` to choose a free loopback port. If HWF is not on PATH:

```sh
python3 server.py --hwf /absolute/path/to/hwf --port 0 --open
```

The server prints its URL and private state directory. Without HWF, the demo,
team editor, workflow editor, and read-only workspace observation remain usable.
The server never installs HWF, changes agent permission settings, or modifies
your existing harness.

Verification commands inherit the server's PATH and environment. Select the
repository's required toolchain before launching the server, or use absolute
executable paths in verification argument arrays.

## Install as a Herdr plugin

```sh
herdr plugin install KaioAntonio/herdr-team-workflow
herdr plugin pane open --plugin herdr-team-workflow --entrypoint office --placement tab
```

For a local checkout, use `herdr plugin link /absolute/path/to/herdr-team-workflow`
instead of installation. Linking is user-global; do it deliberately.
The plugin opens a visible server pane and a browser tab in Herdr. Closing the
server does not cancel HWF runs or stop agent panes.

## First real workflow

1. In **Team**, edit responsibilities, context, and expected deliverables.
2. In **Workflow**, retain the three-stage Planning → Implementation → Review
   template. Plan approval is mandatory; implementation-to-review is automatic.
   Review may require final human acceptance. Extra stages remain demo-only.
3. In **Execution**, choose a **clean Git repository with a committed baseline**.
   Provide one bounded task and explicit verification argument arrays, for example
   `[["npm", "test"]]` or `[["python3", "-m", "unittest"]]`.
4. Read the consent statement and start planning. The source working tree is not
   stashed or reset. Work happens in a new detached Git worktree.
5. Inspect the planner's actual response. Editing the plan creates a new revision.
   Approval must match its revision, hash, and source fingerprint.
6. After approval, a fresh Devin worker implements. The service runs `git diff
   --check` and your verification commands itself; agent claims cannot override
   failed checks.
7. A fresh independent reviewer inspects the verified tree. A request for changes
   returns to implementation, up to three times. A configured final checkpoint
   also requires your acceptance.
8. Use **View in Office** to see confirmed session states. Clicking a workflow
   character opens the run's decisions and evidence.

**Head is the deterministic coordinator service**, not a fourth LLM agent.
Workers use your normal Devin defaults. Model and permission inheritance from
another interactive session is not promised.

## Safety and recovery boundaries

- Agent instructions are **not** a security boundary. Agents retain your normal
  account permissions. Use trusted repositories and review verification commands.
- The service itself never commits, pushes, merges, opens PRs, closes agent panes,
  or deletes worktrees. Its instructions prohibit those actions for workers, but
  they are not OS-enforced sandbox restrictions.
- State is private and outside the checkout, under the plugin state directory or
  `$XDG_STATE_HOME/herdr-team-workflow` (default `~/.local/state`). Workspaces are
  isolated. Use `--state-dir` only with a dedicated private directory.
- Browser state holds the editable team and demo. Real execution state persists
  on disk and snapshots the team at the start of the run.
- Only one coordinator owns a state directory. Reloading the UI does not rerun
  work. Restarting reconciles confirmed HWF run IDs.
- An uncertain launch, interrupted verification, malformed delivery, or changed
  worktree requires operator attention. **No blind automatic retry.** Inspect
  `hwf runs get <recorded-id> --json` and the owned panes.
- Archive only terminal, reconciled work. Archiving preserves worktrees,
  artifacts and panes; it does not stop agents. A launch without a known HWF ID
  deliberately cannot be archived from the UI.
- HWF can keep running after the server exits. Preserve the state directory.
  There is no automatic orphan recovery, retention cleanup, or pane termination.
- Evidence fingerprints cover HEAD, tracked diffs, and non-ignored untracked
  files, including executable modes and symlinks. Ignored build/dependency files
  are excluded. This is change detection, not a filesystem sandbox.
- Verification has a 10-minute deadline per command and bounded output; the UI
  shows output tails and actual exit codes, not inferred test counts.
- Human approvals are local operator actions, not authenticated multi-user
  signatures. The server binds only to loopback and rejects cross-origin writes
  using exact-origin checks and a per-server mutation token.

## Development and verification

```sh
npm test
```

With the server running and Chrome installed:

```sh
OFFICE_URL=http://127.0.0.1:8427 npm run test:browser
```

Set `CHROME_BIN` if Chrome is elsewhere. An optional real-HWF contract test uses
only local fixture commands, never paid agents:

```sh
HWF_TEST_BIN=/absolute/path/to/hwf python3 -m unittest test_hwf_contract.py
```

The normal suite exercises workflow execution with a fake runner and real
temporary Git repositories. That is not an end-to-end test of paid Devin agents.
Do not mistake passing fixtures for a live-agent qualification.

## Related projects

- [Herdr Workflows](https://github.com/aorumbayev/herdr-workflows) executes phases;
  it is an external dependency, not bundled code.
- [Herdr World](https://github.com/IvoryHeart/herdr-world) provides broader visual
  agent management, IDE surfaces, and its own optional HWF delivery recipe.
- [Herdr Agent Office](https://github.com/suisya-systems/herdr-agent-office)
  visualizes agent status as a pixel-art office.

This project focuses on usable team workflows, exact plan approvals, and
inspectable pre-PR evidence rather than reproducing those products.
