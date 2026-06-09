// @anvil/core/node — node-bound implementations of the engine seams.
//
// These wrap pi-agent-core (the agent loop + ExecutionEnv) and git /
// child_process. They are built test-first in phase A3; stubbed here so the
// package boundary and the "./node" export exist from the first commit.
//
// Seam mapping (see docs/design.md):
//   PiAgent          -> pi-agent-core AgentHarness.prompt()
//   WorktreeWorkspace -> a pi ExecutionEnv (NodeExecutionEnv) on a git worktree
//   CommandGate      -> detected build/test commands run via Workspace.exec

import type {
	Agent,
	AgentDispatch,
	AgentResult,
	ExecOptions,
	ExecResult,
	Gate,
	GateResult,
	Workspace,
} from "./index.ts";

export * from "./index.ts";

const NOT_IMPL = "anvil: not implemented yet (phase A3)";

/** Wraps pi-agent-core's `AgentHarness.prompt()`. Built in A3. */
export class PiAgent implements Agent {
	dispatch(_d: AgentDispatch): Promise<AgentResult> {
		throw new Error(NOT_IMPL);
	}
}

/** A {@link Workspace} backed by a pi `ExecutionEnv` pointed at a git worktree. Built in A3. */
export class WorktreeWorkspace implements Workspace {
	readonly cwd: string = "";
	exec(_command: string, _opts?: ExecOptions): Promise<ExecResult> {
		throw new Error(NOT_IMPL);
	}
	commit(_message: string): Promise<boolean> {
		throw new Error(NOT_IMPL);
	}
	cleanup(): Promise<void> {
		throw new Error(NOT_IMPL);
	}
}

/** A {@link Gate} that runs detected build/test commands via {@link Workspace.exec}. Built in A3. */
export class CommandGate implements Gate {
	verify(_ws: Workspace, _signal?: AbortSignal): Promise<GateResult> {
		throw new Error(NOT_IMPL);
	}
}
