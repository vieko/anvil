import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaneBusy, NoActiveOperation } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, MutableModels, RetryPolicy } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentActivity, ModelEffort } from "../src/index.ts";
import { DEFAULT_RETRY_POLICY, PiAgent } from "../src/node/pi-agent.ts";
import { createFakeHarness } from "./support/fake-harness.ts";

// Exercises the Agent seam against a fake of the harness surface PiAgent drives
// (`PiAgentOptions.createHarness`): text/usage/sessionId extraction,
// provider-agnostic model resolution, resume reusing a session, the harness
// options anvil hands over, the activity stream, and the rule that only a
// `completed` run counts as a dispatch. No model, no network, no API key.
//
// The fake is required, not a convenience: pi 0.84's `AgentHarness` has a
// private constructor (nothing to subclass) and its `prompt`/`events` are not
// implemented yet, so the real class cannot run a turn.

let faux: ReturnType<typeof fauxProvider>;
let model: Model<string>;
let models: MutableModels;
let env: NodeExecutionEnv;

beforeEach(() => {
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
		const harness = createFakeHarness({ runs: [{ text: "the outcome is done", usage: { input: 12, output: 7 } }] });
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			createHarness: harness.factory,
		});

		const res = await agent.dispatch({ prompt: "do it", config: { model: "faux-cheap", effort: "low" } });

		expect(res.text).toBe("the outcome is done");
		expect(res.sessionId).toBeTruthy();
		expect(res.usage).toEqual({ input: 12, output: 7, cacheRead: 0 });
		expect(harness.log.prompts).toEqual(["do it"]);
	});

	it("hands the harness the prompt's model, tools, system prompt and session (one harness per dispatch)", async () => {
		const harness = createFakeHarness({ runs: [{ text: "a" }, { text: "b" }] });
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "be terse",
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "x", config: { model: "faux-cheap" } });
		await agent.dispatch({ prompt: "y", config: { model: "faux-cheap" } });

		expect(harness.log.options).toHaveLength(2);
		const options = harness.lastOptions();
		expect(options?.model).toBe(model);
		expect(options?.models).toBe(models);
		expect(options?.systemPrompt).toBe("be terse");
		expect(options?.session).toBeTruthy();
		expect(options?.tools?.map((tool) => tool.name)).toEqual(["read", "edit", "write", "bash"]);
		// Each dispatch's harness is released once the turn settles.
		expect(harness.log.closes).toBe(2);
	});

	it("resolves the model per dispatch from the injected config (provider-agnostic)", async () => {
		const harness = createFakeHarness({ runs: [{ text: "a" }, { text: "b" }] });
		const seen: ModelEffort[] = [];
		const agent = new PiAgent({
			env,
			models,
			systemPrompt: "test",
			createHarness: harness.factory,
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
		const harness = createFakeHarness({ runs: [{ text: "first" }, { text: "second" }] });
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			createHarness: harness.factory,
		});

		const first = await agent.dispatch({ prompt: "p1", config: { model: "m" } });
		const second = await agent.dispatch({ prompt: "p2", config: { model: "m" }, resume: first.sessionId });

		expect(second.sessionId).toBe(first.sessionId);
		expect(harness.log.options[1]?.session).toBe(harness.log.options[0]?.session);
	});

	it("starts a fresh session when not resuming", async () => {
		const harness = createFakeHarness({ runs: [{ text: "one" }, { text: "two" }] });
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			createHarness: harness.factory,
		});

		const first = await agent.dispatch({ prompt: "p1", config: { model: "m" } });
		const second = await agent.dispatch({ prompt: "p2", config: { model: "m" } });

		expect(second.sessionId).not.toBe(first.sessionId);
	});

	it("streams tool-call activity to the sink and persists a JSONL transcript", async () => {
		const harness = createFakeHarness({
			runs: [{ toolCalls: [{ name: "bash", args: { command: "echo hi" } }], text: "done" }],
		});
		const sessionsRoot = await mkdtemp(join(tmpdir(), "anvil-sessions-"));
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			createHarness: harness.factory,
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

	it("subscribes to the harness event types only when an activity sink is wired", async () => {
		const withSink = createFakeHarness({ runs: [{ text: "done" }] });
		const withoutSink = createFakeHarness({ runs: [{ text: "done" }] });
		const listening = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: () => {},
			createHarness: withSink.factory,
		});
		const silent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			createHarness: withoutSink.factory,
		});

		await listening.dispatch({ prompt: "go", config: { model: "faux-cheap" } });
		await silent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(withSink.log.subscribed).toEqual(["tool_start", "tool_end", "message_update"]);
		expect(withoutSink.log.subscribed).toEqual([]);
	});

	it("still dispatches when the harness has no event registry (activity is cosmetic)", async () => {
		const harness = createFakeHarness({
			runs: [{ text: "done" }],
			subscribeThrows: new Error("AgentHarness.events.on is not implemented yet"),
		});
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			createHarness: harness.factory,
		});

		const res = await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(res.text).toBe("done");
		expect(activity).toEqual([]);
	});

	it("forwards a tool_start that reports its arguments as effectiveArgs (the persisted record's field name)", async () => {
		const harness = createFakeHarness({
			runs: [
				{
					rawEvents: [
						{
							type: "tool_start",
							event: {
								type: "tool_start",
								lane: "main",
								runId: "run-1",
								toolCallId: "call-1",
								toolName: "read",
								effectiveArgs: { path: "src/index.ts" },
							},
						},
					],
					text: "done",
				},
			],
		});
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(activity).toContainEqual({ kind: "tool-start", tool: "read", summary: "src/index.ts" });
	});

	it("drops event payloads it cannot read instead of emitting a half-formed activity", async () => {
		const harness = createFakeHarness({
			runs: [
				{
					rawEvents: [
						{ type: "tool_start", event: { type: "tool_start", lane: "main" } },
						{ type: "tool_end", event: undefined },
						{ type: "message_update", event: { type: "message_update", lane: "main" } },
						{ type: "message_update", event: { assistantMessageEvent: { type: "thinking_delta", delta: "partial" } } },
					],
					text: "done",
				},
			],
		});
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(activity).toEqual([]);
	});

	it("marks a failed tool call as not ok in the activity stream", async () => {
		const harness = createFakeHarness({
			runs: [{ toolCalls: [{ name: "read", args: { path: "does-not-exist-anvil.txt" } }], text: "done" }],
		});
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(activity).toContainEqual({ kind: "tool-end", tool: "read", ok: false });
	});

	it("exposes ANVIL_RUN_ID/ANVIL_ATTEMPT/ANVIL_MODEL/ANVIL_EFFORT to commands run via the bash tool", async () => {
		const dir = await mkdtemp(join(tmpdir(), "anvil-bash-env-"));
		const toolEnv = new NodeExecutionEnv({ cwd: dir });
		try {
			const command = 'printf "%s:%s:%s:%s" "$ANVIL_RUN_ID" "$ANVIL_ATTEMPT" "$ANVIL_MODEL" "$ANVIL_EFFORT" > out.txt';
			const harness = createFakeHarness({ runs: [{ toolCalls: [{ name: "bash", args: { command } }], text: "done" }] });
			const agent = new PiAgent({
				env: toolEnv,
				models,
				resolveModel: () => model,
				systemPrompt: "test",
				createHarness: harness.factory,
			});

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
			const command = 'printf "%s:%s:%s:%s" "$ANVIL_RUN_ID" "$ANVIL_ATTEMPT" "$ANVIL_MODEL" "$ANVIL_EFFORT" > out.txt';
			const harness = createFakeHarness({
				runs: [
					{ toolCalls: [{ name: "bash", args: { command } }], text: "first done" },
					{ toolCalls: [{ name: "bash", args: { command } }], text: "second done" },
				],
			});
			const agent = new PiAgent({
				env: toolEnv,
				models,
				resolveModel: () => model,
				systemPrompt: "test",
				createHarness: harness.factory,
			});

			await agent.dispatch({
				prompt: "go",
				config: { model: "faux-cheap", effort: "low" },
				runId: "run-1",
				attempt: 1,
			});
			expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("run-1:1:faux-cheap:low");

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
		const harness = createFakeHarness({ runs: [{ text: "done" }] });
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(DEFAULT_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000 });
		expect(harness.lastOptions()?.retry).toEqual(DEFAULT_RETRY_POLICY);
	});

	it("threads an overridden PiAgentOptions.retry through to the harness", async () => {
		const harness = createFakeHarness({ runs: [{ text: "done" }] });
		const override: RetryPolicy = { enabled: false, maxRetries: 0, baseDelayMs: 100 };
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			retry: override,
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(harness.lastOptions()?.retry).toEqual(override);
	});

	it("clamps the thinking level to the resolved model's verified levels (max unverified -> high)", async () => {
		const harness = createFakeHarness({ runs: [{ text: "done" }] });
		// A reasoning model with no thinkingLevelMap: pi treats xhigh/max as
		// unverified, so a requested max must clamp down to high before dispatch.
		const limited = { ...model, reasoning: true } as Model<string>;
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => limited,
			systemPrompt: "test",
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "max" } });

		expect(harness.lastOptions()?.thinkingLevel).toBe("high");
	});

	it("passes max through to the harness when the model verifies it (regression: stale max -> xhigh mapping)", async () => {
		const harness = createFakeHarness({ runs: [{ text: "done" }] });
		const capable = { ...model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as Model<string>;
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => capable,
			systemPrompt: "test",
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "max" } });

		expect(harness.lastOptions()?.thinkingLevel).toBe("max");
	});

	it("leaves the thinking level undefined when no effort is requested (provider default)", async () => {
		const harness = createFakeHarness({ runs: [{ text: "done" }] });
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(harness.lastOptions()?.thinkingLevel).toBeUndefined();
	});

	it("forwards the model's reasoning trace as a reasoning activity (on thinking_end)", async () => {
		const harness = createFakeHarness({ runs: [{ thinking: "weigh the options, then act", text: "done" }] });
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "high" } });

		expect(activity).toContainEqual({ kind: "reasoning", text: "weigh the options, then act" });
	});

	it("ignores an empty thinking segment", async () => {
		const harness = createFakeHarness({ runs: [{ thinking: "   \n", text: "done" }] });
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
			createHarness: harness.factory,
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap" } });

		expect(activity.filter((event) => event.kind === "reasoning")).toEqual([]);
	});
});

describe("PiAgent.dispatch failure modes (only a completed run is a dispatch)", () => {
	function agentFor(harness: ReturnType<typeof createFakeHarness>): PiAgent {
		return new PiAgent({
			env,
			models,
			resolveModel: () => model,
			systemPrompt: "test",
			createHarness: harness.factory,
		});
	}

	it("fails the dispatch when the harness rejects the run", async () => {
		const busy = new LaneBusy({ lane: "main", operationId: "op-1", operationKind: "run", message: "lane is busy" });
		const harness = createFakeHarness({ runs: [{ result: { ok: false, error: busy } }] });

		await expect(agentFor(harness).dispatch({ prompt: "go", config: { model: "m" } })).rejects.toThrow(/LaneBusy/);
	});

	it("fails the dispatch on a failed outcome, surfacing the harness error", async () => {
		const harness = createFakeHarness({
			runs: [
				{
					result: {
						ok: true,
						value: {
							runId: "run-1",
							kind: "failed",
							leafId: "leaf-1",
							error: { code: "provider_error", message: "upstream exploded" },
						},
					},
				},
			],
		});

		await expect(agentFor(harness).dispatch({ prompt: "go", config: { model: "m" } })).rejects.toThrow(
			/failed: \[provider_error\] upstream exploded/,
		);
	});

	it("fails the dispatch on an aborted outcome, even though it carries a final message", async () => {
		const harness = createFakeHarness({
			runs: [
				{
					result: {
						ok: true,
						value: {
							runId: "run-1",
							kind: "aborted",
							leafId: "leaf-1",
							finalEntryId: "entry-1",
							finalMessage: fauxAssistantMessage("I stopped early but here is a summary"),
						},
					},
				},
			],
		});

		await expect(agentFor(harness).dispatch({ prompt: "go", config: { model: "m" } })).rejects.toThrow(
			/did not complete \(aborted\)/,
		);
	});

	it("fails the dispatch on a suspended outcome (deferred provider work anvil does not resume)", async () => {
		const harness = createFakeHarness({
			runs: [
				{
					result: {
						ok: true,
						value: {
							runId: "run-1",
							kind: "suspended",
							leafId: "leaf-1",
							finalEntryId: "entry-1",
							deferred: { provider: "faux", id: "deferred-1" } as never,
						},
					},
				},
			],
		});

		await expect(agentFor(harness).dispatch({ prompt: "go", config: { model: "m" } })).rejects.toThrow(
			/did not complete \(suspended\)/,
		);
	});

	it("releases the harness even when the run fails", async () => {
		const harness = createFakeHarness({ runs: [{ throws: new Error("transport died") }] });

		await expect(agentFor(harness).dispatch({ prompt: "go", config: { model: "m" } })).rejects.toThrow(
			"transport died",
		);
		expect(harness.log.closes).toBe(1);
	});

	it("aborts the harness when the dispatch signal is already aborted", async () => {
		const harness = createFakeHarness({ runs: [{ text: "done" }] });
		const controller = new AbortController();
		controller.abort();

		await agentFor(harness).dispatch({ prompt: "go", config: { model: "m" }, signal: controller.signal });

		expect(harness.log.aborts).toBe(1);
	});

	it("tolerates a rejected abort (nothing was running) without failing the dispatch", async () => {
		const harness = createFakeHarness({
			runs: [{ text: "done" }],
			abort: { ok: false, error: new NoActiveOperation({ lane: "main", message: "no active operation" }) },
		});
		const controller = new AbortController();
		controller.abort();

		const res = await agentFor(harness).dispatch({
			prompt: "go",
			config: { model: "m" },
			signal: controller.signal,
		});

		expect(res.text).toBe("done");
		expect(harness.log.aborts).toBe(1);
	});

	it("tolerates an abort that throws (harness already closed)", async () => {
		const harness = createFakeHarness({ runs: [{ text: "done" }], abortThrows: new Error("harness closed") });
		const controller = new AbortController();
		controller.abort();

		const res = await agentFor(harness).dispatch({
			prompt: "go",
			config: { model: "m" },
			signal: controller.signal,
		});

		expect(res.text).toBe("done");
	});
});
