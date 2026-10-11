// @anvil/core/node — node-bound implementations of the engine seams.
//
// Everything under src/node/ may import node builtins and the pi SDK.
// The pure engine (src/index.ts and its import closure) must never import from
// here — enforced by test/boundary.test.ts.
//
// Seam mapping (see docs/design.md):
//   WorktreeWorkspace -> anvil's NodeExecEnv on a git worktree
//   CommandGate       -> detected build/test commands run via Workspace.exec
//   PiAgent           -> a hermetic pi coding-agent SDK session (createAgentSession)

export * from "../index.ts";
export {
	CommandGate,
	type CommandGateOptions,
	detectNodeTs,
	detectPackageManager,
	type GateCommand,
	type PackageManager,
} from "./command-gate.ts";
export {
	type CapturedExec,
	type CapturedExecOptions,
	type ExecEnv,
	type ExecFailure,
	type ExecOutcome,
	type FileErrorCode,
	NodeExecEnv,
	type NodeExecEnvOptions,
	type OutputLimits,
} from "./exec-env.ts";
export { FileStatePersister, type FileStatePersisterOptions } from "./file-state-persister.ts";
export {
	createModelResolver,
	createSupportedEfforts,
	DEFAULT_MODEL_ALIASES,
	type ModelResolverOptions,
} from "./model-resolver.ts";
export {
	createHermeticModelRuntime,
	DEFAULT_RETRY_POLICY,
	type ModelResolver,
	PiAgent,
	type PiAgentOptions,
	type RetryPolicy,
} from "./pi-agent.ts";
export {
	type AnvilTool,
	type BashEnv,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	defaultTools,
} from "./tools.ts";
export { longCacheRetention, messageCost } from "./usage-cost.ts";
export { defaultWorktreePath, WorktreeWorkspace, type WorktreeWorkspaceOptions } from "./worktree-workspace.ts";
