import type {
	AgentLane,
	Context,
	ExecutionEnv,
	OperationResultRecord,
	RunResult,
	Session,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { AgentHarness, JsonlSessionRepo, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Models, RetryPolicy } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Agent, AgentDispatch, AgentEventSink, AgentResult, Effort, ModelEffort } from "../index.ts";
import { createModelResolver, withGatewayCompatModels } from "./model-resolver.ts";
import { contextFor } from "./pi-exec.ts";
import { type AnvilTool, defaultTools } from "./tools.ts";

/** Resolve anvil's (model, effort) to a concrete pi-ai Model. The provider-agnostic seam. */
export type ModelResolver = (config: ModelEffort) => Model<any>;

export interface PiAgentOptions {
	/** Execution environment the agent operates in (e.g. `WorktreeWorkspace.env`). */
	env: ExecutionEnv;
	/** Map anvil's (model, effort) to a pi-ai Model. Default: {@link createModelResolver}(). */
	resolveModel?: ModelResolver;
	/** Tools the agent may call. Default: anvil's read/edit/write/bash over `env`. Pass `[]` to disable. */
	tools?: AnvilTool[];
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
	"fake, skip, or work around checks. Repository policy configuration is part of the outcome, not an obstacle: " +
	"never bypass it (e.g. .npmrc release-age cooldowns or registry settings, lockfile constraints, lint/type " +
	"ignores, git hooks). If a policy blocks the outcome, stop and report the blocker instead.";

/** The lane every anvil dispatch runs on. One conversation per session. */
const LANE = "main";

/**
 * One session's live harness. pi 0.85's `harness.close()` also closes the
 * session, so a resumable transcript keeps its harness for the whole run
 * instead of rebuilding one per dispatch; per-attempt model/effort changes go
 * through the lane's own setters (which is what makes the escalation ladder a
 * mid-conversation effort change rather than a new conversation).
 */
interface SessionRuntime {
	session: Session;
	harness: AgentHarness<undefined>;
	lane: AgentLane;
}

/**
 * The {@link Agent} seam, backed by pi-agent-core's `AgentHarness`.
 *
 * One `dispatch` == one complete agentic turn (the harness runs tool use until
 * the model stops), after which anvil's gate verifies the result. Only a run
 * that reaches the `completed` status counts as work done. PiAgent owns none of
 * the verify/retry policy — that is `runToGate`'s job. It is provider-agnostic:
 * the caller supplies `resolveModel`, so the same engine can run the cheapest
 * capable model and escalate across providers.
 */
export class PiAgent implements Agent {
	private readonly options: PiAgentOptions;
	private readonly resolveModel: ModelResolver;
	private readonly models: Models;
	private readonly createSession: (context: Context) => Promise<Session>;
	/** Sessions created by this agent, so a `resume` continues the same transcript. */
	private readonly runtimes = new Map<string, SessionRuntime>();

	constructor(options: PiAgentOptions) {
		this.options = options;
		this.resolveModel = options.resolveModel ?? createModelResolver();
		// The harness re-resolves every request through this collection (it keeps
		// only a model identity), so anvil's gateway compat overlay has to live here
		// to reach the provider at all -- including after a mid-run `setModel`.
		this.models = withGatewayCompatModels(options.models ?? builtinModels());
		if (options.sessionsRoot) {
			const repo = new JsonlSessionRepo({ fileSystem: options.env, sessionsRoot: options.sessionsRoot });
			const cwd = options.sessionCwd ?? ".";
			this.createSession = (context) => repo.create({ cwd }, context);
		} else {
			const repo = new MemorySessionRepo();
			this.createSession = (context) => repo.create({}, context);
		}
	}

	async dispatch(d: AgentDispatch): Promise<AgentResult> {
		const context = contextFor();
		const model = this.resolveModel(d.config);

		// Clamp the requested thinking level to what the resolved model verifies
		// (pi-ai catalog metadata): the correctness layer of issue #31 -- anvil
		// never sends an unverified level, no matter who built the ladder. An
		// undefined level (no effort requested) stays undefined: provider default.
		const requested = (this.options.thinkingLevel ?? defaultThinkingLevel)(d.config.effort);
		const thinkingLevel = requested === undefined ? undefined : clampThinkingLevel(model, requested);

		const tools = this.options.tools ?? defaultTools(this.options.env, bashEnvFor(d));
		const runtime = await this.resolveRuntime(d, { model, thinkingLevel, tools }, context);
		const sessionId = runtime.session.metadata.id;

		const onAbort = () => void requestAbort(runtime.lane, context);
		if (d.signal) {
			if (d.signal.aborted) await requestAbort(runtime.lane, context);
			else d.signal.addEventListener("abort", onAbort, { once: true });
		}

		// The run's own final assistant message, captured from the turn stream:
		// 0.85's terminal record carries status and tip ids, not the message.
		let finalMessage: AssistantMessage | undefined;
		const unsubscribe = [
			runtime.harness.events.on("turn_end", (event) => {
				finalMessage = event.message;
			}),
			...this.subscribeActivity(runtime),
		];

		try {
			const record = completedRecord(await runtime.lane.prompt(d.prompt, undefined, context));
			const message = finalMessage ?? (await tipAssistantMessage(runtime.session, record, context));
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
			for (const off of unsubscribe) off();
		}
	}

	/**
	 * The session + harness this dispatch runs on: the resumed one when
	 * `resume` names a session this agent owns, otherwise a fresh one. A resumed
	 * runtime is re-pointed at this attempt's model, effort, and tools (the bash
	 * tool carries the attempt number), so the escalation ladder climbs inside
	 * one conversation.
	 */
	private async resolveRuntime(
		d: AgentDispatch,
		config: { model: Model<any>; thinkingLevel: ThinkingLevel | undefined; tools: AnvilTool[] },
		context: Context,
	): Promise<SessionRuntime> {
		const existing = d.resume ? this.runtimes.get(d.resume) : undefined;
		if (existing) {
			await existing.harness.setTools(config.tools, context);
			const current = await existing.lane.getModel(context);
			if (!sameModel(current, config.model)) {
				await existing.lane.setModel({ provider: config.model.provider, modelId: config.model.id }, context);
			}
			if (config.thinkingLevel !== undefined) {
				await existing.lane.setThinkingLevel(config.thinkingLevel, context);
			}
			return existing;
		}

		const session = await this.createSession(context);
		const { harness } = await AgentHarness.create<undefined>(
			{
				session,
				models: this.models,
				model: config.model,
				tools: config.tools,
				systemPrompt: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
				...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
				retry: this.options.retry ?? DEFAULT_RETRY_POLICY,
			},
			context,
		);
		const runtime: SessionRuntime = { session, harness, lane: await harness.lane(LANE, context) };
		this.runtimes.set(session.metadata.id, runtime);
		return runtime;
	}

	/** Wire the activity sink (when there is one) to the harness's event registry. Returns the unsubscribes. */
	private subscribeActivity(runtime: SessionRuntime): (() => void)[] {
		const sink = this.options.onActivity;
		if (!sink) return [];
		return [
			runtime.harness.events.on("tool_start", (event) => {
				sink({ kind: "tool-start", tool: event.toolName, summary: summarizeToolArgs(event.args) });
			}),
			runtime.harness.events.on("tool_end", (event) => {
				sink({ kind: "tool-end", tool: event.toolName, ok: !event.isError });
			}),
			runtime.harness.events.on("message_update", (event) => {
				// Reasoning is forwarded once per segment, on `thinking_end` (the
				// complete block), rather than as token deltas: an append-only stream
				// reads cleaner as whole thoughts.
				const inner = event.event;
				if (inner.type === "thinking_end" && inner.content.trim()) {
					sink({ kind: "reasoning", text: inner.content });
				}
			}),
		];
	}
}

/**
 * Ask the lane to stop the in-flight run. 0.85's `abort()` is Result-typed: a
 * rejection (`NoActiveOperation`, `Closed`) only says there was nothing left to
 * abort — the exact race a caller-side signal can lose — so it is benign and not
 * escalated. What ends the dispatch is the run's own terminal status, which
 * {@link completedRecord} turns into a thrown failure.
 */
async function requestAbort(lane: AgentLane, context: Context): Promise<void> {
	try {
		await lane.abort(context);
	} catch {
		// The harness is closed or faulted; the run's own record carries the failure.
	}
}

/**
 * The one success path out of a 0.85 run: a `completed` terminal record. Every
 * other status (`declined`, `aborted`, `failed`), a suspended run, and every
 * rejected Result throws, so a dispatch surfaces as a failed attempt instead of
 * a silent success. The gate is the sole authority on "done" — a half-finished
 * run must never be able to fake progress.
 */
function completedRecord(result: RunResult): OperationResultRecord {
	if (!result.ok) {
		throw new Error(`anvil: the harness rejected the dispatch: ${result.error.message}`, { cause: result.error });
	}
	const outcome = result.value;
	if (!("status" in outcome)) throw new Error("anvil: the agent run did not complete (no terminal record).");
	if (outcome.status === "suspended") throw new Error("anvil: the agent run suspended instead of completing.");
	if (outcome.status === "completed") return outcome;
	const detail = outcome.error ? `: [${outcome.error.code}] ${outcome.error.message}` : "";
	throw new Error(`anvil: the agent run did not complete (${outcome.status}${detail}).`);
}

/**
 * Fallback for the run's final assistant message: read the tip entry the
 * terminal record points at. Only used when the turn stream produced nothing
 * (no turn ran), so a completed-but-silent run still fails loudly rather than
 * reporting empty work.
 */
async function tipAssistantMessage(
	session: Session,
	record: OperationResultRecord,
	context: Context,
): Promise<AssistantMessage> {
	const entry = record.tipId === null ? undefined : await session.getEntry(record.tipId, context);
	if (entry?.type === "message" && entry.message.role === "assistant") return entry.message;
	throw new Error("anvil: the agent run completed without a final assistant message.");
}

/** Whether the lane is already pointed at this model (provider + id). */
function sameModel(current: Model<any> | undefined, next: Model<any>): boolean {
	return current?.provider === next.provider && current?.id === next.id;
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
