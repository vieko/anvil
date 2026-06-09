import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildEscalationLadder } from "../src/index.ts";
import { createModelResolver, DEFAULT_MODEL_ALIASES } from "../src/node/model-resolver.ts";

describe("createModelResolver", () => {
	it("defaults to the Vercel AI Gateway for the logical aliases", () => {
		const resolve = createModelResolver();
		const opus = resolve({ model: "opus" });
		expect(opus.provider).toBe("vercel-ai-gateway");
		expect(opus.id).toBe("anthropic/claude-opus-4.8");
		expect(resolve({ model: "sonnet" }).id).toBe("anthropic/claude-sonnet-4.6");
		expect(resolve({ model: "haiku" }).id).toBe("anthropic/claude-haiku-4.5");
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
		expect(resolve({ model: "opus" }).id).toBe("anthropic/claude-opus-4.8"); // gateway defaults still present
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
