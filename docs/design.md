# Anvil — engine design

> The most reliable implementation of: **define outcome → agent works → deterministic gate → loop.**

Anvil is the clean extraction of forge's spine. Forge proved the thesis —
*verification, not model perfection, guarantees correctness* — but accreted a
parallel scheduler, a second workspace backend, and a legacy daemon around it.
Anvil keeps the spine and sheds the rest.

This document is the scope lock and the contract. It is written **before** the
engine, so the shape can't drift.

---

## 1. The thesis and the inversion

The whole engine is one loop:

```
define outcome  →  agent works  →  deterministic gate  →  loop on failure
```

Forge's mass lives in orchestration (~3,500 LOC across spec-batch /
forge-orchestrator / pipeline) while the gate is comparatively thin. **Anvil
inverts that.** The gate and the loop are the largest, most-tested, most
paranoid part of the system; orchestration is thin glue. The reliability of
anvil is the reliability of `runToGate` plus the trustworthiness of the gate.

## 2. Scope lock

Anvil implements exactly two of the six workflow patterns:

- **Adversarial Verification** — the gate is an independent verifier; failures
  loop back to the agent.
- **Loop Until Done** — `runToGate` iterates to a termination condition
  (gate passes, or attempt/budget cap).

**Explicitly out of the engine** (layers on top, or deferred, or rejected):

- Classify-and-act (route to specialist agents) — rejected; one general
  executor with outcome prompts.
- Fanout-and-synthesize — only as a thin scheduler over `runToGate` with a git
  join, never model synthesis.
- Generate-and-filter / Tournament — a **deferred, opt-in selection layer**
  (best-of-N + a pairwise judge), added only once gate-incompleteness is shown
  to be the dominant failure mode. Not in v1.

**Reference oracle.** Forge stays frozen on the spine and is mined for
hard-won behavior (gate/verify and worktree edge-case tests get ported, not
rediscovered). Anvil does not reproduce forge's over-extension.

## 3. The four seams

The engine is built from four injected interfaces (`packages/core/src/types.ts`).
All are runtime-agnostic; node-bound implementations live behind
`@anvil/core/node`. Tests drive the engine through fakes — no real model, git,
or filesystem.

| Seam | What | `@anvil/core/node` implementation |
|------|------|-----------------------------------|
| `Agent` | runs one complete agentic turn | `PiAgent` → pi-agent-core `AgentHarness.prompt()` |
| `Workspace` | isolation + command execution | `WorktreeWorkspace` → a pi `ExecutionEnv` on a git worktree |
| `Gate` | the **sole** authority on "done" | `CommandGate` → detected build/test cmds via `Workspace.exec` |
| `StatePersister` | one write per transition | in-memory default; SQLite under node |

## 4. The `runToGate` contract

`packages/core/src/run-to-gate.ts` is the entire engine. Its shape enforces the
reliability properties:

- `agent` / `workspace` / `gate` are **injected** → the loop is fully testable
  with fakes.
- the gate is the **sole authority** on `passed` — the agent never votes on its
  own success.
- state is persisted at **every transition** → the process can die and resume
  from the last record.
- the loop **always terminates** (attempt cap).
- each retry **climbs the escalation ladder** (monotonic strengthening) and
  feeds the gate's errors back as the next outcome.
- an **inconclusive gate** (flake / env failure) does not advance the prompt —
  it is re-verified, not treated as a fixable failure.

### State table

```
pending → running → verifying → ┬─ passed              (gate green → commit)
                                ├─ retrying → running   (gate red, attempts left)
                                └─ failed               (gate red, attempt cap hit)
```

Every edge writes a `RunRecord`. Resume = load last record, continue the loop.

## 5. Substrate: pi, not the Anthropic SDK

`@anvil/core` depends on **`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`**
(hard-pinned to `0.78.1` — the spiked version, and >2 days old so it clears the
`.npmrc` `min-release-age` supply-chain gate), nothing heavier. The decision, on
evidence from a spike:

- pi-agent-core's `ExecutionEnv` (`FileSystem & Shell`) **is** anvil's
  `Workspace` — pluggable, structured `exec()` results, and it is the *only*
  node-bound thing (the `.`/`./node` seam is already drawn there).
- `AgentHarness.prompt() → Promise<AssistantMessage>` **is** anvil's
  `Agent.dispatch()`.
- pi's `tool_call → {block, reason}` hook is a PreToolUse-equivalent, richer
  than the Anthropic SDK's.
- **provider-agnostic** (Anthropic / OpenAI / Google / Mistral / Bedrock / …)
  directly serves the cheap-base / strong-escalate thesis.

### Default inference path: the Vercel AI Gateway

anvil routes inference through the **Vercel AI Gateway** by default
(`createModelResolver()`'s logical names — `sonnet`/`opus`/`haiku`, what the
escalation ladder emits — map to `vercel-ai-gateway:anthropic/claude-*`). One
key (`AI_GATEWAY_API_KEY`) across every provider makes cross-provider escalation
trivial and gives gateway-side spend/observability/rate-limit/fallback handling
— valuable for an engine that fans out many parallel agents. Key resolution
delegates to pi-ai's own `getEnvApiKey` (every provider pi knows, plus Anthropic
OAuth-token precedence), so we don't maintain a provider->env map. Provider
neutrality is preserved by the seam: `createModelResolver({ defaultProvider:
"anthropic", aliases: {...} })` (or a custom `resolveModel`/`getApiKeyAndHeaders`)
switches to direct provider access.
- first-class faux provider + memory session repo = deterministic tests.
- `Result<T,E>`-everywhere, never-throw, abort-everywhere design aligns with
  "the most reliable engine" better than a throw-based SDK.

Costs accepted: anvil writes its own minimal `read`/`edit`/`bash` tools against
`ExecutionEnv` (desirable — anvil controls/constrains them; keeps the dep
surface to the two lean packages, not the heavier `pi-coding-agent`); cost is
computed from `Usage` + a pricing table; and the upstream is pre-1.0 / single
maintainer — mitigated by hard-pin + the MIT vendor escape hatch.

## 6. Tooling

Standard modern TS monorepo, conventions borrowed from pi, configs owned by us,
**zero dependency on pi tooling**:

- npm workspaces · Biome (lint+format) · vitest · `tsc` (Node16 ESM,
  `rewriteRelativeImportExtensions`) · `.`/`./node` package exports.
- `.npmrc`: `save-exact=true` (the load-bearing supply-chain control).
- one CI gate: `npm run check` = `biome → tsc --noEmit → build → test`.

## 7. Phases

Track A (build — the spine is settled, needs no usage data):

- **A1** — this design doc. ✔
- **A2** — `runToGate` test-first against fakes. *(walking skeleton landed; full
  matrix — stall detection, budget cap, inconclusive accounting — ongoing.)*
- **A3** — harden the gate + wire the node seams. *Done.*
  `WorktreeWorkspace` (git worktree on a pi `NodeExecutionEnv`) and `CommandGate`
  (clean-env execution via per-command `env`; flake-resistance — fail-then-pass
  is inconclusive not a hard failure, can't-run is inconclusive not failure, a
  real repeatable failure dominates; actionable per-command errors) have landed
  with tests (real-git integration for the workspace, fakes for the gate). The
  `.`/`./node` purity boundary is enforced by `test/boundary.test.ts`. `ExecResult`
  carries an `error` field so the gate can tell "ran and failed" from "could not
  run". `PiAgent` (the `Agent` seam over pi's `AgentHarness.prompt()`) has landed,
  faux-provider tested (no network/key); it is provider-agnostic via an injected
  `resolveModel` and takes injectable tools. anvil's own read/edit/write/bash
  tools (over the `ExecutionEnv`, via typebox) have landed: lean and headless
  (no TUI/highlight/image deps), with a contract that matches what coding models
  expect (batch exact-unique-match edit, head/tail truncation) cribbed from pi's
  tools but reimplemented as ours. PiAgent defaults to these, so the worker has
  hands. The whole loop is proven end-to-end in `test/run-to-gate.e2e.test.ts`
  with only the model faked: a faux response calls the real `write` tool, which
  mutates a real git worktree, which the real gate verifies via real shell exec,
  which commits on pass — including the fail-then-retry-then-pass path.
- **A4** — *next.* Build anvil's first-class CLI. anvil is forge's **successor**
  (a focused rewrite), not a library forge consumes — `anvil run` covers forge's
  `run <spec>` common case at parity, proven by ported forge tests. Model
  resolution is settled: `createModelResolver()` maps anvil's
  logical names (the aliases the ladder emits — sonnet/opus/haiku) and any
  `provider:model-id` to a concrete pi-ai Model; Anthropic-flavored defaults,
  fully overridable; PiAgent uses it by default, so a real run works given an
  `AI_GATEWAY_API_KEY` (anvil routes through the Vercel AI Gateway by default;
  see §5). Crash-resumability is also done: `MemoryStatePersister` (pure) and the
  durable `FileStatePersister` (node, atomic per-outcome JSON), with
  `runToGate({ resume: true })` returning terminal records immediately and
  continuing a non-terminal one (reused session + rebuilt retry prompt).
  Remaining A4 piece: the CLI surface itself (`packages/cli`, `@anvil/cli`:
  `anvil run`/`status`, then `resume`) over the finished engine, with parity
  proven by ported forge tests.

Track B (measure → cut, runs in parallel, gates only the deletions): query
forge's `runs` DB for sandbox / pipeline / dep-declaration / detach usage and
produce an evidence-backed kill-list.

Convergence: scheduler collapses to a loop over `runToGate`; spec generation
(define/audit/proof) stays separate content commands; the deferred 4/5
selection layer is added only on evidence.

## 8. Switchover criterion

anvil is forge's **successor** — a focused rewrite with a first-class CLI — not a
library forge consumes. Forge stays frozen as the **reference oracle**: we mine
its gate/verify and worktree edge-case tests, but nothing routes *through* it.

The engine "wins" when `anvil run <spec>` — the 80% common case forge served —
runs at behavior parity, proven by ported forge tests. The CLI is a thin surface
(`packages/cli`, `@anvil/cli`) over the finished `runToGate` engine; the engine
itself does not change to get there.

## 9. Non-goals

- A pipeline concept distinct from "stages through the engine."
- A second workspace backend until usage data demands it (and then behind the
  same narrow `Workspace` interface — zero backend leakage outside `node`).
- Owning the inner agentic tool-use loop (that is the substrate's job).
