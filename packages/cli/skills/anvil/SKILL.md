---
name: anvil
description: Use when the user says "run anvil", "delegate this", "make the tests pass", "implement X and prove it", "fix this until it builds/typechecks", or "get this to green". Also use to hand off a self-contained coding task with a verifiable outcome. Produces a change verified by a deterministic gate in an isolated git worktree; anvil never touches your main working tree. Not for tasks without a deterministic check or interactive edits in the current working tree.
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
