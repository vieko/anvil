# @anvil/core

The anvil engine: **define outcome → agent works → deterministic gate → loop.**

- `@anvil/core` (`.`) — the pure, runtime-agnostic engine: `runToGate`, the
  escalation ladder, and the four seam interfaces (`Agent`, `Workspace`,
  `Gate`, `StatePersister`). No node builtins, no SDK, no git.
- `@anvil/core/node` (`./node`) — node-bound implementations: `PiAgent`
  (a pi coding-agent SDK session), `WorktreeWorkspace` (anvil's exec env on a
  git worktree),
  `CommandGate`.

See [`../../docs/design.md`](../../docs/design.md) for the contract.
