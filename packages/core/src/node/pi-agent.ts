import type { AgentHarnessEvent, AgentTool, ExecutionEnv, Session, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AgentHarness, InMemorySessionRepo, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai";
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

export type ApiKeyResolver = (
	model: Model<any>,
) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;

export interface PiAgentOptions {
	/** Execution environment the agent operates in (e.g. `WorktreeWorkspace.env`). */
	env: ExecutionEnv;
	/** Map anvil's (model, effort) to a pi-ai Model. Default: {@link createModelResolver}(). */
	resolveModel?: ModelResolver;
	/** Tools the agent may call. Default: anvil's read/edit/write/bash over `env`. Pass `[]` to disable. */
	tools?: AgentTool[];
	/** System prompt. Default: a minimal outcome-focused prompt. */
	systemPrompt?: string;
	/** Provide the API key/headers for a model. Default: read from env by provider. */
	getApiKeyAndHeaders?: ApiKeyResolver;
	/**
	 * Persist each run's transcript as JSONL under this (absolute) root, using
	 * `env` as the filesystem. Omit for an in-memory session discarded on exit.
	 */
	sessionsRoot?: string;
	/** cwd used to bucket persisted sessions (typically the workspace cwd). Default ".". */
	sessionCwd?: string;
	/** Live activity sink: receives tool-call lifecycle events during a dispatch. */
	onActivity?: AgentEventSink;
	/** Map anvil Effort to pi ThinkingLevel. Default: identity, with `max` -> `xhigh`. */
	thinkingLevel?: (effort: Effort | undefined) => ThinkingLevel | undefined;
}

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
	private readonly createSession: () => Promise<Session>;
	/** Sessions created by this agent, so a `resume` continues the same transcript. */
	private readonly sessions = new Map<string, Session>();

	constructor(options: PiAgentOptions) {
		this.options = options;
		this.resolveModel = options.resolveModel ?? createModelResolver();
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

		const harness = new AgentHarness({
			env: this.options.env,
			session,
			model,
			tools: this.options.tools ?? defaultTools(this.options.env),
			systemPrompt: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			getApiKeyAndHeaders: this.options.getApiKeyAndHeaders ?? defaultGetApiKey,
			thinkingLevel: (this.options.thinkingLevel ?? defaultThinkingLevel)(d.config.effort),
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

/** anvil Effort -> pi ThinkingLevel. `max` has no pi equivalent, so it maps to `xhigh`. */
function defaultThinkingLevel(effort: Effort | undefined): ThinkingLevel | undefined {
	switch (effort) {
		case undefined:
			return undefined;
		case "max":
			return "xhigh";
		default:
			return effort;
	}
}

/**
 * Read the provider's API key from the environment, delegating to pi-ai's own
 * provider->env mapping (covers every provider pi knows, including the Vercel
 * AI Gateway's `AI_GATEWAY_API_KEY` and Anthropic's OAuth-token precedence).
 */
const defaultGetApiKey: ApiKeyResolver = async (model) => {
	const apiKey = getEnvApiKey(model.provider);
	return apiKey ? { apiKey } : undefined;
};
