// ── The anvil spine ──────────────────────────────────────────
//
//   define outcome -> agent works -> deterministic gate -> loop
//
// This is the entire engine. Everything else (scheduler, isolation policy,
// spec generation) is a thin layer that calls this. The reliability of anvil
// is the reliability of this function plus the trustworthiness of the gate.

import { escalate as defaultEscalate } from "./escalation.ts";
import type {
	Agent,
	AgentResult,
	AttemptRecord,
	Effort,
	Escalator,
	Gate,
	ModelEffort,
	Outcome,
	RunRecord,
	RunState,
	StatePersister,
	TokenUsage,
	Workspace,
} from "./types.ts";

export interface RunToGateDeps {
	agent: Agent;
	workspace: Workspace;
	gate: Gate;
	persist: StatePersister;
	/** Escalation policy. Defaults to the cheap-base, climb-on-retry ladder. */
	escalate?: Escalator;
}

export interface RunToGateOptions {
	maxAttempts?: number;
	signal?: AbortSignal;
	/**
	 * Resume a crashed/interrupted run from its last persisted record (requires
	 * `persist.load`). A terminal record (passed/failed) returns immediately; a
	 * non-terminal one continues from where it stopped, reusing the agent session
	 * and rebuilding the retry prompt. The caller must supply the same workspace.
	 */
	resume?: boolean;
	/**
	 * The OS pid of the process driving this run, persisted into every record
	 * (#41) so a reader can tell a genuinely in-flight run from an orphaned one
	 * via liveness (`kill -0`) instead of only a heartbeat age. The pure engine
	 * never reads `process.pid` itself (that would break the runtime-agnostic
	 * boundary) -- the node surface (`anvil run`) supplies its own pid here.
	 */
	pid?: number;
}

export interface RunToGateResult {
	outcomeId: string;
	passed: boolean;
	attempts: number;
	finalConfig: ModelEffort;
	errors?: string;
	/**
	 * The command strings the gate ran on its final verify -- the *provenance* of
	 * the verdict, so a caller can tell what actually proved (or failed to prove)
	 * the outcome. Absent when the gate never ran: a guard-voided run (contract
	 * violation / out-of-scope edit) or a dispatch that never reached verification.
	 */
	gateCommands?: string[];
	/** Per-attempt history for this run, oldest first (#12 Tier 3). Same array as {@link RunRecord.attempts}. */
	timeline: AttemptRecord[];
	/** Cumulative usage (tokens + cost) across the timeline; same sum as {@link RunRecord.usage}. */
	usage?: TokenUsage;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE: ModelEffort = { model: "sonnet", effort: "high" };

/**
 * The effort level applied to a base that has a model but no explicit effort.
 * Normalised at the runToGate boundary so `--model opus` (no `--effort`) always
 * dispatches at high on attempt 0 — no more thinking-off-by-accident.
 */
export const DEFAULT_EFFORT: Effort = "high";

/**
 * Run one outcome to the gate.
 *
 * Reliability properties (all enforced by this function's shape):
 *  - `agent` / `workspace` / `gate` are injected -> the loop is fully testable
 *    with fakes; no real model, git, or filesystem in unit tests.
 *  - the gate is the SOLE authority on `passed` — the agent never votes on its
 *    own success.
 *  - state is persisted at EVERY transition -> the process can die and resume
 *    from the last record.
 *  - the loop ALWAYS terminates (attempt cap).
 *  - each retry climbs the escalation ladder (monotonic strengthening) and
 *    feeds the gate's errors back as the next outcome.
 *  - an inconclusive gate (flake/env) does not advance the prompt — it is
 *    re-verified rather than treated as a fixable failure.
 *
 * A2 refinements (tracked in docs/design.md): identical-error stall detection
 * to jump ladder rungs, budget cap alongside the attempt cap, and richer
 * inconclusive-gate retry accounting.
 */
export async function runToGate(
	outcome: Outcome,
	deps: RunToGateDeps,
	options: RunToGateOptions = {},
): Promise<RunToGateResult> {
	const { agent, workspace, gate, persist } = deps;
	const escalate = deps.escalate ?? defaultEscalate;
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const rawBase: ModelEffort = outcome.base ?? DEFAULT_BASE;
	// Normalise: a base with a model but no effort gets DEFAULT_EFFORT so attempt 0
	// always reasons at a known level instead of dispatching thinking-off.
	const base: ModelEffort = rawBase.effort === undefined ? { ...rawBase, effort: DEFAULT_EFFORT } : rawBase;

	let prompt = outcome.prompt;
	let lastErrors: string | undefined;
	let sessionId: string | undefined;
	let gateCommands: string[] | undefined;
	// Per-attempt history (#12 Tier 3): one entry per dispatched attempt, appended
	// when the attempt starts and finalized (verdict + endedAt) at its terminal
	// transition. Rehydrated on resume (below) so a crash-resume keeps the prior
	// attempts instead of losing them the way the old overwriting record did.
	const attempts: AttemptRecord[] = [];

	const record = (
		state: RunState,
		attempt: number,
		config: ModelEffort,
		extra: Partial<RunRecord> = {},
	): Promise<void> =>
		persist.save({
			outcomeId: outcome.id,
			state,
			attempt,
			maxAttempts,
			config,
			sessionId,
			errors: lastErrors,
			branch: workspace.branch,
			pid: options.pid,
			updatedAt: new Date().toISOString(),
			// Cumulative across every attempt (#12): the sum of attempts[].usage, not
			// the current dispatch alone -- snapshotted fresh each write so an earlier
			// persisted record is never retroactively mutated by a later attempt.
			usage: sumUsage(attempts),
			attempts: attempts.map((a) => ({ ...a })),
			...extra,
		});

	let startAttempt = 0;
	if (options.resume && persist.load) {
		const prev = await persist.load(outcome.id);
		if (prev?.state === "passed") {
			return {
				outcomeId: outcome.id,
				passed: true,
				attempts: prev.attempt + 1,
				finalConfig: prev.config,
				timeline: prev.attempts ?? [],
				usage: prev.usage,
			};
		}
		if (prev?.state === "failed") {
			return {
				outcomeId: outcome.id,
				passed: false,
				attempts: prev.maxAttempts,
				finalConfig: prev.config,
				errors: prev.errors,
				timeline: prev.attempts ?? [],
				usage: prev.usage,
			};
		}
		if (prev) {
			// Non-terminal: a `retrying` record means that attempt is done (continue
			// at the next one); `running`/`verifying` means redo it from the agent step.
			sessionId = prev.sessionId;
			lastErrors = prev.errors;
			startAttempt = prev.state === "retrying" ? prev.attempt + 1 : prev.attempt;
			// Rehydrate prior attempts (#12); a record written before #12 has no
			// `attempts` field and loads as an empty history, not an error. A
			// `running`/`verifying` resume redoes that attempt's dispatch from
			// scratch, so drop its still-open entry (no `endedAt`) rather than
			// duplicate it once the loop below appends the fresh one.
			const rehydrated = (prev.attempts ?? []).map((a) => ({ ...a }));
			if (rehydrated.length > 0 && rehydrated[rehydrated.length - 1].endedAt === undefined) rehydrated.pop();
			attempts.push(...rehydrated);
			if (lastErrors) prompt = buildRetryPrompt(outcome.prompt, lastErrors, startAttempt, maxAttempts);
		}
	}

	for (let attempt = startAttempt; attempt < maxAttempts; attempt++) {
		if (options.signal?.aborted) break;
		const config = escalate(base, attempt);

		const current = beginAttempt(attempts, attempt, config);
		await record("running", attempt, config);
		const dispatch = await agent.dispatch({
			prompt,
			config,
			resume: sessionId,
			signal: options.signal,
			runId: outcome.id,
			attempt: attempt + 1,
		});
		sessionId = dispatch.sessionId ?? sessionId;
		// Attach usage to this attempt as soon as it's known (before its verdict is
		// decided), so an interim "verifying" record's cumulative usage (#12) already
		// includes the dispatch that just ran.
		current.usage = dispatch.usage;

		// False-pass guard (forge #19/#297): a "successful" turn that returned
		// nothing (empty text + zero tokens) never actually ran, and result text
		// that is itself a provider error means the turn died mid-flight. In both
		// cases DO NOT run the gate — a guard may only force a non-pass, never a
		// pass (the gate stays the sole authority on "done"). Re-dispatch the same
		// prompt: this is a transport/provider glitch, not a code failure to fix.
		const verdict = classifyDispatch(dispatch);
		if (verdict !== "ok") {
			lastErrors =
				verdict === "empty"
					? "The agent returned an empty response with no token usage; the turn did not execute."
					: "The agent turn ended with a provider/API error before completing.";
			const dispatchFailedLast = attempt + 1 >= maxAttempts;
			finishAttempt(current, "dispatch-failed", lastErrors);
			await record(dispatchFailedLast ? "failed" : "retrying", attempt, config);
			continue;
		}

		// Contract guard: if the agent modified a frozen contract (a user-supplied
		// test it must SATISFY, not edit), the run is void. Terminal — never retried,
		// never a pass (same shape as the false-pass guard: a guard may only force a
		// non-pass, never a pass; the gate stays the sole authority on "done").
		const contract = await workspace.assertContract?.();
		if (contract) {
			lastErrors = `anvil: the agent modified the contract (${contract.path}); the run is void.\n\n${contract.diff}`;
			finishAttempt(current, "void", lastErrors);
			await record("failed", attempt, config);
			return {
				outcomeId: outcome.id,
				passed: false,
				attempts: attempt + 1,
				finalConfig: config,
				errors: lastErrors,
				timeline: attempts,
				usage: sumUsage(attempts),
			};
		}

		// Blast-radius guard (#8): with --scope set, the agent may only modify files
		// inside the scope globs. A change outside is void -- terminal, never a pass
		// (same shape as the contract guard). This bounds the damage when the contract
		// under-specifies what "done" means: the agent can't quietly "fix" unrelated files
		// (the motivating case: an agent asked to change one route reaching into another).
		const scope = await workspace.assertScope?.();
		if (scope) {
			const paths = scope.outside.map((p) => `  ${p}`).join("\n");
			lastErrors = `anvil: the agent modified ${scope.outside.length} file(s) outside --scope; the run is void.\n\n${paths}`;
			finishAttempt(current, "void", lastErrors);
			await record("failed", attempt, config);
			return {
				outcomeId: outcome.id,
				passed: false,
				attempts: attempt + 1,
				finalConfig: config,
				errors: lastErrors,
				timeline: attempts,
				usage: sumUsage(attempts),
			};
		}

		await record("verifying", attempt, config);
		const result = await gate.verify(workspace, options.signal);
		gateCommands = result.commands.map((c) => c.cmd);

		if (result.passed) {
			await workspace.commit(`anvil: ${outcome.id}`);
			finishAttempt(current, "passed", undefined);
			await record("passed", attempt, config, { errors: undefined });
			return {
				outcomeId: outcome.id,
				passed: true,
				attempts: attempt + 1,
				finalConfig: config,
				gateCommands,
				timeline: attempts,
				usage: sumUsage(attempts),
			};
		}

		// An inconclusive gate is not a real failure: re-verify on the next
		// iteration without advancing the prompt or recording a fix-up error. Not a
		// terminal verdict of its own (#12's enum has none); "retrying" is the
		// closest fit -- this attempt did not settle, and the loop tries again.
		if (result.inconclusive) {
			finishAttempt(current, "retrying", undefined);
			await record("verifying", attempt, config);
			continue;
		}

		lastErrors = result.errors;
		const isLast = attempt + 1 >= maxAttempts;
		finishAttempt(current, isLast ? "failed" : "retrying", result.errors);
		await record(isLast ? "failed" : "retrying", attempt, config, { errors: result.errors });
		if (!isLast) {
			prompt = buildRetryPrompt(outcome.prompt, result.errors, attempt + 1, maxAttempts);
		}
	}

	return {
		outcomeId: outcome.id,
		passed: false,
		attempts: maxAttempts,
		finalConfig: escalate(base, maxAttempts - 1),
		errors: lastErrors,
		gateCommands,
		timeline: attempts,
		usage: sumUsage(attempts),
	};
}

/** Push a new open {@link AttemptRecord} for an attempt about to dispatch (#12). */
function beginAttempt(attempts: AttemptRecord[], attempt: number, config: ModelEffort): AttemptRecord {
	const entry: AttemptRecord = {
		attempt,
		config,
		// Provisional until `finishAttempt` below settles it; "retrying" is the
		// least-committal placeholder for "not yet resolved".
		verdict: "retrying",
		startedAt: new Date().toISOString(),
	};
	attempts.push(entry);
	return entry;
}

/** Settle an {@link AttemptRecord} at its terminal transition (#12). Usage is set separately, as soon as the dispatch returns. */
function finishAttempt(entry: AttemptRecord, verdict: AttemptRecord["verdict"], errors: string | undefined): void {
	entry.verdict = verdict;
	entry.errors = errors;
	entry.endedAt = new Date().toISOString();
}

/**
 * Cumulative usage across every attempt that has one (#12 Tier 3 -- RunRecord.usage
 * is now this sum, not the last dispatch's). `cost` sums only the attempts that
 * priced one and stays undefined when none did: unknown spend is never reported as $0.
 */
function sumUsage(attempts: AttemptRecord[]): TokenUsage | undefined {
	const withUsage = attempts.filter((a) => a.usage !== undefined);
	if (withUsage.length === 0) return undefined;
	const total = withUsage.reduce<TokenUsage>(
		(sum, a) => ({
			input: sum.input + (a.usage?.input ?? 0),
			output: sum.output + (a.usage?.output ?? 0),
			cacheRead: sum.cacheRead + (a.usage?.cacheRead ?? 0),
			cacheWrite: (sum.cacheWrite ?? 0) + (a.usage?.cacheWrite ?? 0),
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);
	const costs = withUsage.map((a) => a.usage?.cost).filter((c): c is number => c !== undefined);
	if (costs.length > 0) total.cost = costs.reduce((sum, c) => sum + c, 0);
	return total;
}

/** Outcome-driven retry prompt: fix the root cause, do not work around the checks. */
function buildRetryPrompt(outcome: string, errors: string, attempt: number, max: number): string {
	return `## Outcome

${outcome}

## Current State

Verification attempt ${attempt} of ${max} failed with the errors below. Fix the root cause; do not work around or disable the checks.

## Errors

${errors}

## Acceptance Criteria

- All verification commands pass (typecheck, build, tests)
- No compilation or type errors
- All imports resolve correctly`;
}

/**
 * Classify an agent turn before it reaches the gate. Two failure shapes hide
 * behind a "success" envelope (forge #19/#297): an empty response with zero
 * tokens (the turn never ran), and result text that is itself a provider/API
 * error (the turn died mid-flight). Either one must force a retry rather than
 * being verified — otherwise a repo that already satisfies the gate yields a
 * false pass.
 */
export function classifyDispatch(result: AgentResult): "ok" | "empty" | "api-error" {
	const text = (result.text ?? "").trim();
	const tokens = (result.usage?.input ?? 0) + (result.usage?.output ?? 0);
	if (text === "" && tokens === 0) return "empty";
	if (/^API Error\b/i.test(text)) return "api-error";
	if (text.length < 200 && /(internal server error|overloaded_error|\b50[0-9]\b)/i.test(text)) return "api-error";
	return "ok";
}
