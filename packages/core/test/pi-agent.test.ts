import { tmpdir } from "node:os";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEffort } from "../src/index.ts";
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
});
