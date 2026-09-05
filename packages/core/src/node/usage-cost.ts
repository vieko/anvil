import type { Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";

/** Marker api for the one provider that bills 1h prompt-cache writes at 2x input. */
const ANTHROPIC_API = "anthropic-messages";

/** Whether pi will request 1h ("long") prompt-cache retention: `PI_CACHE_RETENTION=long`, as pi-ai resolves it. */
export function longCacheRetention(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_CACHE_RETENTION === "long";
}

/**
 * USD cost of one assistant message's usage against the resolved model's price
 * table, or undefined when the model has none. Anthropic bills 1h cache writes
 * at 2x the input rate; pi-ai's `calculateCost` applies that only when
 * `cacheWrite1h` is set, and through the Vercel AI Gateway it never is
 * (earendil-works/pi#9210). With long retention every write is a 1h write, so
 * anvil marks them all before pricing rather than trusting `usage.cost`.
 */
export function messageCost(model: Model<any>, usage: Usage, env: NodeJS.ProcessEnv = process.env): number | undefined {
	if (!model.cost) return undefined;
	const priced: Usage = { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	if (longCacheRetention(env) && model.api === ANTHROPIC_API) priced.cacheWrite1h = usage.cacheWrite;
	return calculateCost(model, priced).total;
}
