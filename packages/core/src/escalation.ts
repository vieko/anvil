// ── Graduated model/effort escalation on verify-fail retry ───
//
// Anvil's thesis: verification — not model perfection — guarantees
// correctness. The default model/effort is deliberately cheap and the gate
// catches errors. The retry is a ladder: each failed attempt climbs to a
// stronger config so a too-weak base doesn't just loop until the attempt cap.
//
// Pure + deterministic, so it is unit-tested directly. `runToGate` wires it
// into the loop. Ported from forge's escalation.ts, generalized: the strong
// tier is a parameter (anvil is provider-agnostic), not a hardcoded "opus".
//
// Ladder shape (with the default 3-attempt cap, the climb is intentionally
// aggressive — jump straight to `high`, then switch model, then climb effort):
//   1. If effort is below `high`, jump to `high` (same model).
//   2. If on a weak-tier model, switch to the strong tier (keeping effort).
//   3. Climb the strong model's effort toward `max`.

import type { Effort, Escalator, ModelEffort } from "./types.ts";

/** Effort levels, weakest to strongest. */
export const EFFORT_LADDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Default strong tier anvil escalates a weak base up to. Caller can override. */
export const DEFAULT_STRONG_MODEL = "opus";

/** Default weak-tier matcher: cheaper/smaller models that should escalate. */
export const DEFAULT_WEAK_TIER = /sonnet|haiku|mini|flash|small|lite|nano/i;

/** Index of `effort` in the ladder. Undefined/unknown normalizes to `high` (the common SDK default). */
function effortIndex(effort: Effort | undefined): number {
	const i = EFFORT_LADDER.indexOf(effort ?? "high");
	return i < 0 ? EFFORT_LADDER.indexOf("high") : i;
}

export interface EscalationPolicy {
	/** Model tier to climb to when the base model is weak. Defaults to {@link DEFAULT_STRONG_MODEL}. */
	strongModel?: string;
	/** Matches weak-tier models that should escalate to `strongModel`. Defaults to {@link DEFAULT_WEAK_TIER}. */
	weakTier?: RegExp;
}

/**
 * Build the full escalation ladder for a base config. Rung 0 is the base
 * itself, unchanged. Each later rung is strictly stronger than the last.
 */
export function buildEscalationLadder(base: ModelEffort, policy: EscalationPolicy = {}): ModelEffort[] {
	const strongModel = policy.strongModel ?? DEFAULT_STRONG_MODEL;
	const weakTier = policy.weakTier ?? DEFAULT_WEAK_TIER;

	const rungs: ModelEffort[] = [{ model: base.model, effort: base.effort }];
	let model = base.model;
	let idx = effortIndex(base.effort);
	const highIdx = EFFORT_LADDER.indexOf("high");

	// 1. Jump to `high` if currently below it (same model).
	if (idx < highIdx) {
		idx = highIdx;
		rungs.push({ model, effort: EFFORT_LADDER[idx] });
	}
	// 2. Switch a weak-tier model up to the strong tier at the current effort.
	if (weakTier.test(model) && model !== strongModel) {
		model = strongModel;
		rungs.push({ model, effort: EFFORT_LADDER[idx] });
	}
	// 3. Climb the (stronger) model's effort toward `max`.
	for (let i = idx + 1; i < EFFORT_LADDER.length; i++) {
		rungs.push({ model, effort: EFFORT_LADDER[i] });
	}
	return rungs;
}

/**
 * Resolve the (model, effort) to dispatch for a 0-indexed attempt. Attempt 0
 * returns the base unchanged; higher attempts climb the ladder and clamp at
 * its strongest rung.
 */
export function makeEscalator(policy: EscalationPolicy = {}): Escalator {
	return (base, attempt) => {
		const rungs = buildEscalationLadder(base, policy);
		const i = Math.max(0, Math.min(attempt, rungs.length - 1));
		return rungs[i];
	};
}

/** The default escalator (default strong tier + weak-tier matcher). */
export const escalate: Escalator = makeEscalator();
