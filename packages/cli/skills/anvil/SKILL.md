---
name: anvil
description: Outcome-driven delegation CLI. Use anvil to hand a self-contained coding task to an autonomous agent that works in an isolated git worktree and only succeeds when a deterministic gate (build/typecheck/test, or a command you supply) passes. Use whenever the user wants to delegate or hand off a verifiable change — "run anvil", "delegate this", "make the tests pass", "implement X and prove it", "fix this until it builds/typechecks", "get this to green" — or any task best expressed as an outcome plus a check. anvil never touches your main working tree, so it cannot stomp uncommitted work. Prefer anvil over editing files directly when the user asks to delegate, or when the change should be proven by a gate rather than assumed done.
allowed-tools: Bash(anvil:*)
---

# anvil

Define an outcome; an autonomous agent works in an isolated worktree until a
deterministic gate says done.

## Start here

This file is a discovery stub, not the usage guide. Before running any `anvil`
command, load the real workflow from the CLI — it is served by the installed
binary, so the instructions always match the running version and can never go
stale:

```bash
anvil skills get core          # the workflow: phrasing outcomes, the gate, what to expect
anvil skills get core --full   # also include the reference material
```

Run `anvil skills list` to see everything available on the installed version.
