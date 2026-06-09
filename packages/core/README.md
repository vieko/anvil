# @anvil/core

The anvil engine: **define outcome → agent works → deterministic gate → loop.**

- `@anvil/core` (`.`) — the pure, runtime-agnostic engine: `runToGate`, the
  escalation ladder, and the four seam interfaces (`Agent`, `Workspace`,
  `Gate`, `StatePersister`). No node builtins, no SDK, no git.
- `@anvil/core/node` (`./node`) — node-bound implementations: `PiAgent`
  (pi-agent-core), `WorktreeWorkspace` (a pi `ExecutionEnv` on a git worktree),
  `CommandGate`.

See [`../../docs/design.md`](../../docs/design.md) for the contract.
