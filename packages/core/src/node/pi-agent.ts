import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Agent, AgentDispatch, AgentEventSink, AgentResult, Effort, ModelEffort, TokenUsage } from "../index.ts";
import type { ExecEnv } from "./exec-env.ts";
import { applyGatewayRouting, createModelResolver } from "./model-resolver.ts";
import { type AnvilTool, defaultTools } from "./tools.ts";
import { messageCost } from "./usage-cost.ts";

/** Resolve anvil's (model, effort) to a concrete pi-ai Model. The provider-agnostic seam. */
export type ModelResolver = (config: ModelEffort) => Model<any>;

/** Agent-level retry for transient provider failures (rate limits, 5xx, dropped connections). */
export interface RetryPolicy {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface PiAgentOptions {
	/** Execution environment the agent's tools operate in (e.g. `WorktreeWorkspace.env`). Its cwd is the session cwd. */
	env: ExecEnv;
	/** Map anvil's (model, effort) to a pi-ai Model. Default: {@link createModelResolver}(). */
	resolveModel?: ModelResolver;
	/** Tools the agent may call. Default: anvil's read/edit/write/bash over `env`. Pass `[]` to disable. */
	tools?: AnvilTool[];
	/** System prompt. Default: a minimal outcome-focused prompt. */
	systemPrompt?: string;
	/**
	 * Auth + request runtime for every model call. Default: {@link createHermeticModelRuntime}()
	 * (env-based provider keys only: no `~/.pi` credentials, no models.json, no
	 * network catalog refresh). Tests inject one with a faux provider registered.
	 */
	modelRuntime?: ModelRuntime;
	/** Persist each session's transcript as JSONL under this (absolute) root. Omit for in-memory sessions. */
	sessionsRoot?: string;
	/** Directory name used to bucket persisted sessions under `sessionsRoot`. Default: `env.cwd`. */
	sessionCwd?: string;
	/** Live activity sink: receives tool-call lifecycle events during a dispatch. */
	onActivity?: AgentEventSink;
	/**
	 * Map anvil Effort to pi ThinkingLevel. Default: identity (anvil's Effort is
	 * a subset of pi's ThinkingLevel). The result is clamped to the resolved
	 * model's verified levels before dispatch.
	 */
	thinkingLevel?: (effort: Effort | undefined) => ThinkingLevel | undefined;
	/** Agent-level retry policy. Default: {@link DEFAULT_RETRY_POLICY}. */
	retry?: RetryPolicy;
}

/** Default {@link RetryPolicy} for every {@link PiAgent}, overridable via {@link PiAgentOptions.retry}. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

const DEFAULT_SYSTEM_PROMPT =
	"You are an autonomous engineer. Achieve the requested outcome by editing files and running commands. " +
	"Verification is performed independently after you finish, so make the change real and correct — do not " +
	"fake, skip, or work around checks. Repository policy configuration is part of the outcome, not an obstacle: " +
	"never bypass it (e.g. .npmrc release-age cooldowns or registry settings, lockfile constraints, lint/type " +
	"ignores, git hooks). If a policy blocks the outcome, stop and report the blocker instead.";

/**
 * The pi agent dir handed to the SDK. Never created or read: every resource the
 * SDK would discover there is switched off or supplied in memory, so a golem
 * never picks up the host's extensions, skills, settings, or credentials.
 */
const HERMETIC_AGENT_DIR = join(tmpdir(), "anvil-pi-agent-dir-unused");

/**
 * A model runtime that resolves provider keys from the environment only
 * (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, ...): an empty in-memory
 * credential store instead of `~/.pi/agent/auth.json`, no models.json, and no
 * network catalog refresh.
 */
export function createHermeticModelRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
}

/**
 * Writes the gateway routing pin into every provider request (see
 * {@link applyGatewayRouting}). `ctx.model` is the session's current model --
 * the same object the request is built from, so it carries the resolver's
 * gateway compat overlay. Loaded as an inline factory, which the resource
 * loader appends after discovery, so `noExtensions` does not drop it.
 */
const GATEWAY_ROUTING_EXTENSION: InlineExtension = {
	name: "anvil-gateway-routing",
	hidden: true,
	factory: (pi) => {
		pi.on("before_provider_request", (event, ctx) => {
			const model = ctx.model;
			return model === undefined ? undefined : applyGatewayRouting(model, event.payload);
		});
	},
};

/** One live session plus the per-attempt bash environment its bash tool reads at call time. */
interface SessionRuntime {
	session: AgentSession;
	bashEnv: Record<string, string>;
}

/**
 * The {@link Agent} seam, backed by the pi coding-agent SDK (`createAgentSession`).
 *
 * One `dispatch` == one complete agentic turn (pi runs tool use, including its
 * own transient-failure retries, until the model stops), after which anvil's
 * gate verifies the result. Only a run that settles un-aborted with a final
 * assistant message that did not error counts as work done. PiAgent owns none
 * of the verify/retry policy -- that is `runToGate`'s job. It is
 * provider-agnostic: the caller supplies `resolveModel`, so the same engine can
 * run the cheapest capable model and escalate across providers.
 *
 * Sessions are hermetic (see AGENTS.md "Substrate"): no host extensions,
 * skills, prompt templates, context files, settings, or credentials. Settings
 * are in memory: compaction off (an overflow fails the dispatch and the gate
 * and ladder decide, rather than summarizing gate errors away), cache warming
 * off (its refresh usage would bypass the turn accounting below), install
 * telemetry off.
 *
 * Model overlay coupling: the session sends requests with the exact Model
 * object it was given, which is how {@link withGatewayCompat}'s clone reaches
 * the provider. pi swaps it for a registry lookup only when an extension
 * registers a provider or virtual model (`_refreshCurrentModelFromRegistry`);
 * hermetic sessions load none, and a test pins the overlay after create and
 * after `setModel`.
 */
export class PiAgent implements Agent {
	private readonly options: PiAgentOptions;
	private readonly resolveModel: ModelResolver;
	private modelRuntime: Promise<ModelRuntime> | undefined;
	/** Sessions created by this agent, so a `resume` continues the same transcript. */
	private readonly runtimes = new Map<string, SessionRuntime>();

	constructor(options: PiAgentOptions) {
		this.options = options;
		this.resolveModel = options.resolveModel ?? createModelResolver();
		if (options.modelRuntime) this.modelRuntime = Promise.resolve(options.modelRuntime);
	}

	async dispatch(d: AgentDispatch): Promise<AgentResult> {
		const model = this.resolveModel(d.config);

		// Clamp the requested thinking level to what the resolved model verifies
		// (pi-ai catalog metadata): the correctness layer of issue #31 -- anvil
		// never sends an unverified level, no matter who built the ladder. With no
		// effort requested, a new session takes the SDK's default level (clamped)
		// and a resumed one keeps its current level; runToGate always requests one.
		const requested = (this.options.thinkingLevel ?? defaultThinkingLevel)(d.config.effort);
		const thinkingLevel = requested === undefined ? undefined : clampThinkingLevel(model, requested);

		const runtime = await this.resolveRuntime(d, model, thinkingLevel);
		runtime.bashEnv = bashEnvFor(d);
		const { session } = runtime;
		const sessionId = session.sessionId;

		// The run's own final assistant message, captured from the turn stream.
		// Usage is the SUM across every turn_end (#12): a dispatch with tool calls
		// runs several assistant turns before its final answer, and the final
		// message alone under-reports the dispatch's actual spend by ~99%. Cost is
		// priced per message against the model anvil resolved (not pi's own
		// `usage.cost`, see usage-cost.ts) and left undefined when it has no table.
		let finalMessage: AssistantMessage | undefined;
		let settled: { aborted: boolean } | undefined;
		const totalUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_end" && event.message.role === "assistant") {
				const message = event.message;
				finalMessage = message;
				totalUsage.input += message.usage.input;
				totalUsage.output += message.usage.output;
				totalUsage.cacheRead += message.usage.cacheRead;
				totalUsage.cacheWrite = (totalUsage.cacheWrite ?? 0) + message.usage.cacheWrite;
				const cost = messageCost(model, message.usage);
				if (cost !== undefined) totalUsage.cost = (totalUsage.cost ?? 0) + cost;
			} else if (event.type === "agent_settled") {
				settled = { aborted: event.aborted };
			}
			this.forwardActivity(event);
		});

		const onAbort = () => void session.abort().catch(() => {});
		try {
			if (d.signal) {
				if (d.signal.aborted) throw new Error("anvil: the dispatch was aborted before it started.");
				d.signal.addEventListener("abort", onAbort, { once: true });
			}
			// expandPromptTemplates: false -- an outcome that starts with "/" is text,
			// never a slash command or template.
			await session.prompt(d.prompt, { expandPromptTemplates: false, source: "rpc" });
			const message = completedMessage(settled, finalMessage);
			return { text: extractText(message), usage: totalUsage, sessionId };
		} finally {
			d.signal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}
	}

	/**
	 * The session this dispatch runs on: the resumed one when `resume` names a
	 * session this agent owns, otherwise a fresh one. A resumed session is
	 * re-pointed at this attempt's model and effort, so the escalation ladder
	 * climbs inside one cache-warm conversation. The tool set never changes:
	 * per-attempt values reach the bash tool through {@link SessionRuntime.bashEnv}.
	 */
	private async resolveRuntime(
		d: AgentDispatch,
		model: Model<any>,
		thinkingLevel: ThinkingLevel | undefined,
	): Promise<SessionRuntime> {
		const existing = d.resume ? this.runtimes.get(d.resume) : undefined;
		if (existing) {
			const { session } = existing;
			// Identity, not provider/id: the session must hold exactly the resolved
			// object, because that object carries the gateway compat overlay.
			if (session.model !== model) await session.setModel(model);
			if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
			return existing;
		}

		const cwd = this.options.env.cwd;
		const runtime: SessionRuntime = { session: undefined as unknown as AgentSession, bashEnv: {} };
		const tools = this.options.tools ?? defaultTools(this.options.env, () => runtime.bashEnv);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { ...(this.options.retry ?? DEFAULT_RETRY_POLICY) },
			cacheWarming: "off",
			enableInstallTelemetry: false,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: HERMETIC_AGENT_DIR,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			appendSystemPromptOverride: () => [],
			extensionFactories: [GATEWAY_ROUTING_EXTENSION],
		});
		await resourceLoader.reload();
		const sessionManager = this.options.sessionsRoot
			? SessionManager.create(cwd, join(this.options.sessionsRoot, sessionBucket(this.options.sessionCwd ?? cwd)))
			: SessionManager.inMemory(cwd);

		const { session } = await createAgentSession({
			cwd,
			agentDir: HERMETIC_AGENT_DIR,
			modelRuntime: await this.getModelRuntime(),
			model,
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			noTools: "builtin",
			customTools: tools,
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		runtime.session = session;
		this.runtimes.set(session.sessionId, runtime);
		return runtime;
	}

	private getModelRuntime(): Promise<ModelRuntime> {
		this.modelRuntime ??= createHermeticModelRuntime();
		return this.modelRuntime;
	}

	/** Forward tool lifecycle and reasoning events to the activity sink, when there is one. */
	private forwardActivity(event: AgentSessionEvent): void {
		const sink = this.options.onActivity;
		if (!sink) return;
		if (event.type === "tool_execution_start") {
			sink({ kind: "tool-start", tool: event.toolName, summary: summarizeToolArgs(event.args) });
		} else if (event.type === "tool_execution_end") {
			sink({ kind: "tool-end", tool: event.toolName, ok: !event.isError });
		} else if (event.type === "message_update") {
			// Reasoning is forwarded once per segment, on `thinking_end` (the
			// complete block), rather than as token deltas: an append-only stream
			// reads cleaner as whole thoughts.
			const inner = event.assistantMessageEvent;
			if (inner.type === "thinking_end" && inner.content.trim()) {
				sink({ kind: "reasoning", text: inner.content });
			}
		}
	}
}

/**
 * The one success path out of a dispatch: the run settled without an abort and
 * its final assistant message neither errored nor was aborted. Everything else
 * -- no settle (an input handler consumed the prompt), an aborted run, an
 * errored final turn (after pi's own retries), or no assistant turn at all --
 * throws, so the dispatch surfaces as a failed attempt instead of a silent
 * success. The gate is the sole authority on "done"; a half-finished run must
 * never be able to fake progress.
 */
function completedMessage(
	settled: { aborted: boolean } | undefined,
	finalMessage: AssistantMessage | undefined,
): AssistantMessage {
	if (settled === undefined) throw new Error("anvil: the agent run did not start or did not settle.");
	if (settled.aborted) throw new Error("anvil: the agent run was aborted.");
	if (finalMessage === undefined) throw new Error("anvil: the agent run completed without a final assistant message.");
	if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
		const detail = finalMessage.errorMessage ? `: ${finalMessage.errorMessage}` : "";
		throw new Error(`anvil: the agent run did not complete (${finalMessage.stopReason}${detail}).`);
	}
	return finalMessage;
}

/** Directory name for a cwd's persisted sessions: the path with separators flattened. */
function sessionBucket(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** A one-line summary of a tool call: the command (bash) or the path (read/edit/write). */
function summarizeToolArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	if (typeof record.command === "string") return truncateSummary(record.command);
	if (typeof record.path === "string") return record.path;
	return undefined;
}

function truncateSummary(value: string): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

/** Concatenate the assistant message's text blocks. */
function extractText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * Environment variables exposed to every command the agent runs via the bash
 * tool for this dispatch: the recorded run id + current attempt number (the
 * issue #32 invariant), plus the model/effort in progress for this attempt.
 * `undefined` values (e.g. no `runId`/`attempt` supplied, or an unset effort)
 * are omitted rather than stringified.
 */
function bashEnvFor(d: AgentDispatch): Record<string, string> {
	const env: Record<string, string> = { ANVIL_MODEL: d.config.model };
	if (d.runId !== undefined) env.ANVIL_RUN_ID = d.runId;
	if (d.attempt !== undefined) env.ANVIL_ATTEMPT = String(d.attempt);
	if (d.config.effort !== undefined) env.ANVIL_EFFORT = d.config.effort;
	return env;
}

/**
 * anvil Effort -> pi ThinkingLevel: identity. Every anvil effort has a pi
 * equivalent -- the assignability of this return is the compile-time pin on
 * that subset relationship (a runtime pin lives in model-resolver.test.ts).
 */
function defaultThinkingLevel(effort: Effort | undefined): ThinkingLevel | undefined {
	return effort;
}
