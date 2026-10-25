# Herdr Team Workflows

English-only local browser UI, pixel-art Office, and an opt-in executable
Planning → Implementation → Review template. Keep the demo clearly labeled.
Head is the deterministic coordinator service, not a fourth LLM session.
HWF 0.15.1+ executes fresh visible Devin workers; the service owns approvals,
private persisted run state, verification commands and evidence fingerprints.
Do not replace HWF with an unverified runner or replay ambiguous launches.

No third-party Python or JavaScript runtime dependencies. Python 3.11+,
Git and Node 22+ are required for local verification. Start inside Herdr with
`python3 server.py --port 8427`. Pass `--hwf /path/to/hwf` when necessary.
Native plugin/browser launch currently targets macOS; the server is POSIX.
The external HWF dependency is never automatically installed or updated.

Verification:

- `npm test`: model tests and all Python unit/HTTP tests.
- `npm run test:browser`: start the server first; requires Google Chrome.
  Set `OFFICE_URL` for a non-default port and `CHROME_BIN` for another Chrome path.
- `HWF_TEST_BIN=/path/to/hwf python3 -m unittest test_hwf_contract.py`:
  optional real-HWF contract test with local fixture commands, never real agents.

On machines with an incompatible default Node, select an installed Node 22+
on PATH rather than changing global configuration.

Real execution is an explicit product/security decision: require same-origin
JSON requests and a per-server mutation token, a connected workspace, a clean
source repository, and user consent for agents and exact verification argv.
Create a detached worktree; never stash/reset the source or clean up user work.
Runtime state belongs outside the checkout, with private filesystem permissions.
Only static allowlisted assets are served. Never commit run state, local paths,
terminal responses, credentials, downloaded binaries, or test artifacts.

Agent role instructions are not security sandboxes. Preserve that disclosure.
The service never commits, pushes, merges, closes panes, or deletes worktrees.
Do not start paid agents while testing without explicit user approval. Test the
state machine with a fake runner and label the boundary honestly.

Bind plan approval to revision, plan hash and source fingerprint. Execute checks
independently of agent claims; do not invent test counts. Review must correspond
to the verified tree. Changing that tree invalidates the current reviewed result.
Respect optional human acceptance after review and the three-correction limit.
On restart, reconcile confirmed HWF IDs; never blindly retry an uncertain launch.

The Office prototype predates this repository. Preserve known-default migration
from Portuguese without overwriting user-authored text or pending demo approvals.
Herdr World and Herdr Agent Office already cover broad visual agent management;
focus this project on usable workflow contracts, not duplicating their IDE.
