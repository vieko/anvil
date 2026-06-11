// @anvil/cli — anvil's first-class CLI surface over the @anvil/core engine.
// Programmatic entry points (the `bin` is src/bin.ts).

export { type Command, HELP, parse, type RunOptions } from "./cli.ts";
export { consoleIo, executeRun, type Io, type RunDeps, resolveOutcome } from "./run.ts";
export { executeSkills } from "./skills.ts";
export { executeStatus } from "./status.ts";
export { buildRunDeps } from "./wiring.ts";
