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

Phase A2 — walking skeleton. `runToGate` + the escalation ladder are real and
tested; the node-bound implementations (`PiAgent`, `WorktreeWorkspace`,
`CommandGate`) are stubbed for phase A3.
