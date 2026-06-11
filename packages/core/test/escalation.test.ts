import { describe, expect, it } from "vitest";
import { buildEscalationLadder, EFFORT_LADDER, escalate, makeEscalator } from "../src/escalation.ts";

// Ported from forge's escalation.test.ts (A4 parity), adapted to anvil's
// provider-agnostic ladder. Two deliberate divergences from forge are pinned
// below: anvil's weak-tier matches haiku/mini/flash/etc. (not just sonnet),
// because anvil's cheap default base can be any of them; and model ids are the
// gateway "provider/model" dot-version form.

describe("buildEscalationLadder", () => {
	it("climbs a weak base: sonnet@low -> sonnet@high -> opus@high -> opus@xhigh -> opus@max", () => {
		expect(buildEscalationLadder({ model: "sonnet", effort: "low" })).toEqual([
			{ model: "sonnet", effort: "low" },
			{ model: "sonnet", effort: "high" },
			{ model: "opus", effort: "high" },
			{ model: "opus", effort: "xhigh" },
			{ model: "opus", effort: "max" },
		]);
	});

	it("jumps straight to high (skips medium) given the aggressive 3-attempt budget", () => {
		const ladder = buildEscalationLadder({ model: "sonnet", effort: "medium" });
		expect(ladder[0]).toEqual({ model: "sonnet", effort: "medium" });
		expect(ladder[1]).toEqual({ model: "sonnet", effort: "high" });
		// medium never reappears after the base rung.
		expect(ladder.slice(1).map((r) => r.effort)).not.toContain("medium");
	});

	it("switches model first when already at high (sonnet@high)", () => {
		expect(buildEscalationLadder({ model: "sonnet", effort: "high" })).toEqual([
			{ model: "sonnet", effort: "high" },
			{ model: "opus", effort: "high" },
			{ model: "opus", effort: "xhigh" },
			{ model: "opus", effort: "max" },
		]);
	});

	it("climbs effort only for a strong base (opus@low, no model switch)", () => {
		expect(buildEscalationLadder({ model: "opus", effort: "low" })).toEqual([
			{ model: "opus", effort: "low" },
			{ model: "opus", effort: "high" },
			{ model: "opus", effort: "xhigh" },
			{ model: "opus", effort: "max" },
		]);
	});

	it("does not escalate a top-tier base (opus@max is a singleton ladder)", () => {
		expect(buildEscalationLadder({ model: "opus", effort: "max" })).toEqual([{ model: "opus", effort: "max" }]);
	});

	it("recognizes a full gateway sonnet id as weak-tier and escalates it to opus", () => {
		const ladder = buildEscalationLadder({ model: "anthropic/claude-sonnet-4.6", effort: "low" });
		expect(ladder).toContainEqual({ model: "opus", effort: "high" });
	});

	it("preserves undefined effort at rung 0, then escalates to opus@high", () => {
		expect(buildEscalationLadder({ model: "anthropic/claude-sonnet-4.6", effort: undefined })).toEqual([
			{ model: "anthropic/claude-sonnet-4.6", effort: undefined },
			{ model: "opus", effort: "high" },
			{ model: "opus", effort: "xhigh" },
			{ model: "opus", effort: "max" },
		]);
	});

	it("treats an unknown non-weak model as top-tier (effort climb only, no model switch)", () => {
		expect(buildEscalationLadder({ model: "gpt-5", effort: "low" })).toEqual([
			{ model: "gpt-5", effort: "low" },
			{ model: "gpt-5", effort: "high" },
			{ model: "gpt-5", effort: "xhigh" },
			{ model: "gpt-5", effort: "max" },
		]);
	});

	// Deliberate divergence from forge: anvil's weak-tier includes haiku (its
	// cheap gateway default), so a haiku base escalates to opus. Forge, whose
	// only weak tier is sonnet, would leave haiku unescalated.
	it("treats haiku as weak-tier (anvil generalization) and escalates it to opus", () => {
		expect(buildEscalationLadder({ model: "anthropic/claude-haiku-4.5", effort: "low" })).toEqual([
			{ model: "anthropic/claude-haiku-4.5", effort: "low" },
			{ model: "anthropic/claude-haiku-4.5", effort: "high" },
			{ model: "opus", effort: "high" },
			{ model: "opus", effort: "xhigh" },
			{ model: "opus", effort: "max" },
		]);
	});
});

describe("escalate", () => {
	it("returns the base unchanged at attempt 0 (incl. undefined effort)", () => {
		expect(escalate({ model: "anthropic/claude-sonnet-4.6", effort: undefined }, 0)).toEqual({
			model: "anthropic/claude-sonnet-4.6",
			effort: undefined,
		});
	});

	it("reaches opus@high by the final (3rd) attempt from a weak base", () => {
		expect(escalate({ model: "sonnet", effort: "low" }, 0)).toEqual({ model: "sonnet", effort: "low" });
		expect(escalate({ model: "sonnet", effort: "low" }, 1)).toEqual({ model: "sonnet", effort: "high" });
		expect(escalate({ model: "sonnet", effort: "low" }, 2)).toEqual({ model: "opus", effort: "high" });
	});

	it("clamps at the strongest rung for attempts past the ladder length", () => {
		expect(escalate({ model: "sonnet", effort: "low" }, 99)).toEqual({ model: "opus", effort: "max" });
		expect(escalate({ model: "opus", effort: "max" }, 5)).toEqual({ model: "opus", effort: "max" });
	});

	it("clamps a negative attempt to the base", () => {
		expect(escalate({ model: "sonnet", effort: "low" }, -1)).toEqual({ model: "sonnet", effort: "low" });
	});

	it("honors a custom strong tier (provider-agnostic)", () => {
		const climb = makeEscalator({ strongModel: "gpt-strong", weakTier: /gpt-mini/ });
		expect(climb({ model: "gpt-mini", effort: "low" }, 2)).toEqual({ model: "gpt-strong", effort: "high" });
	});
});

describe("EFFORT_LADDER", () => {
	it("is ordered weakest-to-strongest", () => {
		expect(EFFORT_LADDER).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});
});
