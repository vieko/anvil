import { describe, expect, it } from "vitest";
import { buildEscalationLadder, escalate, makeEscalator } from "../src/escalation.ts";

describe("escalation ladder", () => {
	it("climbs a weak base: sonnet@low -> sonnet@high -> opus@high -> opus@xhigh -> opus@max", () => {
		expect(buildEscalationLadder({ model: "sonnet", effort: "low" })).toEqual([
			{ model: "sonnet", effort: "low" },
			{ model: "sonnet", effort: "high" },
			{ model: "opus", effort: "high" },
			{ model: "opus", effort: "xhigh" },
			{ model: "opus", effort: "max" },
		]);
	});

	it("does not escalate a top-tier base", () => {
		expect(buildEscalationLadder({ model: "opus", effort: "max" })).toEqual([{ model: "opus", effort: "max" }]);
	});

	it("clamps at the strongest rung for attempts beyond the ladder", () => {
		expect(escalate({ model: "sonnet", effort: "low" }, 99)).toEqual({ model: "opus", effort: "max" });
	});

	it("honors a custom strong tier (provider-agnostic)", () => {
		const climb = makeEscalator({ strongModel: "gpt-strong", weakTier: /gpt-mini/ });
		expect(climb({ model: "gpt-mini", effort: "low" }, 2)).toEqual({ model: "gpt-strong", effort: "high" });
	});
});
