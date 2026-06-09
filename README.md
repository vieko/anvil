# anvil

The most reliable implementation of:

> **define outcome → agent works → deterministic gate → loop**

Anvil is the clean extraction of [forge](../forge)'s spine. Forge proved the
thesis — *verification, not model perfection, guarantees correctness* — but
accreted a parallel scheduler, a second workspace backend, and a legacy daemon
around it. Anvil keeps the spine and sheds the rest: the gate and the loop are
the most-tested, most paranoid part of the system; orchestration is thin glue.

See **[`docs/design.md`](docs/design.md)** for the contract and scope lock.

## Layout

```
packages/core/        @anvil/core — the engine
  src/index.ts        .       pure, runtime-agnostic (runToGate, escalation, types)
  src/node.ts         ./node  node-bound seams (pi-backed Agent, worktree Workspace, gate)
docs/design.md        the engine design + scope lock
```

## Develop

```sh
npm install
npm run check     # biome -> tsc --noEmit -> build -> test
npm test          # vitest
```

## Status

Phase A3 complete — the engine runs end to end. `runToGate` drives `PiAgent`
(pi's `AgentHarness` + anvil's read/edit/write/bash tools) inside a
`WorktreeWorkspace` (git worktree), verified by `CommandGate`, with the
fail-then-retry-then-pass loop. Proven in `test/run-to-gate.e2e.test.ts` with
only the model faked. Next: A4 — route forge's `run <spec>` through the engine.
