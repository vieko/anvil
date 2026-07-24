import { describe, expect, it } from "vitest";
import { buildEscalationLadder, EFFORT_LADDER, escalate, makeEscalator } from "../src/escalation.ts";
import type { Effort } from "../src/types.ts";

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

	it("treats budget-tier models (luna/terra/glm) as weak: luna@high -> opus@high", () => {
		expect(buildEscalationLadder({ model: "luna", effort: "high" })).toEqual([
			{ model: "luna", effort: "high" },
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

describe("buildEscalationLadder with supportedEfforts (catalog clamping, #31)", () => {
	// Fakes shaped like pi-ai 0.82's verified-levels catalog: haiku-like models
	// verify nothing above high; luna-like models have an xhigh ceiling (no max);
	// the strong tier verifies everything.
	const catalog: Record<string, readonly Effort[]> = {
		haiku: ["low", "medium", "high"],
		luna: ["low", "medium", "high", "xhigh"],
		sonnet: ["low", "medium", "high", "xhigh", "max"],
		opus: ["low", "medium", "high", "xhigh", "max"],
	};
	const supportedEfforts = (model: string) => catalog[model];

	it("skips rungs above the strong model's ceiling instead of repeating the previous request", () => {
		// A luna-like strong tier: the raw ladder would end luna@xhigh -> luna@max,
		// but max is unverified and clamps into a duplicate of xhigh -- skipped.
		expect(
			buildEscalationLadder(
				{ model: "haiku", effort: "low" },
				{ strongModel: "luna", weakTier: /haiku/, supportedEfforts },
			),
		).toEqual([
			{ model: "haiku", effort: "low" },
			{ model: "haiku", effort: "high" },
			{ model: "luna", effort: "high" },
			{ model: "luna", effort: "xhigh" },
		]);
	});

	it("clamps rung 0: an explicit max on a model without max is a real rung, not a duplicate in disguise", () => {
		expect(buildEscalationLadder({ model: "haiku", effort: "max" }, { supportedEfforts })).toEqual([
			{ model: "haiku", effort: "high" },
			{ model: "opus", effort: "max" },
		]);
	});

	it("clamps a base above the model's ceiling before the model switch", () => {
		expect(buildEscalationLadder({ model: "haiku", effort: "xhigh" }, { supportedEfforts })).toEqual([
			{ model: "haiku", effort: "high" },
			{ model: "opus", effort: "xhigh" },
			{ model: "opus", effort: "max" },
		]);
	});

	it("dedupes the whole effort climb down to the model's ceiling when there is no model switch", () => {
		// No weak-tier match: the raw ladder climbs haiku@low -> high -> xhigh -> max,
		// but everything above high clamps into duplicates and is skipped.
		expect(buildEscalationLadder({ model: "haiku", effort: "low" }, { weakTier: /nothing/, supportedEfforts })).toEqual(
			[
				{ model: "haiku", effort: "low" },
				{ model: "haiku", effort: "high" },
			],
		);
	});

	it("leaves the ladder unclamped for models without capability info (undefined)", () => {
		expect(buildEscalationLadder({ model: "gpt-5", effort: "low" }, { supportedEfforts })).toEqual(
			buildEscalationLadder({ model: "gpt-5", effort: "low" }),
		);
	});

	it("never clamps an undefined effort (provider default rides through)", () => {
		const ladder = buildEscalationLadder({ model: "haiku", effort: undefined }, { supportedEfforts });
		expect(ladder[0]).toEqual({ model: "haiku", effort: undefined });
	});

	it("is a no-op for a ladder whose rungs are all verified", () => {
		expect(buildEscalationLadder({ model: "sonnet", effort: "low" }, { supportedEfforts })).toEqual(
			buildEscalationLadder({ model: "sonnet", effort: "low" }),
		);
	});

	it("threads through makeEscalator: attempts index the clamped ladder", () => {
		const climb = makeEscalator({ strongModel: "luna", weakTier: /haiku/, supportedEfforts });
		expect(climb({ model: "haiku", effort: "low" }, 3)).toEqual({ model: "luna", effort: "xhigh" });
		// Past the ladder end clamps at the strongest *verified* rung, not luna@max.
		expect(climb({ model: "haiku", effort: "low" }, 99)).toEqual({ model: "luna", effort: "xhigh" });
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
