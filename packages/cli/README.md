# @anvil/cli

anvil's first-class CLI: **define an outcome, the agent works, a deterministic
gate decides done.** A thin surface over the `@anvil/core` engine — anvil is
forge's focused successor, and this is its entry point.

```
anvil run <outcome>     Run an outcome to its gate in an isolated worktree
anvil status            List recorded runs and their state
anvil --help | --version
```

`<outcome>` is a prompt string or a path to a spec file.

```
run options:
  -C, --dir <path>        Target repository (default: current directory)
      --model <name>      Base model: alias (sonnet/opus/haiku) or provider:id
  -n, --max-attempts <n>  Attempt cap before giving up (default: 3)
      --verify <cmd>      Gate command (repeatable; overrides auto-detection)
  -q, --quiet             Print only the final verdict
```

Each run provisions an isolated git worktree on a fresh `anvil/<id>/<ts>`
branch: the agent edits it, the gate verifies it, and a pass commits there.
The worktree is left in place so you can inspect or merge the result. State is
recorded under the repo's `.anvil/runs` so `anvil status` can report it.

Inference defaults to the Vercel AI Gateway (`AI_GATEWAY_API_KEY`); see
`docs/design.md` §5.

## Layout

```
src/
  cli.ts      pure argv parser (parseArgs) -> Command
  run.ts      executeRun (injectable deps) + resolveOutcome  (unit-testable)
  status.ts   executeStatus over the .anvil/runs store
  wiring.ts   buildRunDeps — the real node seams (worktree, pi agent, gate)
  bin.ts      the `anvil` entry point
```

The orchestration (`run.ts`/`status.ts`) takes injected seams, so the suite
runs with no model, no network, and no git.

## Development

Run straight from `src/` (no build) via node's built-in type stripping — the
`source` export condition resolves `@anvil/core` to source too:

```bash
npm run dev -- run "<outcome>" -C ~/some/repo   # from the repo root
npm run dev -- status                            # any command
```

The globally-linked `anvil` bin runs the built `dist/` instead, so it reflects
changes only after `npm run build` (which `npm run check` includes).
