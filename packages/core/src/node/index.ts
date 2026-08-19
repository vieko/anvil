// @anvil/core/node — node-bound implementations of the engine seams.
//
// Everything under src/node/ may import node builtins and pi's "./node" entry.
// The pure engine (src/index.ts and its import closure) must never import from
// here — enforced by test/boundary.test.ts.
//
// Seam mapping (see docs/design.md):
//   WorktreeWorkspace -> a pi ExecutionEnv (NodeExecutionEnv) on a git worktree
//   CommandGate       -> detected build/test commands run via Workspace.exec
//   PiAgent           -> pi-agent-core AgentHarness.create() + prompt()

export * from "../index.ts";
export {
	CommandGate,
	type CommandGateOptions,
	detectNodeTs,
	detectPackageManager,
	type GateCommand,
	type PackageManager,
} from "./command-gate.ts";
export { FileStatePersister, type FileStatePersisterOptions } from "./file-state-persister.ts";
export {
	createModelResolver,
	createSupportedEfforts,
	DEFAULT_MODEL_ALIASES,
	type ModelResolverOptions,
} from "./model-resolver.ts";
export {
	createAgentHarness,
	type Harness,
	type HarnessEvents,
	type HarnessFactory,
	type ModelResolver,
	PiAgent,
	type PiAgentOptions,
} from "./pi-agent.ts";
export { createBashTool, createEditTool, createReadTool, createWriteTool, defaultTools } from "./tools.ts";
export { WorktreeWorkspace, type WorktreeWorkspaceOptions } from "./worktree-workspace.ts";
