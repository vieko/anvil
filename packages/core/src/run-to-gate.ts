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
	Escalator,
	Gate,
	ModelEffort,
	Outcome,
	RunRecord,
	RunState,
	StatePersister,
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
}

export interface RunToGateResult {
	outcomeId: string;
	passed: boolean;
	attempts: number;
	finalConfig: ModelEffort;
	errors?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE: ModelEffort = { model: "sonnet" };

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
	const base: ModelEffort = outcome.base ?? DEFAULT_BASE;

	let prompt = outcome.prompt;
	let lastErrors: string | undefined;
	let sessionId: string | undefined;

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
			updatedAt: new Date().toISOString(),
			...extra,
		});

	let startAttempt = 0;
	if (options.resume && persist.load) {
		const prev = await persist.load(outcome.id);
		if (prev?.state === "passed") {
			return { outcomeId: outcome.id, passed: true, attempts: prev.attempt + 1, finalConfig: prev.config };
		}
		if (prev?.state === "failed") {
			return {
				outcomeId: outcome.id,
				passed: false,
				attempts: prev.maxAttempts,
				finalConfig: prev.config,
				errors: prev.errors,
			};
		}
		if (prev) {
			// Non-terminal: a `retrying` record means that attempt is done (continue
			// at the next one); `running`/`verifying` means redo it from the agent step.
			sessionId = prev.sessionId;
			lastErrors = prev.errors;
			startAttempt = prev.state === "retrying" ? prev.attempt + 1 : prev.attempt;
			if (lastErrors) prompt = buildRetryPrompt(outcome.prompt, lastErrors, startAttempt, maxAttempts);
		}
	}

	for (let attempt = startAttempt; attempt < maxAttempts; attempt++) {
		if (options.signal?.aborted) break;
		const config = escalate(base, attempt);

		await record("running", attempt, config);
		const dispatch = await agent.dispatch({ prompt, config, resume: sessionId, signal: options.signal });
		sessionId = dispatch.sessionId ?? sessionId;

		await record("verifying", attempt, config, { usage: dispatch.usage });
		const result = await gate.verify(workspace, options.signal);

		if (result.passed) {
			await workspace.commit(`anvil: ${outcome.id}`);
			await record("passed", attempt, config, { usage: dispatch.usage, errors: undefined });
			return { outcomeId: outcome.id, passed: true, attempts: attempt + 1, finalConfig: config };
		}

		// An inconclusive gate is not a real failure: re-verify on the next
		// iteration without advancing the prompt or recording a fix-up error.
		if (result.inconclusive) {
			await record("verifying", attempt, config, { usage: dispatch.usage });
			continue;
		}

		lastErrors = result.errors;
		const isLast = attempt + 1 >= maxAttempts;
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
	};
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
