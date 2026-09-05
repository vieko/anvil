import type { Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { longCacheRetention, messageCost } from "../src/node/usage-cost.ts";

// Pricing pinned by the spec: a 1h cache write bills at 2x the model's input rate
// (Anthropic), a 5m write at the model's cacheWrite rate. pi-ai only applies the
// 2x when `cacheWrite1h` is set, which the Vercel AI Gateway path never populates
// (earendil-works/pi#9210) -- so anvil sets it itself under long retention.

const anthropic = {
	id: "claude-test",
	name: "test",
	api: "anthropic-messages",
	provider: "vercel-ai-gateway",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} as unknown as Model<any>;

const usage = (): Usage => ({
	input: 0,
	output: 1000,
	cacheRead: 100_000,
	cacheWrite: 10_000,
	totalTokens: 111_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("messageCost", () => {
	it("prices a long-retention Anthropic cache write at 2x input: 0.05 + 0.025 + 0.2", () => {
		expect(messageCost(anthropic, usage(), { PI_CACHE_RETENTION: "long" })).toBeCloseTo(0.275, 10);
	});

	it("prices a short-retention cache write at the model's cacheWrite rate: 0.05 + 0.025 + 0.125", () => {
		expect(messageCost(anthropic, usage(), {})).toBeCloseTo(0.2, 10);
		expect(messageCost(anthropic, usage(), { PI_CACHE_RETENTION: "short" })).toBeCloseTo(0.2, 10);
	});

	it("leaves a non-Anthropic api at the reported cacheWrite1h split even under long retention", () => {
		const openai = { ...anthropic, api: "openai-responses" } as Model<any>;
		expect(messageCost(openai, usage(), { PI_CACHE_RETENTION: "long" })).toBeCloseTo(0.2, 10);
		// A provider that does report the 1h split keeps it.
		const reported = { ...usage(), cacheWrite1h: 10_000 };
		expect(messageCost(openai, reported, {})).toBeCloseTo(0.275, 10);
	});

	it("is undefined (never 0) for a model without a cost table", () => {
		const { cost: _cost, ...uncosted } = anthropic as Model<any> & { cost: unknown };
		expect(messageCost(uncosted as Model<any>, usage(), { PI_CACHE_RETENTION: "long" })).toBeUndefined();
	});

	it("does not mutate the message usage it prices", () => {
		const u = usage();
		messageCost(anthropic, u, { PI_CACHE_RETENTION: "long" });
		expect(u.cacheWrite1h).toBeUndefined();
		expect(u.cost.total).toBe(0);
	});
});

describe("longCacheRetention", () => {
	it("is true only for PI_CACHE_RETENTION=long, as pi-ai resolves it", () => {
		expect(longCacheRetention({ PI_CACHE_RETENTION: "long" })).toBe(true);
		expect(longCacheRetention({ PI_CACHE_RETENTION: "short" })).toBe(false);
		expect(longCacheRetention({})).toBe(false);
	});
});
