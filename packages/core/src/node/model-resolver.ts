import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { EFFORT_LADDER, type Effort, type SupportedEfforts } from "../index.ts";
import type { ModelResolver } from "./pi-agent.ts";

// Loosely-typed views of pi-ai's built-in catalog. The exported
// getBuiltinModel/getBuiltinModels are generically typed against literal
// provider/id keys; anvil resolves dynamic strings, so we look up against the
// runtime catalog directly.
const lookupModel = getBuiltinModel as unknown as (provider: string, modelId: string) => Model<any> | undefined;
const lookupModels = getBuiltinModels as unknown as (provider: string) => Model<any>[];
const lookupProviders = getBuiltinProviders as unknown as () => string[];

export interface ModelResolverOptions {
	/** Logical name -> a "provider:model-id" string or a concrete pi-ai Model. */
	aliases?: Record<string, string | Model<any>>;
	/** Provider assumed for a bare model id (no "provider:" prefix). Default "anthropic". */
	defaultProvider?: string;
	/** Replace the built-in aliases entirely instead of merging over them. */
	replaceDefaults?: boolean;
}

/**
 * Default logical aliases. anvil routes through the **Vercel AI Gateway** by
 * default (one key across providers, with gateway-side spend/observability/
 * fallbacks) — the logical names map to Anthropic's Claude tier on the gateway,
 * which is also what the escalation ladder emits (sonnet -> opus). Fully
 * overridable: anvil stays provider-agnostic through this resolver seam (e.g.
 * `createModelResolver({ defaultProvider: "anthropic", aliases: {...} })` for
 * direct provider access).
 */
export const DEFAULT_MODEL_ALIASES: Record<string, string> = {
	haiku: "vercel-ai-gateway:anthropic/claude-haiku-4.5",
	sonnet: "vercel-ai-gateway:anthropic/claude-sonnet-5",
	opus: "vercel-ai-gateway:anthropic/claude-opus-5",
	luna: "vercel-ai-gateway:openai/gpt-5.6-luna",
};

/**
 * Build a {@link ModelResolver}: map anvil's logical model strings (including the
 * aliases the escalation ladder emits) to concrete pi-ai Models.
 *
 * Resolution order for a name:
 *  1. alias -> a concrete Model (returned) or a "provider:model-id" string
 *  2. "provider:model-id" -> registry lookup
 *  3. bare id -> defaultProvider, then a search across all providers
 *  4. otherwise: throw with an actionable message
 *
 * Results are cached by input string (resolution is pure registry lookup).
 */
export function createModelResolver(options: ModelResolverOptions = {}): ModelResolver {
	const aliases = options.replaceDefaults ? { ...options.aliases } : { ...DEFAULT_MODEL_ALIASES, ...options.aliases };
	const defaultProvider = options.defaultProvider ?? "vercel-ai-gateway";
	const cache = new Map<string, Model<any>>();

	return ({ model }) => {
		let resolved = cache.get(model);
		if (!resolved) {
			resolved = resolveOne(model, aliases, defaultProvider);
			cache.set(model, resolved);
		}
		return resolved;
	};
}

function resolveOne(name: string, aliases: Record<string, string | Model<any>>, defaultProvider: string): Model<any> {
	const alias = aliases[name];
	if (alias !== undefined && typeof alias !== "string") return alias;
	const spec = typeof alias === "string" ? alias : name;

	if (spec.includes(":")) {
		const sep = spec.indexOf(":");
		const provider = spec.slice(0, sep);
		const id = spec.slice(sep + 1);
		const model = lookupModel(provider, id);
		if (model) return model;
		throw new Error(`anvil: unknown model "${spec}". ${hint(name)}`);
	}

	const direct = lookupModel(defaultProvider, spec);
	if (direct) return direct;
	const found = findById(spec);
	if (found) return found;
	throw new Error(`anvil: could not resolve model "${name}". ${hint(name)}`);
}

function findById(id: string): Model<any> | undefined {
	for (const provider of lookupProviders()) {
		const model = lookupModels(provider).find((m) => m.id === id);
		if (model) return model;
	}
	return undefined;
}

/**
 * Build a {@link SupportedEfforts} capability seam from a resolver: resolve
 * the logical name against pi-ai's catalog and report which anvil efforts the
 * model verifies (pi's thinking levels intersected with {@link EFFORT_LADDER};
 * pi's `off`/`minimal` have no anvil equivalent and drop out). An unresolvable
 * name yields `undefined` — no capability info, no clamping — rather than an
 * error: the ladder must stay buildable for models only the caller's own
 * resolver knows about.
 *
 * Pass the same resolver the agent dispatches with (or share the default) so
 * the ladder clamps against the model that will actually run.
 */
export function createSupportedEfforts(resolve: ModelResolver = createModelResolver()): SupportedEfforts {
	const cache = new Map<string, readonly Effort[] | undefined>();
	return (model) => {
		if (cache.has(model)) return cache.get(model);
		let result: readonly Effort[] | undefined;
		try {
			const levels = getSupportedThinkingLevels(resolve({ model }));
			result = EFFORT_LADDER.filter((effort) => levels.includes(effort));
		} catch {
			result = undefined;
		}
		cache.set(model, result);
		return result;
	};
}

function hint(name: string): string {
	return (
		`Use a known pi-ai model id, a "provider:model-id" string, or register an alias ` +
		`for "${name}" via createModelResolver({ aliases }).`
	);
}
