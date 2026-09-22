import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { buildEscalationLadder, EFFORT_LADDER } from "../src/index.ts";
import {
	applyGatewayRouting,
	createModelResolver,
	createSupportedEfforts,
	DEFAULT_MODEL_ALIASES,
	withGatewayCompatModels,
} from "../src/node/model-resolver.ts";

describe("createModelResolver", () => {
	it("defaults to the Vercel AI Gateway for the logical aliases", () => {
		const resolve = createModelResolver();
		const opus = resolve({ model: "opus" });
		expect(opus.provider).toBe("vercel-ai-gateway");
		expect(opus.id).toBe("anthropic/claude-opus-5.5");
		expect(resolve({ model: "sonnet" }).id).toBe("anthropic/claude-sonnet-5");
		expect(resolve({ model: "haiku" }).id).toBe("anthropic/claude-haiku-4.5");
		expect(resolve({ model: "luna" }).id).toBe("openai/gpt-6-luna");
		expect(resolve({ model: "sol" }).id).toBe("openai/gpt-6-sol");
		expect(resolve({ model: "terra" }).id).toBe("openai/gpt-5.6-terra");
		expect(resolve({ model: "glm" }).id).toBe("zai/glm-5.3");
		expect(resolve({ model: "fable" }).id).toBe("anthropic/claude-fable-5.1");
		expect(resolve({ model: "astra" }).id).toBe("openai/gpt-6-astra");
	});

	it("every DEFAULT_WEAK_TIER-anticipated alias resolves (terra/glm gap closed)", () => {
		const resolve = createModelResolver();
		for (const name of Object.keys(DEFAULT_MODEL_ALIASES)) {
			expect(() => resolve({ model: name })).not.toThrow();
		}
	});

	it("resolves claude-opus-5 from pi-ai's builtin catalog (bridge retired in #33)", () => {
		const resolve = createModelResolver();
		const opus5 = resolve({ model: "vercel-ai-gateway:anthropic/claude-opus-5" });
		const fable = resolve({ model: "vercel-ai-gateway:anthropic/claude-fable-5.1" });
		expect(fable.compat).toMatchObject({
			vercelGatewayRouting: { only: ["anthropic"] },
			supportsMidConvoEffort: true,
		});
		// The overlay is a shallow merge: the registry's own compat (load-bearing --
		// adaptive thinking, and Opus 4.7+ rejecting a temperature) must survive it.
		expect(opus5.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });
		expect(fable.compat).toMatchObject({ forceAdaptiveThinking: true });
		expect(opus5.id).toBe("anthropic/claude-opus-5");
		expect(opus5.name).toBe("Claude Opus 5");
		expect(opus5.compat).toMatchObject({
			vercelGatewayRouting: { only: ["anthropic"] },
			supportsMidConvoEffort: true,
		});
		// Pin the gateway terms the escalation ladder prices against
		// (verified against the gateway remote catalog: 1M context, $5/$25).
		expect(opus5.cost).toMatchObject({ input: 5, output: 25 });
		expect(opus5.contextWindow).toBe(1_000_000);
		expect(opus5.provider).toBe("vercel-ai-gateway");
	});

	it("resolves opus to Claude Opus 5.5 on the gateway with the full Claude overlay", () => {
		const resolve = createModelResolver();
		const opus = resolve({ model: "opus" });
		expect(opus.id).toBe("anthropic/claude-opus-5.5");
		expect(opus.name).toBe("Claude Opus 5.5");
		expect(opus.compat).toMatchObject({
			vercelGatewayRouting: { only: ["anthropic"] },
			supportsStrictTools: true,
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
			// The registry's own compat survives the shallow merge.
			forceAdaptiveThinking: true,
			supportsTemperature: false,
		});
		// Pin the gateway terms the strong tier was picked on: cheaper than
		// fable-5.1 on cache-read (0.20 vs 0.25), cache-write (5 vs 12.5) and
		// output (20 vs 50), on a ~98% cache-read rung.
		expect(opus.cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
		const fable = resolve({ model: "fable" });
		expect(fable.cost.cacheRead).toBeGreaterThan(opus.cost.cacheRead);
		expect(fable.cost.cacheWrite).toBeGreaterThan(opus.cost.cacheWrite);
		expect(fable.cost.output).toBeGreaterThan(opus.cost.output);
	});

	it("applies the Claude gateway overlay only to Anthropic models", () => {
		const resolve = createModelResolver();
		const sonnet = resolve({ model: "vercel-ai-gateway:anthropic/claude-sonnet-5" });
		expect(sonnet.compat).toMatchObject({ vercelGatewayRouting: { only: ["anthropic"] } });
		expect(sonnet.compat).not.toHaveProperty("supportsMidConvoEffort");
		const luna = resolve({ model: "vercel-ai-gateway:openai/gpt-6-luna" });
		expect(luna.compat).not.toHaveProperty("supportsStrictTools");
		expect(luna.compat).not.toHaveProperty("supportsMidConvoEffort");
		expect(luna.compat).not.toHaveProperty("supportsMidConvoSystemMessages");
		expect(luna.compat).not.toHaveProperty("supportsMidConvoToolChanges");
		const zai = resolve({ model: "glm" });
		expect(zai.compat ?? {}).not.toHaveProperty("vercelGatewayRouting");
		expect(zai).toBe(getBuiltinModel("vercel-ai-gateway", "zai/glm-5.3"));
	});

	it("fences every openai/* gateway model to OpenAI's route; only astra gets a thinking overlay", () => {
		const resolve = createModelResolver();
		for (const [alias, id] of [
			["sol", "openai/gpt-6-sol"],
			["luna", "openai/gpt-6-luna"],
			["terra", "openai/gpt-5.6-terra"],
		] as const) {
			const model = resolve({ model: alias });
			const registry = getBuiltinModel("vercel-ai-gateway", id);
			expect(model.provider).toBe("vercel-ai-gateway");
			expect(model.id).toBe(id);
			expect(model.compat).toEqual({ ...registry.compat, vercelGatewayRouting: { only: ["openai"] } });
			expect(model.compat).not.toHaveProperty("forceAdaptiveThinking");
			// No level map overlay: pi's catalog already makes off..xhigh selectable.
			expect(model.thinkingLevelMap).toBe(registry.thinkingLevelMap);
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
			// A clone: the shared registry object never grows the pin.
			expect(model).not.toBe(registry);
			expect(registry.compat ?? {}).not.toHaveProperty("vercelGatewayRouting");
		}
		// sol matches sonnet's rung price on the gateway.
		expect(resolve({ model: "sol" }).cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
		expect(resolve({ model: "luna" }).cost).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
	});

	it("resolves astra to GPT-6 Astra on the gateway with the routing pin, adaptive thinking, and the full effort map", () => {
		const resolve = createModelResolver();
		const astra = resolve({ model: "astra" });
		expect(astra.provider).toBe("vercel-ai-gateway");
		expect(astra.id).toBe("openai/gpt-6-astra");
		expect(astra.name).toBe("GPT-6 Astra");
		expect(astra.compat).toEqual({
			...getBuiltinModel("vercel-ai-gateway", "openai/gpt-6-astra").compat,
			vercelGatewayRouting: { only: ["openai"] },
			forceAdaptiveThinking: true,
		});
		// Effort semantics stay Claude-only: no mid-convo effort beta on astra.
		expect(astra.compat).not.toHaveProperty("supportsMidConvoEffort");
		expect(astra.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(getSupportedThinkingLevels(astra)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		// Pin the gateway terms the ladder prices against: 5x opus-5.5 on
		// cache-read (why it is not the strong tier).
		expect(astra.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
		expect(astra.contextWindow).toBeGreaterThanOrEqual(1_000_000);
	});

	it("clones astra without mutating the registry, and pins other openai/* gateway models without a level map", () => {
		const resolve = createModelResolver();
		const astra = resolve({ model: "vercel-ai-gateway:openai/gpt-6-astra" });
		const registry = getBuiltinModel("vercel-ai-gateway", "openai/gpt-6-astra");
		expect(astra).not.toBe(registry);
		expect(astra).toBe(resolve({ model: "vercel-ai-gateway:openai/gpt-6-astra" }));
		expect(resolve({ model: "astra" })).toBe(resolve({ model: "astra" }));
		expect(registry.compat ?? {}).not.toHaveProperty("vercelGatewayRouting");
		expect(registry.compat ?? {}).not.toHaveProperty("forceAdaptiveThinking");
		expect(registry.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
		expect(astra.thinkingLevelMap).not.toBe(registry.thinkingLevelMap);
		const luna = resolve({ model: "vercel-ai-gateway:openai/gpt-6-luna" });
		const lunaRegistry = getBuiltinModel("vercel-ai-gateway", "openai/gpt-6-luna");
		expect(luna).not.toBe(lunaRegistry);
		expect(luna.compat).toMatchObject({ vercelGatewayRouting: { only: ["openai"] } });
		expect(lunaRegistry.compat ?? {}).not.toHaveProperty("vercelGatewayRouting");
		expect(luna.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
	});

	it("clones gateway registry models without mutating them", () => {
		const resolve = createModelResolver();
		const first = resolve({ model: "vercel-ai-gateway:anthropic/claude-opus-5" });
		const second = resolve({ model: "vercel-ai-gateway:anthropic/claude-opus-5" });
		const registry = getBuiltinModel("vercel-ai-gateway", "anthropic/claude-opus-5");
		expect(first).toBe(second);
		expect(first).not.toBe(registry);
		// The shared registry object itself never grows anvil's overlay.
		expect(registry.compat).not.toHaveProperty("supportsMidConvoEffort");
		expect(registry.compat).not.toHaveProperty("vercelGatewayRouting");
		// A concrete alias is returned untouched, unlike a registry lookup.
		const concrete = { id: "x", provider: "vercel-ai-gateway" } as unknown as Model<any>;
		expect(createModelResolver({ aliases: { concrete } })({ model: "concrete" })).toBe(concrete);
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
		expect(resolve({ model: "opus" }).id).toBe("anthropic/claude-opus-5.5"); // gateway defaults still present
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
		expect(ladder.at(-1)?.model).toBe("opus");
		expect(DEFAULT_MODEL_ALIASES.sonnet).toContain("claude-sonnet");
		expect(DEFAULT_MODEL_ALIASES.opus).toContain("claude-opus-5.5");
	});
});

describe("withGatewayCompatModels", () => {
	// pi's harness keeps only a { provider, modelId } identity and re-resolves
	// every request (and every mid-run setModel) through the Models collection, so
	// the overlay has to be visible here too or it never reaches the provider.
	const models = withGatewayCompatModels(builtinModels());

	it("overlays gateway Claude models resolved by identity", () => {
		for (const id of ["anthropic/claude-opus-5", "anthropic/claude-opus-5.5", "anthropic/claude-fable-5.1"]) {
			expect(models.getModel("vercel-ai-gateway", id)?.compat).toMatchObject({
				vercelGatewayRouting: { only: ["anthropic"] },
				supportsMidConvoEffort: true,
			});
		}
		const sonnet = models.getModel("vercel-ai-gateway", "anthropic/claude-sonnet-5");
		expect(sonnet?.compat).toMatchObject({ vercelGatewayRouting: { only: ["anthropic"] } });
		expect(sonnet?.compat).not.toHaveProperty("supportsMidConvoEffort");
	});

	it("mirrors native anthropic strict-tools and mid-convo system flags onto the gateway route", () => {
		for (const id of [
			"anthropic/claude-opus-5",
			"anthropic/claude-opus-5.5",
			"anthropic/claude-fable-5.1",
			"anthropic/claude-sonnet-5",
			"anthropic/claude-haiku-4.5",
		]) {
			expect(models.getModel("vercel-ai-gateway", id)?.compat).toMatchObject({ supportsStrictTools: true });
		}
		for (const id of ["anthropic/claude-opus-5", "anthropic/claude-opus-5.5", "anthropic/claude-fable-5.1"]) {
			expect(models.getModel("vercel-ai-gateway", id)?.compat).toMatchObject({
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
			});
		}
		for (const id of ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5"]) {
			expect(models.getModel("vercel-ai-gateway", id)?.compat).not.toHaveProperty("supportsMidConvoSystemMessages");
			expect(models.getModel("vercel-ai-gateway", id)?.compat).not.toHaveProperty("supportsMidConvoToolChanges");
		}
		expect(models.getModel("vercel-ai-gateway", "openai/gpt-6-astra")?.compat).not.toHaveProperty(
			"supportsStrictTools",
		);
	});

	it("overlays astra resolved by identity (routing pin + adaptive thinking + full effort map)", () => {
		const astra = models.getModel("vercel-ai-gateway", "openai/gpt-6-astra");
		expect(astra?.compat).toEqual({
			...builtinModels().getModel("vercel-ai-gateway", "openai/gpt-6-astra")?.compat,
			vercelGatewayRouting: { only: ["openai"] },
			forceAdaptiveThinking: true,
		});
		expect(astra?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(astra).not.toBe(builtinModels().getModel("vercel-ai-gateway", "openai/gpt-6-astra"));
		expect(models.getModels("vercel-ai-gateway").find((m) => m.id === "openai/gpt-6-astra")?.compat).toMatchObject({
			forceAdaptiveThinking: true,
		});
	});

	it("pins other openai/* models resolved by identity to OpenAI's route, without a thinking overlay", () => {
		for (const id of ["openai/gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-5.6-terra"]) {
			expect(models.getModel("vercel-ai-gateway", id)?.compat).toEqual({
				...builtinModels().getModel("vercel-ai-gateway", id)?.compat,
				vercelGatewayRouting: { only: ["openai"] },
			});
			expect(models.getModel("vercel-ai-gateway", id)?.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
		}
	});

	it("leaves other providers, unknown ids, and the rest of the collection alone", () => {
		expect(models.getModel("vercel-ai-gateway", "zai/glm-5.3")?.compat).toEqual(
			builtinModels().getModel("vercel-ai-gateway", "zai/glm-5.3")?.compat,
		);
		expect(models.getModel("vercel-ai-gateway", "zai/glm-5.3")?.compat ?? {}).not.toHaveProperty(
			"vercelGatewayRouting",
		);
		expect(models.getModel("anthropic", "claude-opus-4-5")?.compat).toEqual(
			builtinModels().getModel("anthropic", "claude-opus-4-5")?.compat,
		);
		expect(models.getModel("vercel-ai-gateway", "nope-9000")).toBeUndefined();
		// Delegation stays intact for everything the harness also uses.
		expect(models.getProviders().length).toBe(builtinModels().getProviders().length);
		expect(models.getModels("vercel-ai-gateway").length).toBe(builtinModels().getModels("vercel-ai-gateway").length);
	});
});

describe("applyGatewayRouting", () => {
	// The `before_payload` hook body: pi's anthropic-messages adapter ignores
	// `compat.vercelGatewayRouting` (pi#9211), so this writes the body-level
	// `providerOptions.gateway` the gateway's /v1/messages actually honors.
	const resolve = createModelResolver();
	const opus = resolve({ model: "opus" });

	it("adds providerOptions.gateway.only for a fenced gateway anthropic model, without mutating the payload", () => {
		const payload = { model: "anthropic/claude-opus-5.5", messages: [] };
		const routed = applyGatewayRouting(opus, payload);
		expect(routed).toEqual({
			model: "anthropic/claude-opus-5.5",
			messages: [],
			providerOptions: { gateway: { only: ["anthropic"] } },
		});
		expect(routed).not.toBe(payload);
		expect(payload).toEqual({ model: "anthropic/claude-opus-5.5", messages: [] });
	});

	it("fences astra to openai and preserves sibling providerOptions keys", () => {
		const routed = applyGatewayRouting(resolve({ model: "astra" }), { providerOptions: { other: 1 } });
		expect(routed).toEqual({ providerOptions: { other: 1, gateway: { only: ["openai"] } } });
	});

	it("fences sol and luna to openai through the same pin", () => {
		for (const alias of ["sol", "luna"]) {
			expect(applyGatewayRouting(resolve({ model: alias }), {})).toEqual({
				providerOptions: { gateway: { only: ["openai"] } },
			});
		}
	});

	it("forwards both only and order when the pin names both, as copies", () => {
		const only = ["anthropic", "bedrock"];
		const order = ["anthropic"];
		const pinned = { ...opus, compat: { vercelGatewayRouting: { only, order } } } as Model<any>;
		const routed = applyGatewayRouting(pinned, {}) as { providerOptions: { gateway: Record<string, string[]> } };
		expect(routed.providerOptions.gateway).toEqual({ only: ["anthropic", "bedrock"], order: ["anthropic"] });
		expect(routed.providerOptions.gateway.only).not.toBe(only);
		expect(routed.providerOptions.gateway.order).not.toBe(order);
	});

	it("returns undefined for a gateway model without the pin, an empty pin, or a non-gateway model", () => {
		expect(applyGatewayRouting(resolve({ model: "glm" }), {})).toBeUndefined();
		const empty = { ...opus, compat: { vercelGatewayRouting: {} } } as Model<any>;
		expect(applyGatewayRouting(empty, {})).toBeUndefined();
		const direct = { ...opus, provider: "anthropic" } as Model<any>;
		expect(applyGatewayRouting(direct, {})).toBeUndefined();
	});

	it("returns undefined when providerOptions.gateway is already present or the payload is not an object", () => {
		const payload = { providerOptions: { gateway: { order: ["bedrock"] } } };
		expect(applyGatewayRouting(opus, payload)).toBeUndefined();
		expect(payload).toEqual({ providerOptions: { gateway: { order: ["bedrock"] } } });
		expect(applyGatewayRouting(opus, undefined)).toBeUndefined();
		expect(applyGatewayRouting(opus, "body")).toBeUndefined();
	});
});

describe("createSupportedEfforts", () => {
	// Against the real pi-ai catalog: pi marks xhigh/max supported only
	// when the provider verified them (thinkingLevelMap), so these pin the
	// catalog facts the escalation ladder clamps against.
	const supported = createSupportedEfforts();

	it("reports haiku verifies nothing above high", () => {
		expect(supported("haiku")).toEqual(["low", "medium", "high"]);
	});

	it("reports sonnet and opus verify the full ladder (xhigh + max)", () => {
		expect(supported("sonnet")).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(supported("opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("reports luna's and sol's xhigh ceiling (no max)", () => {
		expect(supported("luna")).toEqual(["low", "medium", "high", "xhigh"]);
		expect(supported("sol")).toEqual(["low", "medium", "high", "xhigh"]);
	});

	it("reports astra verifies the full ladder through the overlay (catalog alone would stop at xhigh)", () => {
		expect(supported("astra")).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(buildEscalationLadder({ model: "astra", effort: "high" }, { supportedEfforts: supported })).toEqual([
			{ model: "astra", effort: "high" },
			{ model: "astra", effort: "xhigh" },
			{ model: "astra", effort: "max" },
		]);
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
