import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentActivity, ModelEffort } from "../src/index.ts";
import { PiAgent } from "../src/node/pi-agent.ts";

// Drives the real AgentHarness against pi-ai's faux provider — no network, no
// API key, no tools. Exercises the Agent seam: text/usage/sessionId extraction,
// provider-agnostic model resolution, and resume reusing a session.

let faux: ReturnType<typeof registerFauxProvider>;
let model: Model<string>;
let env: NodeExecutionEnv;

beforeEach(() => {
	faux = registerFauxProvider({
		models: [{ id: "faux-cheap", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
	});
	model = faux.getModel();
	env = new NodeExecutionEnv({ cwd: tmpdir() });
});

afterEach(async () => {
	faux.unregister();
	await env.cleanup();
});

describe("PiAgent.dispatch", () => {
	it("runs one turn and returns text + usage + a session id", async () => {
		faux.setResponses([fauxAssistantMessage("the outcome is done")]);
		const agent = new PiAgent({ env, resolveModel: () => model, systemPrompt: "test" });

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
		const agent = new PiAgent({ env, resolveModel: () => model, systemPrompt: "test" });

		const first = await agent.dispatch({ prompt: "p1", config: { model: "m" } });
		const second = await agent.dispatch({ prompt: "p2", config: { model: "m" }, resume: first.sessionId });

		expect(second.sessionId).toBe(first.sessionId);
	});

	it("starts a fresh session when not resuming", async () => {
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const agent = new PiAgent({ env, resolveModel: () => model, systemPrompt: "test" });

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

	it("forwards the model's reasoning trace as a reasoning activity (on thinking_end)", async () => {
		const reasoning = faux.getModel(); // faux models emit thinking content as thinking_* events
		faux.setResponses([fauxAssistantMessage([fauxThinking("weigh the options, then act"), fauxText("done")])]);
		const activity: AgentActivity[] = [];
		const agent = new PiAgent({
			env,
			resolveModel: () => reasoning,
			systemPrompt: "test",
			onActivity: (event) => activity.push(event),
		});

		await agent.dispatch({ prompt: "go", config: { model: "faux-cheap", effort: "high" } });

		expect(activity).toContainEqual({ kind: "reasoning", text: "weigh the options, then act" });
	});
});
