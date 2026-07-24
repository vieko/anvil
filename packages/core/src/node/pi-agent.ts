import type { AgentHarnessEvent, AgentTool, ExecutionEnv, Session, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AgentHarness, InMemorySessionRepo, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Models, RetryPolicy } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
	Agent,
	AgentActivity,
	AgentDispatch,
	AgentEventSink,
	AgentResult,
	Effort,
	ModelEffort,
} from "../index.ts";
import { createModelResolver } from "./model-resolver.ts";
import { defaultTools } from "./tools.ts";

/** Resolve anvil's (model, effort) to a concrete pi-ai Model. The provider-agnostic seam. */
export type ModelResolver = (config: ModelEffort) => Model<any>;

export interface PiAgentOptions {
	/** Execution environment the agent operates in (e.g. `WorktreeWorkspace.env`). */
	env: ExecutionEnv;
	/** Map anvil's (model, effort) to a pi-ai Model. Default: {@link createModelResolver}(). */
	resolveModel?: ModelResolver;
	/** Tools the agent may call. Default: anvil's read/edit/write/bash over `env`. Pass `[]` to disable. */
	tools?: AgentTool[];
	/** System prompt. Default: a minimal outcome-focused prompt. */
	systemPrompt?: string;
	/**
	 * Provider collection used for all model requests; auth (API keys/headers)
	 * resolves through each provider's own auth. Default: {@link builtinModels}(),
	 * every built-in pi-ai provider with env-based auth (covers the Vercel AI
	 * Gateway's `AI_GATEWAY_API_KEY` and Anthropic's OAuth-token precedence).
	 */
	models?: Models;
	/**
	 * Persist each run's transcript as JSONL under this (absolute) root, using
	 * `env` as the filesystem. Omit for an in-memory session discarded on exit.
	 */
	sessionsRoot?: string;
	/** cwd used to bucket persisted sessions (typically the workspace cwd). Default ".". */
	sessionCwd?: string;
	/** Live activity sink: receives tool-call lifecycle events during a dispatch. */
	onActivity?: AgentEventSink;
	/**
	 * Map anvil Effort to pi ThinkingLevel. Default: identity (anvil's Effort is
	 * a subset of pi's ThinkingLevel as of pi-ai 0.82, which added `max`). The
	 * result is clamped to the resolved model's verified levels before dispatch.
	 */
	thinkingLevel?: (effort: Effort | undefined) => ThinkingLevel | undefined;
	/**
	 * Retry policy for the harness's provider requests. Default:
	 * {@link DEFAULT_RETRY_POLICY} (enabled, 3 retries, 2s base delay,
	 * exponential backoff) -- transient provider/transport failures (rate
	 * limits, 5xx, dropped connections) get retried instead of surfacing
	 * immediately as a failed dispatch.
	 */
	retry?: RetryPolicy;
}

/** Default {@link RetryPolicy} for every {@link PiAgent}, overridable via {@link PiAgentOptions.retry}. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

const DEFAULT_SYSTEM_PROMPT =
	"You are an autonomous engineer. Achieve the requested outcome by editing files and running commands. " +
	"Verification is performed independently after you finish, so make the change real and correct — do not " +
	"fake, skip, or work around checks.";

/**
 * The {@link Agent} seam, backed by pi-agent-core's `AgentHarness`.
 *
 * One `dispatch` == one complete agentic turn (the harness runs tool use until
 * the model stops), after which anvil's gate verifies the result. PiAgent owns
 * none of the verify/retry policy — that is `runToGate`'s job. It is
 * provider-agnostic: the caller supplies `resolveModel`, so the same engine can
 * run the cheapest capable model and escalate across providers.
 */
export class PiAgent implements Agent {
	private readonly options: PiAgentOptions;
	private readonly resolveModel: ModelResolver;
	private readonly models: Models;
	private readonly createSession: () => Promise<Session>;
	/** Sessions created by this agent, so a `resume` continues the same transcript. */
	private readonly sessions = new Map<string, Session>();

	constructor(options: PiAgentOptions) {
		this.options = options;
		this.resolveModel = options.resolveModel ?? createModelResolver();
		this.models = options.models ?? builtinModels();
		if (options.sessionsRoot) {
			const repo = new JsonlSessionRepo({ fs: options.env, sessionsRoot: options.sessionsRoot });
			const cwd = options.sessionCwd ?? ".";
			this.createSession = () => repo.create({ cwd });
		} else {
			const repo = new InMemorySessionRepo();
			this.createSession = () => repo.create({});
		}
	}

	async dispatch(d: AgentDispatch): Promise<AgentResult> {
		const model = this.resolveModel(d.config);
		const session = await this.resolveSession(d.resume);
		const sessionId = (await session.getMetadata()).id;
		this.sessions.set(sessionId, session);

		// Clamp the requested thinking level to what the resolved model verifies
		// (pi-ai catalog metadata): the correctness layer of issue #31 -- anvil
		// never sends an unverified level, no matter who built the ladder. An
		// undefined level (no effort requested) stays undefined: provider default.
		const requested = (this.options.thinkingLevel ?? defaultThinkingLevel)(d.config.effort);
		const thinkingLevel = requested === undefined ? undefined : clampThinkingLevel(model, requested);

		const harness = new AgentHarness({
			session,
			models: this.models,
			model,
			tools: this.options.tools ?? defaultTools(this.options.env, bashEnvFor(d)),
			systemPrompt: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			thinkingLevel,
			retry: this.options.retry ?? DEFAULT_RETRY_POLICY,
		});

		const onAbort = () => void harness.abort();
		if (d.signal) {
			if (d.signal.aborted) await harness.abort();
			else d.signal.addEventListener("abort", onAbort, { once: true });
		}

		const sink = this.options.onActivity;
		const unsubscribe = sink ? harness.subscribe((event) => forwardActivity(event, sink)) : undefined;

		try {
			const message = await harness.prompt(d.prompt);
			return {
				text: extractText(message),
				usage: {
					input: message.usage.input,
					output: message.usage.output,
					cacheRead: message.usage.cacheRead,
				},
				sessionId,
			};
		} finally {
			d.signal?.removeEventListener("abort", onAbort);
			unsubscribe?.();
		}
	}

	private async resolveSession(resume?: string): Promise<Session> {
		if (resume) {
			const existing = this.sessions.get(resume);
			if (existing) return existing;
		}
		return this.createSession();
	}
}

/**
 * Translate a pi harness event into an anvil {@link AgentActivity}, forwarding
 * tool-call lifecycle and the reasoning trace to the sink. The sink (the
 * surface) decides which kinds to render — reasoning is gated behind an opt-in,
 * so emitting it here is free when nobody asks for it. Reasoning is forwarded
 * once per segment, on `thinking_end` (the complete block), rather than as
 * token deltas: an append-only stream reads cleaner as whole thoughts. Text and
 * turn lifecycle remain ignored.
 */
function forwardActivity(event: AgentHarnessEvent, sink: AgentEventSink): void {
	switch (event.type) {
		case "tool_execution_start":
			sink({ kind: "tool-start", tool: event.toolName, summary: summarizeToolArgs(event.args) });
			break;
		case "tool_execution_end":
			sink({ kind: "tool-end", tool: event.toolName, ok: !event.isError });
			break;
		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (inner.type === "thinking_end" && inner.content.trim()) {
				sink({ kind: "reasoning", text: inner.content });
			}
			break;
		}
	}
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
 * anvil Effort -> pi ThinkingLevel: identity. pi-ai 0.82 added `max` to the
 * ThinkingLevel union, so every anvil effort now has a pi equivalent — the
 * assignability of this return is the compile-time pin on that subset
 * relationship (a runtime pin lives in model-resolver.test.ts).
 */
function defaultThinkingLevel(effort: Effort | undefined): ThinkingLevel | undefined {
	return effort;
}
