# AGENTS.md — anvil

Guidance for AI coding agents working in this repository. Read `docs/design.md`
first; it is the contract.

## What anvil is

The clean extraction of forge's spine: **define outcome → agent works →
deterministic gate → loop.** Anvil is the reliability-first engine, not a
reimplementation of forge.

## Scope lock (do not violate without an explicit decision)

- Implement exactly two patterns: **Adversarial Verification** and **Loop Until
  Done**. Everything else is a layer on top, deferred, or rejected (see
  `docs/design.md` §2).
- **Invert the mass**: the gate and `runToGate` loop are the largest, most-tested,
  most paranoid code. Orchestration stays thin. If a change makes orchestration
  fat or the gate thin, that is the alarm.
- No second workspace backend, no pipeline-as-its-own-concept, no executor
  daemon. These are the forge over-extensions anvil exists to shed.
- Do **not** reproduce forge feature-for-feature. Forge is a **frozen reference
  oracle** (`~/dev/forge`): mine its gate/verify and worktree edge-case tests,
  port them — don't rediscover those bugs.

## Architecture invariants

- **`@anvil/core` is runtime-agnostic.** `src/index.ts` (the `.` export) imports
  no node builtins, no SDK, no git. Node-bound implementations live only in
  `src/node.ts` (the `./node` export): `PiAgent`, `WorktreeWorkspace`,
  `CommandGate`. A node import leaking into the pure entry is a boundary break.
- **The gate is the sole authority on "done."** The agent must never be able to
  declare its own success, skip, or fake the gate.
- **Persist at every state transition.** Resumability is a designed property,
  not an afterthought.
- **The seams are injected.** `Agent` / `Workspace` / `Gate` / `StatePersister`
  are interfaces; production is just another caller. New engine tests drive
  fakes of these — never a real model, git, or filesystem.

## Substrate

`@anvil/core` depends only on `@earendil-works/pi-agent-core` +
`@earendil-works/pi-ai` (hard-pinned, exact). Not `pi-coding-agent` (too heavy).
Anvil writes its own `read`/`edit`/`bash` tools against pi's `ExecutionEnv`.
pi is an upstream dependency — read it, pin it, vendor it if it breaks you; do
**not** fork it into this tree.

## Tooling & conventions

- npm workspaces · Biome (tabs, width 3, line 120) · vitest · `tsc` (Node16 ESM).
- Write `.ts` extensions in relative imports (`rewriteRelativeImportExtensions`).
- `import type` for type-only imports (`verbatimModuleSyntax`).
- Exact-pin all deps (`.npmrc save-exact=true`).
- **One gate:** `npm run check` (`biome → tsc --noEmit → build → test`). A red
  gate is a blocker. Run it before committing.
- ASCII-only output in code; no emojis.

## Git

- Stage explicit paths. Never `git add -A` / `git add .`.
- Never `git reset --hard`, `git clean -fd`, `git stash`, or force-push without
  an explicit instruction in the current turn.
