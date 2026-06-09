// @anvil/core/node — node-bound implementations of the engine seams.
//
// Everything under src/node/ may import node builtins and pi's "./node" entry.
// The pure engine (src/index.ts and its import closure) must never import from
// here — enforced by test/boundary.test.ts.
//
// Seam mapping (see docs/design.md):
//   WorktreeWorkspace -> a pi ExecutionEnv (NodeExecutionEnv) on a git worktree
//   CommandGate       -> detected build/test commands run via Workspace.exec
//   PiAgent           -> pi-agent-core AgentHarness.prompt()  (next: still A3)

export * from "../index.ts";
export {
	CommandGate,
	type CommandGateOptions,
	detectNodeTs,
	detectPackageManager,
	type GateCommand,
	type PackageManager,
} from "./command-gate.ts";
export { WorktreeWorkspace, type WorktreeWorkspaceOptions } from "./worktree-workspace.ts";
