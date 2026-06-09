// ── Anvil engine contract ────────────────────────────────────
//
// The four seams the engine is built from. All are runtime-agnostic
// interfaces; their node-bound implementations live behind
// "@anvil/core/node". Tests drive the engine through fakes of these
// interfaces — no real model, git, or filesystem required.

/** Reasoning effort levels, weakest to strongest. Mirrors pi-ai's ThinkingLevel plus a top "max" rung. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A (model, effort) pair. The engine escalates this on each verify-fail retry. */
export interface ModelEffort {
	model: string;
	effort?: Effort;
}

// ── What: the outcome to achieve ─────────────────────────────

export interface Outcome {
	/** Stable identifier (e.g. a spec filename or task id). */
	id: string;
	/** The outcome prompt: what must be true when done, not how to do it. */
	prompt: string;
	/** Base model/effort for attempt 0. The engine climbs the escalation ladder from here. */
	base?: ModelEffort;
}

// ── Who: the agent seam ──────────────────────────────────────
// Wraps a single complete agentic turn. Under "@anvil/core/node" this is
// pi-agent-core's `AgentHarness.prompt()`.

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
}

export interface AgentDispatch {
	prompt: string;
	config: ModelEffort;
	/** Resume a prior session so loop iterations continue the same conversation. */
	resume?: string;
	signal?: AbortSignal;
}

export interface AgentResult {
	/** Final assistant text, for logging and feedback. */
	text: string;
	/** Token usage for cost accounting (priced from a model table by the caller). */
	usage?: TokenUsage;
	/** Provider/session id for resume + fork. */
	sessionId?: string;
}

export interface Agent {
	dispatch(d: AgentDispatch): Promise<AgentResult>;
}

// ── Where: the workspace seam ────────────────────────────────
// Isolation + command execution. Under "@anvil/core/node" this is a pi
// ExecutionEnv (FileSystem & Shell) pointed at a git worktree.

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ExecOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface Workspace {
	/** Absolute working directory the agent and gate operate in. */
	readonly cwd: string;
	exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
	/** Commit current changes. Returns false when there was nothing to commit. */
	commit(message: string): Promise<boolean>;
	cleanup(): Promise<void>;
}

// ── The authority: the gate seam ─────────────────────────────
// The ONLY thing that can declare an outcome "done". The agent cannot vote
// on its own success.

export interface CommandResult {
	cmd: string;
	passed: boolean;
	output: string;
	durationMs: number;
}

export interface GateResult {
	passed: boolean;
	/** Actionable error text fed back to the agent on failure. */
	errors: string;
	commands: CommandResult[];
	/**
	 * True when the gate could not produce a trustworthy verdict (flaky test,
	 * environment failure). An inconclusive gate is NOT a real failure — the
	 * engine re-verifies rather than feeding garbage back to the agent.
	 * (Full flake-resistance is an A3 gate concern; the seam exists from day one.)
	 */
	inconclusive?: boolean;
}

export interface Gate {
	verify(ws: Workspace, signal?: AbortSignal): Promise<GateResult>;
}

// ── The state machine ────────────────────────────────────────

export type RunState = "pending" | "running" | "verifying" | "retrying" | "passed" | "failed";

/** A persisted snapshot of one run. Written at every state transition for crash-resumability. */
export interface RunRecord {
	outcomeId: string;
	state: RunState;
	attempt: number;
	maxAttempts: number;
	config: ModelEffort;
	errors?: string;
	sessionId?: string;
	usage?: TokenUsage;
	updatedAt: string;
}

/** Persistence seam — every transition is written here. The default is in-memory; node provides SQLite. */
export interface StatePersister {
	save(record: RunRecord): Promise<void>;
}

/** Escalation seam — a pure function mapping (base config, attempt) to the config to dispatch. */
export type Escalator = (base: ModelEffort, attempt: number) => ModelEffort;
