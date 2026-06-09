import type { AgentTool, ExecutionEnv, Session, SessionRepo, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AgentHarness, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Agent, AgentDispatch, AgentResult, Effort, ModelEffort } from "../index.ts";
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
	/** Session repository. Default: in-memory (one transcript per run, reused on resume). */
	sessionRepo?: SessionRepo;
	/** Map anvil Effort to pi ThinkingLevel. Default: identity, with `max` -> `xhigh`. */
	thinkingLevel?: (effort: Effort | undefined) => ThinkingLevel | undefined;
}

const PROVIDER_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
};

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
	private readonly repo: SessionRepo;
	private readonly resolveModel: ModelResolver;
	/** Sessions created by this agent, so a `resume` continues the same transcript. */
	private readonly sessions = new Map<string, Session>();

	constructor(options: PiAgentOptions) {
		this.options = options;
		this.repo = options.sessionRepo ?? new InMemorySessionRepo();
		this.resolveModel = options.resolveModel ?? createModelResolver();
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
		}
	}

	private async resolveSession(resume?: string): Promise<Session> {
		if (resume) {
			const existing = this.sessions.get(resume);
			if (existing) return existing;
		}
		return this.repo.create({});
	}
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

/** Read the provider's API key from the environment. Returns undefined when absent. */
const defaultGetApiKey: ApiKeyResolver = async (model) => {
	const envVar = PROVIDER_ENV[model.provider];
	const apiKey = envVar ? process.env[envVar] : undefined;
	return apiKey ? { apiKey } : undefined;
};
