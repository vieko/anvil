import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, MutableModels, RetryPolicy } from "@earendil-works/pi-ai";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity, ModelEffort } from "../src/index.ts";
import { DEFAULT_RETRY_POLICY, PiAgent } from "../src/node/pi-agent.ts";

// Captured by the `AgentHarness` spy installed below, so retry/thinking tests
// can assert on the options PiAgent actually hands to the harness.
let capturedRetry: RetryPolicy | undefined;
let capturedThinkingLevel: ThinkingLevel | undefined;

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
	class SpyAgentHarness extends actual.AgentHarness {
		// Generic pass-through: AgentHarness's constructor generics can't be named here, so accept loosely and forward.
		constructor(options: any) {
			capturedRetry = options.retry;
			capturedThinkingLevel = options.thinkingLevel;
			super(options);
		}
	}
	return { ...actual, AgentHarness: SpyAgentHarness };
});

// Drives the real AgentHarness against pi-ai's faux provider — no network, no
// API key, no tools. Exercises the Agent seam: text/usage/sessionId extraction,
// provider-agnostic model resolution, and resume reusing a session.

let faux: ReturnType<typeof fauxProvider>;
let model: Model<string>;
let models: MutableModels;
let env: NodeExecutionEnv;

beforeEach(() => {
	capturedRetry = undefined;
	capturedThinkingLevel = undefined;
	faux = fauxProvider({
		models: [{ id: "faux-cheap", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
	});
	model = faux.getModel();
	models = createModels();
	models.setProvider(faux.provider);
	env = new NodeExecutionEnv({ cwd: tmpdir() });
});

afterEach(async () => {
	await env.cleanup();
});

describe("PiAgent.dispatch", () => {
	it("runs one turn and returns text + usage + a session id", async () => {
		faux.setResponses([fauxAssistantMessage("the outcome is done")]);
		const agent = new PiAgent({ env, models, resolveModel: () => model, systemPrompt: "test" });

		const res = await agent.dispatch({ prompt: "do it", config: { model: "faux-cheap", effort: "low" } });

		expect(res.text).toBe("the outcome is done");
		expect(res.sessionId).toBeTruthy();
		expect(res.usage?.output).toBeGreaterThan(0);
	});

	it("resolves the model per dispatch from the injected config (provider-agnostic)", async () => {
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const seen: ModelEffort[] = [];
		const agent = new PiAgent({
			env,
			models,
			systemPrompt: "test",
			resolveModel: (config) => {
				seen.push(config);
				return model;
			},
		});

		await agent.dispatch({ prompt: "x", config: { model: "cheap", effort: "low" } });
		await agent.dispatch({ prompt: "y", config: { model: "strong", effort: "max" } });

		expect(seen).toEqual([
			{ model: "cheap", effort: "low" },
			{ model: "strong", effort: "max" },
		]);
	});

	it("reuses the same session when resume is the prior session id", async () => {
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const agent = new PiAgent({ env, models, resolveModel: () => model, systemPrompt: "test" });

		const first = await agent.dispatch({ prompt: "p1", config: { model: "m" } });
		const second = await agent.dispatch({ prompt: "p2", config: { model: "m" }, resume: first.sessionId });

		expect(second.sessionId).toBe(first.sessionId);
	});

	it("starts a fresh session when not resuming", async () => {
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const agent = new PiAgent({ env, models, resolveModel: () => model, systemPrompt: "test" });

		const first = await agent.dispatch({ prompt: "p1", config: { model: "m" } });
		const second = await agent.dispatch({ prompt: "p2", config: { model: "m" } });

		expect(second.sessionId).not.toBe(first.sessionId);
	});

	it("streams tool-call activity to the sink and persists a JSONL transcript", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const sessionsRoot = await mkdtemp(join(tmpdir(), "anvil-sessions-"));
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			sessionsRoot,
			sessionCwd: tmpdir(),
		});

		const res = await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(res.text).toBe("done");
		expect(activity).toContainEqual({ kind: "tool-start", tool: "bash", summary: "echo hi" });
		expect(activity).toContainEqual({ kind: "tool-end", tool: "bash", ok: true });

		const entries = await readdir(sessionsRoot, { recursive: true });
		expect(entries.some((entry) => String(entry).endsWith(".jsonl"))).toBe(true);

		await rm(sessionsRoot, { recursive: true, force: true });
	});

	it("exposes ANVIL_RUN_ID/ANVIL_ATTEMPT/ANVIL_MODEL/ANVIL_EFFORT to commands run via the bash tool", async () => {
		const dir = await mkdtemp(join(tmpdir(), "anvil-bash-env-"));
		const toolEnv = new NodeExecutionEnv({ cwd: dir });
		try {
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: 'printf "%s:%s:%s:%s" "$ANVIL_RUN_ID" "$ANVIL_ATTEMPT" "$ANVIL_MODEL" "$ANVIL_EFFORT" > out.txt',
						}),
					],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage("done"),
			]);
			const agent = new PiAgent({ env: toolEnv, models, resolveModel: () => model, systemPrompt: "test" });

			await agent.dispatch({
				prompt: "go",
				config: { model: "faux-cheap", effort: "high" },
				runId: "run-1",
				attempt: 1,
			});

			const out = await readFile(join(dir, "out.txt"), "utf8");
			expect(out).toBe("run-1:1:faux-cheap:high");
		} finally {
			await toolEnv.cleanup();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("advances ANVIL_ATTEMPT (and escalated model/effort) across attempts, without leaking the prior attempt's values", async () => {
		const dir = await mkdtemp(join(tmpdir(), "anvil-bash-env-"));
		const toolEnv = new NodeExecutionEnv({ cwd: dir });
		try {
			const cmd = 'printf "%s:%s:%s:%s" "$ANVIL_RUN_ID" "$ANVIL_ATTEMPT" "$ANVIL_MODEL" "$ANVIL_EFFORT" > out.txt';
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: cmd })], { stopReason: "toolUse" }),
				fauxAssistantMessage("first done"),
			]);
			const agent = new PiAgent({ env: toolEnv, models, resolveModel: () => model, systemPrompt: "test" });

			await agent.dispatch({
				prompt: "go",
				config: { model: "faux-cheap", effort: "low" },
				runId: "run-1",
				attempt: 1,
			});
			expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("run-1:1:faux-cheap:low");

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: cmd })], { stopReason: "toolUse" }),
				fauxAssistantMessage("second done"),
			]);
			await agent.dispatch({
				prompt: "retry",
				config: { model: "faux-strong", effort: "high" },
				runId: "run-1",
				attempt: 2,
			});
			expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("run-1:2:faux-strong:high");
		} finally {
			await toolEnv.cleanup();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("defaults to DEFAULT_RETRY_POLICY (enabled, 3 retries, 2s base delay) when no retry is supplied", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const agent = new PiAgent({ env, models, resolveModel: () => model, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(DEFAULT_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000 });
		expect(capturedRetry).toEqual(DEFAULT_RETRY_POLICY);
	});

	it("threads an overridden PiAgentOptions.retry through to the harness", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const override: RetryPolicy = { enabled: false, maxRetries: 0, baseDelayMs: 100 };
		const agent = new PiAgent({ env, models, resolveModel: () => model, systemPrompt: "test", retry: override });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(capturedRetry).toEqual(override);
	});

	it("clamps the thinking level to the resolved model's verified levels (max unverified -> high)", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		// A reasoning model with no thinkingLevelMap: pi 0.82 treats xhigh/max as
		// unverified, so a requested max must clamp down to high before dispatch.
		const limited = { ...model, reasoning: true } as Model<string>;
		const agent = new PiAgent({ env, models, resolveModel: () => limited, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "max" } });

		expect(capturedThinkingLevel).toBe("high");
	});

	it("passes max through to the harness when the model verifies it (regression: stale max -> xhigh mapping)", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const capable = { ...model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as Model<string>;
		const agent = new PiAgent({ env, models, resolveModel: () => capable, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "max" } });

		expect(capturedThinkingLevel).toBe("max");
	});

	it("leaves the thinking level undefined when no effort is requested (provider default)", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const agent = new PiAgent({ env, models, resolveModel: () => model, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(capturedThinkingLevel).toBeUndefined();
	});

	it("forwards the model's reasoning trace as a reasoning activity (on thinking_end)", async () => {
		const reasoning = faux.getModel(); // faux models emit thinking content as thinking_* events
		faux.setResponses([fauxAssistantMessage([fauxThinking("weigh the options, then act"), fauxText("done")])]);
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => reasoning,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "high" } });

		expect(activity).toContainEqual({ kind: "reasoning", text: "weigh the options, then act" });
	});
});
