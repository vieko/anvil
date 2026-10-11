import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession, CreateAgentSessionOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity, ModelEffort } from "../src/index.ts";
import { NodeExecEnv } from "../src/node/exec-env.ts";
import { withGatewayCompat } from "../src/node/model-resolver.ts";
import { DEFAULT_RETRY_POLICY, PiAgent, type RetryPolicy } from "../src/node/pi-agent.ts";
import { fauxModelRuntime } from "./support/faux-runtime.ts";

// Captured by the `createAgentSession` spy installed below, so retry/thinking/
// hermeticity tests can assert on what PiAgent actually hands the SDK and on
// the live session it gets back.
let captured: { options: CreateAgentSessionOptions; session: AgentSession }[] = [];

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		createAgentSession: async (options: CreateAgentSessionOptions) => {
			const result = await actual.createAgentSession(options);
			captured.push({ options, session: result.session });
			return result;
		},
	};
});

function lastCreated() {
	const last = captured.at(-1);
	if (!last) throw new Error("expected a created session");
	return last;
}

// Drives the real pi coding-agent SDK (createAgentSession) against pi-ai's faux
// provider in a hermetic model runtime -- no network, no API key. Exercises the
// Agent seam: text/usage/sessionId extraction, provider-agnostic model
// resolution, resume reusing a session, and the dispatch failure mapping.

let faux: ReturnType<typeof fauxProvider>;
let model: Model<string>;
let modelRuntime: ModelRuntime;
let env: NodeExecEnv;

beforeEach(async () => {
	captured = [];
	faux = fauxProvider({
		models: [{ id: "faux-cheap", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
	});
	model = faux.getModel();
	modelRuntime = await fauxModelRuntime(faux.provider);
	env = new NodeExecEnv({ cwd: tmpdir() });
});

afterEach(() => {
	for (const { session } of captured) session.dispose();
});

describe("PiAgent.dispatch", () => {
	it("runs one turn and returns text + usage + a session id", async () => {
		faux.setResponses([fauxAssistantMessage("the outcome is done")]);
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

		const res = await agent.dispatch({ prompt: "do it", config: { model: "faux-cheap", effort: "low" } });

		expect(res.text).toBe("the outcome is done");
		expect(res.sessionId).toBeTruthy();
		expect(res.usage?.output).toBeGreaterThan(0);
	});

	it("reports usage summed across every turn_end in the dispatch, not just the final message (#12)", async () => {
		// Control: the same final answer with no tool call -- one turn, one turn_end.
		faux.setResponses([fauxAssistantMessage("the outcome is done")]);
		const controlAgent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });
		const control = await controlAgent.dispatch({ prompt: "do it", config: { model: "faux-cheap", effort: "low" } });

		// A tool-call turn followed by the same final answer: two assistant messages,
		// two turn_ends. The faux provider's usage grows with the accumulated context,
		// so the total must exceed the control's single-turn usage -- the final
		// message alone (what the old code reported) would equal the control, not this.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("the outcome is done"),
		]);
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });
		const res = await agent.dispatch({ prompt: "do it", config: { model: "faux-cheap", effort: "low" } });

		expect(res.text).toBe("the outcome is done");
		expect(res.usage?.input).toBeGreaterThan(control.usage?.input ?? 0);
		expect(res.usage?.output).toBeGreaterThan(control.usage?.output ?? 0);
	});

	it("prices each turn against the resolved model's cost table and sums it into usage.cost", async () => {
		// The faux model bills $1/M for input and output, $0 for cache: with the
		// dispatch's own token totals in hand, the expected cost is exact.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("the outcome is done"),
		]);
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });
		const res = await agent.dispatch({ prompt: "do it", config: { model: "faux-cheap", effort: "low" } });

		const usage = res.usage;
		if (!usage) throw new Error("expected usage");
		expect(usage.cost).toBeGreaterThan(0);
		expect(usage.cost).toBeCloseTo((usage.input + usage.output) / 1_000_000, 12);
	});

	it("leaves usage.cost undefined (never 0) when the resolved model has no cost table", async () => {
		faux.setResponses([fauxAssistantMessage("the outcome is done")]);
		const { cost: _cost, ...uncosted } = model as Model<string> & { cost: unknown };
		const agent = new PiAgent({
			env,
			modelRuntime,
			resolveModel: () => uncosted as Model<string>,
			systemPrompt: "test",
		});
		const res = await agent.dispatch({ prompt: "do it", config: { model: "faux-cheap", effort: "low" } });

		expect(res.usage?.output).toBeGreaterThan(0);
		expect(res.usage?.cost).toBeUndefined();
	});

	it("resolves the model per dispatch from the injected config (provider-agnostic)", async () => {
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const seen: ModelEffort[] = [];
		const agent = new PiAgent({
			env,
			modelRuntime,
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
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

		const first = await agent.dispatch({ prompt: "p1", config: { model: "m" } });
		const second = await agent.dispatch({ prompt: "p2", config: { model: "m" }, resume: first.sessionId });

		expect(second.sessionId).toBe(first.sessionId);
	});

	it("changes reasoning effort mid-conversation on the resumed session (per-turn effort, one harness)", async () => {
		// What the escalation ladder does: same session, climbing effort. pi 0.85
		// keeps one harness per session (closing it would close the session), so the
		// climb has to land on the lane -- assert the level the provider actually saw
		// on each turn.
		const levels: (string | undefined)[] = [];
		const reply = (text: string) => (_ctx: unknown, options: { reasoning?: string } | undefined) => {
			levels.push(options?.reasoning);
			return fauxAssistantMessage(text);
		};
		const capable = { ...model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as Model<string>;
		faux.setResponses([reply("first"), reply("second")]);
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => capable, systemPrompt: "test" });

		const first = await agent.dispatch({ prompt: "p1", config: { model: "opus", effort: "high" } });
		const second = await agent.dispatch({
			prompt: "p2",
			config: { model: "opus", effort: "max" },
			resume: first.sessionId,
		});

		expect(second.sessionId).toBe(first.sessionId);
		expect(levels).toEqual(["high", "max"]);
		expect(second.text).toBe("second");
	});

	it("carries anvil's gateway compat overlay into the request after createAgentSession and after setModel", async () => {
		// The session sends the exact Model object it holds; this pins that the
		// resolver's withGatewayCompat clone is what the provider receives on the
		// first dispatch AND after an escalation's setModel, so a registry refresh
		// swapping in the bare catalog model cannot go unnoticed.
		const gateway = fauxProvider({
			provider: "vercel-ai-gateway",
			models: [{ id: "anthropic/claude-opus-5" }, { id: "anthropic/claude-opus-5.5" }],
		});
		const runtime = await fauxModelRuntime(gateway.provider);
		const seen: { id: string; compat: unknown }[] = [];
		const record = (_ctx: unknown, _options: unknown, _state: unknown, requestModel: Model<string>) => {
			seen.push({ id: requestModel.id, compat: requestModel.compat });
			return fauxAssistantMessage("done");
		};
		gateway.setResponses([record, record]);
		const resolved = new Map<string, Model<string>>();
		const agent = new PiAgent({
			env,
			modelRuntime: runtime,
			resolveModel: ({ model: id }) => {
				let m = resolved.get(id);
				if (!m) {
					m = withGatewayCompat(gateway.getModel(id) as Model<string>);
					resolved.set(id, m);
				}
				return m;
			},
			systemPrompt: "test",
		});

		const first = await agent.dispatch({ prompt: "go", config: { model: "anthropic/claude-opus-5", effort: "high" } });
		await agent.dispatch({
			prompt: "again",
			config: { model: "anthropic/claude-opus-5.5", effort: "high" },
			resume: first.sessionId,
		});

		const overlay = expect.objectContaining({
			vercelGatewayRouting: { only: ["anthropic"] },
			supportsStrictTools: true,
			supportsMidConvoEffort: true,
			supportsMidConvoToolChanges: false,
		});
		expect(seen).toEqual([
			{ id: "anthropic/claude-opus-5", compat: overlay },
			{ id: "anthropic/claude-opus-5.5", compat: overlay },
		]);
	});

	describe("before_provider_request gateway routing extension", () => {
		// pi's anthropic-messages adapter never sends `compat.vercelGatewayRouting`
		// (pi#9211), so PiAgent enforces the pin itself via an inline
		// `before_provider_request` extension -- loaded while every discovered
		// extension is off (`noExtensions`). The faux provider hands the response
		// factory the same stream options a real adapter gets, so calling
		// `onPayload` from it drives the registered hook end-to-end.
		interface Captured {
			input: Record<string, unknown>;
			snapshot: Record<string, unknown>;
			output: unknown;
		}

		async function routeThrough(
			provider: string,
			modelId: string,
			payload: Record<string, unknown> = { model: modelId, messages: [] },
		): Promise<Captured> {
			const gateway = fauxProvider({ provider, models: [{ id: modelId }] });
			const runtime = await fauxModelRuntime(gateway.provider);
			const snapshot = structuredClone(payload);
			let output: unknown;
			gateway.setResponses([
				async (_ctx, options, _state, requestModel) => {
					output = await options?.onPayload?.(payload, requestModel);
					return fauxAssistantMessage("done");
				},
			]);
			const agent = new PiAgent({
				env,
				modelRuntime: runtime,
				resolveModel: () => withGatewayCompat(gateway.getModel(modelId) as Model<string>),
				systemPrompt: "test",
			});
			await agent.dispatch({ prompt: "go", config: { model: modelId, effort: "high" } });
			return { input: payload, snapshot, output };
		}

		it("fires with noExtensions set and fences a gateway anthropic model to gateway.only = ['anthropic']", async () => {
			const { input, snapshot, output } = await routeThrough("vercel-ai-gateway", "anthropic/claude-opus-5");

			// The loader really ran with discovery off: only the inline extension loaded.
			const { options } = lastCreated();
			const loaded = options.resourceLoader?.getExtensions().extensions ?? [];
			expect(loaded).toHaveLength(1);
			expect(output).toEqual({
				model: "anthropic/claude-opus-5",
				messages: [],
				providerOptions: { gateway: { only: ["anthropic"] } },
			});
			expect(output).not.toBe(input);
			// The original payload object is not mutated.
			expect(input).toEqual(snapshot);
			expect(input).not.toHaveProperty("providerOptions");
		});

		it("fences astra to providerOptions.gateway.only = ['openai'], keeping existing providerOptions keys", async () => {
			const { input, snapshot, output } = await routeThrough("vercel-ai-gateway", "openai/gpt-6-astra", {
				model: "openai/gpt-6-astra",
				providerOptions: { other: { keep: true } },
			});

			expect(output).toEqual({
				model: "openai/gpt-6-astra",
				providerOptions: { other: { keep: true }, gateway: { only: ["openai"] } },
			});
			expect(input).toEqual(snapshot);
		});

		it("fences every openai/* gateway model (sol, luna) to providerOptions.gateway.only = ['openai']", async () => {
			for (const id of ["openai/gpt-6-sol", "openai/gpt-6-luna"]) {
				const { input, snapshot, output } = await routeThrough("vercel-ai-gateway", id);
				expect(output).toEqual({ model: id, messages: [], providerOptions: { gateway: { only: ["openai"] } } });
				expect(output).not.toBe(input);
				expect(input).toEqual(snapshot);
			}
		});

		it("leaves a gateway model without the compat pin untouched", async () => {
			// An unchanged hook resolves to the original payload object.
			const { input, snapshot, output } = await routeThrough("vercel-ai-gateway", "zai/glm-5.3");

			expect(output).toBe(input);
			expect(input).toEqual(snapshot);
		});

		it("leaves a non-gateway model untouched", async () => {
			const { input, snapshot, output } = await routeThrough("anthropic", "anthropic/claude-opus-5");

			expect(output).toBe(input);
			expect(input).toEqual(snapshot);
		});

		it("leaves a payload that already carries providerOptions.gateway untouched (no-op once pi sends it)", async () => {
			const { input, snapshot, output } = await routeThrough("vercel-ai-gateway", "anthropic/claude-opus-5", {
				model: "anthropic/claude-opus-5",
				providerOptions: { gateway: { order: ["bedrock"] } },
			});

			expect(output).toBe(input);
			expect(input).toEqual(snapshot);
		});
	});

	it("starts a fresh session when not resuming", async () => {
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

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
			modelRuntime,
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
		const toolEnv = new NodeExecEnv({ cwd: dir });
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
			const agent = new PiAgent({ env: toolEnv, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

			await agent.dispatch({
				prompt: "go",
				config: { model: "faux-cheap", effort: "high" },
				runId: "run-1",
				attempt: 1,
			});

			const out = await readFile(join(dir, "out.txt"), "utf8");
			expect(out).toBe("run-1:1:faux-cheap:high");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("advances ANVIL_ATTEMPT (and escalated model/effort) across attempts, without leaking the prior attempt's values", async () => {
		const dir = await mkdtemp(join(tmpdir(), "anvil-bash-env-"));
		const toolEnv = new NodeExecEnv({ cwd: dir });
		try {
			const cmd = 'printf "%s:%s:%s:%s" "$ANVIL_RUN_ID" "$ANVIL_ATTEMPT" "$ANVIL_MODEL" "$ANVIL_EFFORT" > out.txt';
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: cmd })], { stopReason: "toolUse" }),
				fauxAssistantMessage("first done"),
			]);
			const agent = new PiAgent({ env: toolEnv, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

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
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("defaults to DEFAULT_RETRY_POLICY (enabled, 3 retries, 2s base delay) when no retry is supplied", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(DEFAULT_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000 });
		expect(lastCreated().options.settingsManager?.getRetrySettings()).toMatchObject(DEFAULT_RETRY_POLICY);
	});

	it("threads an overridden PiAgentOptions.retry through to the session settings", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const override: RetryPolicy = { enabled: false, maxRetries: 0, baseDelayMs: 100 };
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test", retry: override });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(lastCreated().options.settingsManager?.getRetrySettings()).toMatchObject(override);
	});

	it("clamps the thinking level to the resolved model's verified levels (max unverified -> high)", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		// A reasoning model with no thinkingLevelMap: pi 0.82 treats xhigh/max as
		// unverified, so a requested max must clamp down to high before dispatch.
		const limited = { ...model, reasoning: true } as Model<string>;
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => limited, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "max" } });

		expect(lastCreated().options.thinkingLevel).toBe("high");
		expect(lastCreated().session.thinkingLevel).toBe("high");
	});

	it("passes max through to the session when the model verifies it (regression: stale max -> xhigh mapping)", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const capable = { ...model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as Model<string>;
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => capable, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "max" } });

		expect(lastCreated().options.thinkingLevel).toBe("max");
		expect(lastCreated().session.thinkingLevel).toBe("max");
	});

	it("leaves the level to the SDK default (clamped) when no effort is requested", async () => {
		// Only direct PiAgent callers reach this; runToGate always requests an effort.
		faux.setResponses([fauxAssistantMessage("done")]);
		const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(lastCreated().options.thinkingLevel).toBeUndefined();
	});

	it("forwards the model's reasoning trace as a reasoning activity (on thinking_end)", async () => {
		const reasoning = faux.getModel(); // faux models emit thinking content as thinking_* events
		faux.setResponses([fauxAssistantMessage([fauxThinking("weigh the options, then act"), fauxText("done")])]);
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			modelRuntime,
			resolveModel: () => reasoning,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "high" } });

		expect(activity).toContainEqual({ kind: "reasoning", text: "weigh the options, then act" });
	});

	describe("failure mapping (the gate stays the sole authority)", () => {
		it("throws when the final turn errored (after pi's own retries), never reporting success", async () => {
			faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
			const agent = new PiAgent({
				env,
				modelRuntime,
				resolveModel: () => model,
				systemPrompt: "test",
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
			});

			await expect(agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } })).rejects.toThrow(
				/did not complete \(error: boom\)/,
			);
		});

		it("throws when the caller aborts mid-run", async () => {
			const controller = new AbortController();
			faux.setResponses([
				async () => {
					controller.abort();
					await new Promise((resolve) => setTimeout(resolve, 50));
					return fauxAssistantMessage("too late");
				},
			]);
			const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

			await expect(
				agent.dispatch({ prompt: "go", config: { model: "faux-cheap" }, signal: controller.signal }),
			).rejects.toThrow(/abort/);
		});

		it("throws without starting a run when the signal is already aborted", async () => {
			faux.setResponses([fauxAssistantMessage("never")]);
			const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

			await expect(
				agent.dispatch({ prompt: "go", config: { model: "faux-cheap" }, signal: AbortSignal.abort() }),
			).rejects.toThrow(/aborted before it started/);
			expect(faux.state.callCount).toBe(0);
		});

		it("treats an outcome that starts with '/' as text, not a command", async () => {
			const seen: string[] = [];
			faux.setResponses([
				(context) => {
					const last = context.messages.at(-1);
					if (last?.role === "user") {
						const content = last.content;
						seen.push(
							typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join(""),
						);
					}
					return fauxAssistantMessage("done");
				},
			]);
			const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

			const res = await agent.dispatch({ prompt: "/compact the readme", config: { model: "faux-cheap" } });

			expect(res.text).toBe("done");
			expect(seen).toEqual(["/compact the readme"]);
		});
	});

	describe("hermetic sessions", () => {
		it("sends only anvil's system prompt: no host or target-repo context files, skills, or append prompts", async () => {
			const dir = await mkdtemp(join(tmpdir(), "anvil-hermetic-"));
			try {
				await writeFile(join(dir, "AGENTS.md"), "MARKER-AGENTS-MD must never reach a golem\n");
				await writeFile(join(dir, "CLAUDE.md"), "MARKER-CLAUDE-MD must never reach a golem\n");
				const prompts: string[] = [];
				faux.setResponses([
					(context) => {
						// pi 1.x carries the system prompt as a transcript message.
						prompts.push(JSON.stringify(context.messages));
						return fauxAssistantMessage("done");
					},
				]);
				const agent = new PiAgent({
					env: new NodeExecEnv({ cwd: dir }),
					modelRuntime,
					resolveModel: () => model,
					systemPrompt: "ANVIL-PROMPT",
				});

				await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

				expect(prompts).toHaveLength(1);
				expect(prompts[0]).toContain("ANVIL-PROMPT");
				expect(prompts[0]).not.toContain("MARKER-");
				const { options, session } = lastCreated();
				expect(options.resourceLoader?.getSkills().skills).toEqual([]);
				expect(options.resourceLoader?.getPrompts().prompts).toEqual([]);
				expect(options.resourceLoader?.getAgentsFiles().agentsFiles).toEqual([]);
				// Only anvil's own tools are active: pi's built-ins are off.
				expect([...session.getActiveToolNames()].sort()).toEqual(["bash", "edit", "read", "write"]);
				// The agent dir handed to the SDK is never created.
				await expect(access(options.agentDir ?? "")).rejects.toThrow();
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});

		it("runs with compaction, cache warming, and install telemetry off", async () => {
			faux.setResponses([fauxAssistantMessage("done")]);
			const agent = new PiAgent({ env, modelRuntime, resolveModel: () => model, systemPrompt: "test" });

			await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

			const settings = lastCreated().options.settingsManager;
			expect(settings?.getCompactionEnabled()).toBe(false);
			expect(settings?.getCacheWarmingMode()).toBe("off");
			expect(settings?.getEnableInstallTelemetry()).toBe(false);
		});
	});
});
