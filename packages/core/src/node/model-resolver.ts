import type { Model } from "@earendil-works/pi-ai";
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai";
import type { ModelResolver } from "./pi-agent.ts";

// Loosely-typed views of pi-ai's registry. The exported getModel/getModels are
// generically typed against literal provider/id keys; anvil resolves dynamic
// strings, so we look up against the runtime registry directly.
const lookupModel = getModel as unknown as (provider: string, modelId: string) => Model<any> | undefined;
const lookupModels = getModels as unknown as (provider: string) => Model<any>[];

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
	sonnet: "vercel-ai-gateway:anthropic/claude-sonnet-4.6",
	opus: "vercel-ai-gateway:anthropic/claude-opus-4.8",
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
	for (const provider of getProviders()) {
		const model = lookupModels(provider).find((m) => m.id === id);
		if (model) return model;
	}
	return undefined;
}

function hint(name: string): string {
	return (
		`Use a known pi-ai model id, a "provider:model-id" string, or register an alias ` +
		`for "${name}" via createModelResolver({ aliases }).`
	);
}
