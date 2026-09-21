import type { Api, Model, Models, ThinkingLevelMap, VercelGatewayRouting } from "@earendil-works/pi-ai";
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
	fable: "vercel-ai-gateway:anthropic/claude-fable-5.1",
	luna: "vercel-ai-gateway:openai/gpt-5.6-luna",
	terra: "vercel-ai-gateway:openai/gpt-5.6-terra",
	glm: "vercel-ai-gateway:zai/glm-5.3",
	// Opt-in strong base (1M+ context, OpenAI's strengths); not the default strong
	// tier: it matches fable on input/output/cache-write but its cache-read is 4x,
	// which is the criterion that picked fable over opus.
	astra: "vercel-ai-gateway:openai/gpt-6-astra",
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
		if (model) return withGatewayCompat(model);
		throw new Error(`anvil: unknown model "${spec}". ${hint(name)}`);
	}

	const direct = lookupModel(defaultProvider, spec);
	if (direct) return withGatewayCompat(direct);
	const found = findById(spec);
	if (found) return withGatewayCompat(found);
	throw new Error(`anvil: could not resolve model "${name}". ${hint(name)}`);
}

/** Models that verify per-turn effort changes through the gateway (see {@link withGatewayCompat}). */
const MID_CONVO_EFFORT_MODELS = new Set(["anthropic/claude-opus-5", "anthropic/claude-fable-5.1"]);

/**
 * Models whose native `anthropic` catalog entry accepts mid-conversation
 * system messages and tool additions/removals (see {@link withGatewayCompat}).
 */
const MID_CONVO_SYSTEM_MODELS = new Set([
	"anthropic/claude-fable-5",
	"anthropic/claude-fable-5.1",
	"anthropic/claude-opus-4.8",
	"anthropic/claude-opus-5",
]);

/** The one `openai/*` gateway model anvil overlays (see {@link withGatewayCompat}). */
const ASTRA_GATEWAY_ID = "openai/gpt-6-astra";

/** Astra's full effort map; pi's catalog entry names only `xhigh`. */
const ASTRA_THINKING_LEVELS: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/**
 * anvil-owned compat overlay for models on the Vercel AI Gateway, as a clone so
 * the shared registry object is never mutated.
 *
 * Every `anthropic/*` model is fenced to Anthropic's own Messages transport
 * (`only`, not `order`): the gateway can otherwise serve a run from
 * `anthropic`, `bedrock`, `claudeaws`, or `vertexAnthropic`, and a run that
 * silently moves backends pays a full-prefix cache rewrite at 1h write rates
 * and loses the beta-header guarantees below. An unattended golem is better
 * served by a loud provider error the retry policy can handle. Opus 5 and
 * Fable 5.1 additionally get `supportsMidConvoEffort`, which is what makes the
 * escalation ladder's effort climb safe on one resumed session (per-turn
 * effort persisted, effort-only system messages rebuilt on replay, stale
 * signed-thinking prefixes dropped instead of 400ing). pi-ai's catalog enables
 * it only for the native `anthropic` provider, so anvil owns it for the
 * gateway route.
 *
 * Two more flags the native `anthropic` entries carry and the gateway entries
 * omit, mirrored here for the same reason (the pin makes the transport the
 * real Messages API): `supportsStrictTools` on every Claude model, without
 * which anvil's `strict: "prefer"` tools never go out strict and sonnet-class
 * models hand back malformed edit arguments (earendil-works/pi#9212); and
 * `supportsMidConvoSystemMessages` + `supportsMidConvoToolChanges` on the
 * models that have them natively, so a prompt-section or tool-set change
 * between turns is a small system patch instead of a full-prefix rewrite
 * (measured on fable-5.1 via the gateway: cacheWrite 14337 -> 50).
 *
 * GPT-6 Astra is fenced to OpenAI's route and gets `forceAdaptiveThinking`
 * plus the full `low..max` level map: on the gateway pi only sends
 * `output_config.effort` for this model under adaptive thinking, and only the
 * levels the map names are selectable (the catalog names just `xhigh`).
 * `supportsMidConvoEffort` stays Claude-only.
 *
 * The routing pin is enforced by PiAgent's `before_payload` hook via
 * {@link applyGatewayRouting}, because pi-ai's anthropic-messages adapter does
 * not send `vercelGatewayRouting` (only openai-completions does; see
 * earendil-works/pi#9211). The compat field is the declaration; the hook is
 * what writes `providerOptions.gateway` into the request body.
 */
export function withGatewayCompat<TModel extends Model<any>>(model: TModel): TModel {
	if (model.provider !== "vercel-ai-gateway") return model;
	// Cast: `Model<any>["compat"]` collapses to `never` for an unresolved api.
	if (model.id.startsWith("anthropic/")) {
		return {
			...model,
			compat: {
				...model.compat,
				vercelGatewayRouting: { only: ["anthropic"] },
				supportsStrictTools: true,
				...(MID_CONVO_EFFORT_MODELS.has(model.id) ? { supportsMidConvoEffort: true } : {}),
				...(MID_CONVO_SYSTEM_MODELS.has(model.id)
					? { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }
					: {}),
			} as TModel["compat"],
		};
	}
	if (model.id === ASTRA_GATEWAY_ID) {
		return {
			...model,
			thinkingLevelMap: { ...ASTRA_THINKING_LEVELS },
			compat: {
				...model.compat,
				vercelGatewayRouting: { only: ["openai"] },
				forceAdaptiveThinking: true,
			} as TModel["compat"],
		};
	}
	return model;
}

/**
 * The `before_payload` hook body: write `compat.vercelGatewayRouting` into the
 * request as `providerOptions.gateway.{only,order}`, which the gateway's
 * `/v1/messages` honors (the Anthropic SDK forwards the extra body key). pi's
 * anthropic-messages adapter never sends it itself (earendil-works/pi#9211).
 *
 * Returns `undefined` (leave the payload alone) for non-gateway models, models
 * with no `only`/`order` pin, non-object payloads, and payloads that already
 * carry `providerOptions.gateway` -- so this is a no-op the day pi's adapter
 * sends it. Never mutates `payload`: a new object is returned.
 */
export function applyGatewayRouting(model: Model<any>, payload: unknown): unknown | undefined {
	if (model.provider !== "vercel-ai-gateway") return undefined;
	// Cast: `Model<any>["compat"]` collapses to `never` for an unresolved api.
	const routing = (model.compat as { vercelGatewayRouting?: VercelGatewayRouting } | undefined)?.vercelGatewayRouting;
	if (routing?.only === undefined && routing?.order === undefined) return undefined;
	if (!isRecord(payload)) return undefined;
	const existing = isRecord(payload.providerOptions) ? payload.providerOptions : undefined;
	if (existing?.gateway !== undefined) return undefined;
	const gateway: VercelGatewayRouting = {};
	if (routing.only !== undefined) gateway.only = [...routing.only];
	if (routing.order !== undefined) gateway.order = [...routing.order];
	return { ...payload, providerOptions: { ...existing, gateway } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The same overlay, applied wherever **pi** resolves a model. The harness keeps
 * only a `{ provider, modelId }` identity and re-resolves every request (and
 * every `setModel`) through this collection, so a resolver-only overlay would
 * never reach the provider: this view is what actually carries
 * {@link withGatewayCompat} into the request.
 */
export function withGatewayCompatModels(models: Models): Models {
	return new Proxy(models, {
		get(target, property) {
			if (property === "getModel") {
				return (provider: string, id: string): Model<Api> | undefined => {
					const model = target.getModel(provider, id);
					return model === undefined ? undefined : withGatewayCompat(model);
				};
			}
			if (property === "getModels") {
				return (provider?: string): readonly Model<Api>[] => target.getModels(provider).map(withGatewayCompat);
			}
			// Bind to the target, never the proxy: these collections hold private
			// state that a rebound `this` cannot reach.
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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
