import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildEscalationLadder, EFFORT_LADDER } from "../src/index.ts";
import { createModelResolver, createSupportedEfforts, DEFAULT_MODEL_ALIASES } from "../src/node/model-resolver.ts";

describe("createModelResolver", () => {
	it("defaults to the Vercel AI Gateway for the logical aliases", () => {
		const resolve = createModelResolver();
		const opus = resolve({ model: "opus" });
		expect(opus.provider).toBe("vercel-ai-gateway");
		expect(opus.id).toBe("anthropic/claude-opus-5");
		expect(resolve({ model: "sonnet" }).id).toBe("anthropic/claude-sonnet-5");
		expect(resolve({ model: "haiku" }).id).toBe("anthropic/claude-haiku-4.5");
		expect(resolve({ model: "luna" }).id).toBe("openai/gpt-5.6-luna");
	});

	it("bridges claude-opus-5 from opus-4.8's builtin metadata until pi-ai's catalog includes it", () => {
		const resolve = createModelResolver();
		const opus5 = resolve({ model: "vercel-ai-gateway:anthropic/claude-opus-5" });
		const opus48 = resolve({ model: "vercel-ai-gateway:anthropic/claude-opus-4.8" });
		expect(opus5.id).toBe("anthropic/claude-opus-5");
		expect(opus5.name).toBe("Claude Opus 5");
		// Everything but id/name is inherited from the 4.8 sibling (same gateway
		// terms: 1M context, $5/$25 -- verified against the gateway remote catalog).
		expect(opus5.cost).toEqual(opus48.cost);
		expect(opus5.contextWindow).toBe(opus48.contextWindow);
		expect(opus5.provider).toBe("vercel-ai-gateway");
	});

	it("resolves the sonnet alias to anthropic/claude-sonnet-5", () => {
		expect(createModelResolver()({ model: "sonnet" }).id).toBe("anthropic/claude-sonnet-5");
	});

	it("resolves an explicit provider:model-id (direct Anthropic, bypassing the gateway)", () => {
		const resolve = createModelResolver();
		const m = resolve({ model: "anthropic:claude-haiku-4-5" });
		expect(m.provider).toBe("anthropic");
		expect(m.id).toBe("claude-haiku-4-5");
	});

	it("can be reconfigured for direct provider access (the provider-agnostic seam)", () => {
		const resolve = createModelResolver({
			defaultProvider: "anthropic",
			replaceDefaults: true,
			aliases: { sonnet: "anthropic:claude-sonnet-4-5" },
		});
		expect(resolve({ model: "sonnet" }).provider).toBe("anthropic");
	});

	it("resolves a bare known model id by searching the registry", () => {
		const resolve = createModelResolver();
		expect(resolve({ model: "claude-opus-4-5" }).id).toBe("claude-opus-4-5");
	});

	it("supports custom aliases merged over the defaults", () => {
		const resolve = createModelResolver({ aliases: { cheap: "anthropic:claude-haiku-4-5" } });
		expect(resolve({ model: "cheap" }).id).toBe("claude-haiku-4-5");
		expect(resolve({ model: "opus" }).id).toBe("anthropic/claude-opus-5"); // gateway defaults still present
	});

	it("accepts a concrete Model as an alias value", () => {
		const fake = { id: "x", provider: "custom" } as unknown as Model<any>;
		const resolve = createModelResolver({ aliases: { x: fake } });
		expect(resolve({ model: "x" })).toBe(fake);
	});

	it("replaceDefaults drops the built-in aliases", () => {
		const resolve = createModelResolver({ replaceDefaults: true, aliases: { only: "anthropic:claude-opus-4-5" } });
		expect(resolve({ model: "only" }).id).toBe("claude-opus-4-5");
		expect(() => resolve({ model: "opus" })).toThrow(/could not resolve/);
	});

	it("throws an actionable error for an unknown model", () => {
		const resolve = createModelResolver();
		expect(() => resolve({ model: "nope-9000" })).toThrow(/could not resolve model "nope-9000"/);
	});

	it("caches resolution (same input returns the same Model instance)", () => {
		const resolve = createModelResolver();
		expect(resolve({ model: "opus" })).toBe(resolve({ model: "opus" }));
	});

	it("resolves every rung the default escalation ladder emits", () => {
		const resolve = createModelResolver();
		const ladder = buildEscalationLadder({ model: "sonnet", effort: "low" });
		for (const rung of ladder) {
			expect(() => resolve(rung)).not.toThrow();
		}
		expect(DEFAULT_MODEL_ALIASES.sonnet).toContain("claude-sonnet");
	});
});

describe("createSupportedEfforts", () => {
	// Against the real pi-ai catalog: pi 0.82 marks xhigh/max supported only
	// when the provider verified them (thinkingLevelMap), so these pin the
	// catalog facts the escalation ladder clamps against. Note: opus resolves
	// through the claude-opus-5 DERIVED_MODELS bridge and inherits opus-4.8's
	// thinking metadata -- an approximation until pi-ai ships real opus-5
	// metadata (#33).
	const supported = createSupportedEfforts();

	it("reports haiku verifies nothing above high", () => {
		expect(supported("haiku")).toEqual(["low", "medium", "high"]);
	});

	it("reports sonnet and opus verify the full ladder (xhigh + max)", () => {
		expect(supported("sonnet")).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(supported("opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("reports luna's xhigh ceiling (no max)", () => {
		expect(supported("luna")).toEqual(["low", "medium", "high", "xhigh"]);
	});

	it("returns undefined for an unresolvable name instead of throwing (no capability info, no clamping)", () => {
		expect(supported("nope-9000")).toBeUndefined();
	});

	it("leaves the default ladder from the default base untouched (every rung already verified)", () => {
		const base = { model: "sonnet", effort: "low" } as const;
		expect(buildEscalationLadder(base, { supportedEfforts: supported })).toEqual(buildEscalationLadder(base));
	});

	it("clamps an explicit max on haiku down to its verified ceiling in the ladder", () => {
		expect(buildEscalationLadder({ model: "haiku", effort: "max" }, { supportedEfforts: supported })).toEqual([
			{ model: "haiku", effort: "high" },
			{ model: "opus", effort: "max" },
		]);
	});
});

describe("Effort <-> ThinkingLevel intersection (drift pin)", () => {
	// anvil's Effort must stay exactly pi's ThinkingLevel minus off/minimal.
	// A faux model with every optional level verified makes pi enumerate its
	// full runtime level list; this pins the mapping at every dep bump (the
	// compile-time half lives in pi-agent.ts's defaultThinkingLevel).
	it("EFFORT_LADDER is pi's full thinking-level list minus off/minimal", () => {
		const fullMap = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as unknown as Model<any>;
		const piLevels = getSupportedThinkingLevels(fullMap);
		expect(piLevels.filter((level) => (EFFORT_LADDER as readonly string[]).includes(level))).toEqual([
			...EFFORT_LADDER,
		]);
		expect(piLevels.filter((level) => !(EFFORT_LADDER as readonly string[]).includes(level))).toEqual([
			"off",
			"minimal",
		]);
	});
});
