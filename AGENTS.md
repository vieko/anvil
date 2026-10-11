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

`@anvil/core` depends on `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, all hard-pinned to
the same exact version. pi 1.0 removed the harness layer (sessions, retries,
exec env) from `pi-agent-core` on purpose; it now lives in the coding-agent SDK
(`createAgentSession`). Rebuilding it on the bare `Agent` loop would put
sessions, retries and compaction in anvil, outside the gate, against "invert
the mass". This supersedes the earlier "not `pi-coding-agent` (too heavy)"
rule (#51); for scale, the full pi 1.1.0 install is 158 MB against anvil's
236 MB `node_modules`.

- The SDK is a `./node` dependency only. `src/index.ts` (the `.` export) stays
  free of node builtins and SDK imports; `PiAgent` lives in `src/node/`.
- `PiAgent` sessions are hermetic: no resource discovery from the host
  (extensions, skills, prompt templates, context files, `~/.pi` settings,
  credentials or MCP). Every session setting is explicit and in-memory; only
  provider keys come from the environment.
- Anvil keeps its own `read`/`edit`/`write`/`bash` tools, registered as custom
  tools with pi's built-ins off, so anvil owns their contract and output caps.
- pi is an upstream dependency: read it, pin it, vendor it if it breaks you; do
  **not** fork it into this tree.

## Tooling & conventions

- npm workspaces · Biome (tabs, width 3, line 120) · vitest · `tsc` (Node16 ESM).
- Write `.ts` extensions in relative imports (`rewriteRelativeImportExtensions`).
- `import type` for type-only imports (`verbatimModuleSyntax`).
- Exact-pin all deps (`.npmrc save-exact=true`).
- **One gate:** `npm run check` (`biome → tsc --noEmit → build → test`). A red
  gate is a blocker. Run it before committing.
- ASCII-only output in code; no emojis.

## Running anvil during development

Three modes; pick the right one:

- **Developing anvil itself** — `npm run dev -- run ...`. Executes the working
  tree directly via Node's type-stripping and the `anvil-source` export
  condition (namespaced so a third-party `source` export can never match it,
  #39). No build step, no stale dist. This is also how to drive a Golem when
  dogfooding anvil on anvil.
- **On Vieko's machines** the `anvil` on PATH is the dotfiles shim
  (`~/.scripts/anvil`), which runs this working tree the same way. Never
  `npm i -g @vieko/anvil` there: `~/.npm-global/bin` precedes `~/.scripts` in
  PATH, so a global install silently shadows the shim and pins the machine to
  a stale release.
- **Using anvil as a tool on a machine without the checkout** — install the
  published package globally: `npm i -g @vieko/anvil`. Kept current by the
  release pipeline.
- **Occasional or CI use** — `npx @vieko/anvil`. No install required.

`npm link` is discouraged for active development: the linked bin runs `dist/`
and is stale until `npm run build`. Mental model: the published `anvil` is the
product; `npm run dev` is the workbench.

## Git

- Stage explicit paths. Never `git add -A` / `git add .`.
- Never `git reset --hard`, `git clean -fd`, `git stash`, or force-push without
  an explicit instruction in the current turn.
