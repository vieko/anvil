import { describe, expect, it } from "vitest";
import { classifyDispatch, runToGate } from "../src/run-to-gate.ts";
import type { Agent, Gate, GateResult, ModelEffort, RunRecord, StatePersister, Workspace } from "../src/types.ts";

function fakeWorkspace(): Workspace & { committed: string[] } {
	const committed: string[] = [];
	return {
		cwd: "/tmp/anvil-fake",
		committed,
		async exec() {
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		async readText() {
			return null;
		},
		async exists() {
			return false;
		},
		async commit(message: string) {
			committed.push(message);
			return true;
		},
		async cleanup() {},
	};
}

function recordingPersister(): StatePersister & { states: string[] } {
	const states: string[] = [];
	return {
		states,
		async save(r: RunRecord) {
			states.push(r.state);
		},
	};
}

const passingGate: Gate = {
	async verify(): Promise<GateResult> {
		return { passed: true, errors: "", commands: [] };
	},
};

describe("runToGate", () => {
	it("passes on the first attempt when the gate is green, and commits", async () => {
		const agent: Agent = {
			async dispatch() {
				return { text: "done" };
			},
		};
		const ws = fakeWorkspace();
		const persist = recordingPersister();

		const res = await runToGate(
			{ id: "t1", prompt: "do the thing" },
			{ agent, workspace: ws, gate: passingGate, persist },
		);

		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(1);
		expect(ws.committed).toEqual(["anvil: t1"]);
		expect(persist.states).toEqual(["running", "verifying", "passed"]);
	});

	it("loops, escalates model AND effort, and feeds errors back until the gate goes green", async () => {
		const seenConfigs: ModelEffort[] = [];
		let verifyCalls = 0;
		const agent: Agent = {
			async dispatch(d) {
				seenConfigs.push(d.config);
				return { text: "attempt", sessionId: "s1" };
			},
		};
		const gate: Gate = {
			async verify(): Promise<GateResult> {
				verifyCalls++;
				return verifyCalls < 3
					? { passed: false, errors: `boom ${verifyCalls}`, commands: [] }
					: { passed: true, errors: "", commands: [] };
			},
		};

		const res = await runToGate(
			{ id: "t2", prompt: "fix it", base: { model: "sonnet", effort: "low" } },
			{ agent, workspace: fakeWorkspace(), gate, persist: recordingPersister() },
		);

		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(3);
		// Monotonic strengthening of BOTH dimensions, not just the model.
		expect(seenConfigs).toEqual([
			{ model: "sonnet", effort: "low" },
			{ model: "sonnet", effort: "high" },
			{ model: "opus", effort: "high" },
		]);
		expect(res.finalConfig).toEqual({ model: "opus", effort: "high" });
	});

	it("feeds the gate's error text into the retry prompt (root-cause feedback)", async () => {
		const prompts: string[] = [];
		let verifyCalls = 0;
		const agent: Agent = {
			async dispatch(d) {
				prompts.push(d.prompt);
				return { text: "x" };
			},
		};
		const gate: Gate = {
			async verify(): Promise<GateResult> {
				verifyCalls++;
				return verifyCalls === 1
					? { passed: false, errors: "AssertionError: expected 1 to equal 2", commands: [] }
					: { passed: true, errors: "", commands: [] };
			},
		};

		await runToGate(
			{ id: "fb", prompt: "make the test pass" },
			{ agent, workspace: fakeWorkspace(), gate, persist: recordingPersister() },
		);

		// Attempt 0 dispatched the original prompt verbatim; attempt 1's prompt
		// embeds the failure feedback so the agent has concrete output to fix.
		expect(prompts[0]).toBe("make the test pass");
		expect(prompts[1]).toContain("Verification attempt 1");
		expect(prompts[1]).toContain("AssertionError: expected 1 to equal 2");
		expect(prompts[1]).toContain("make the test pass"); // the outcome is preserved in the retry prompt
	});

	it("pins model/effort across attempts when given a passthrough escalator (no-escalate)", async () => {
		const seenConfigs: ModelEffort[] = [];
		let verifyCalls = 0;
		const agent: Agent = {
			async dispatch(d) {
				seenConfigs.push(d.config);
				return { text: "x" };
			},
		};
		const gate: Gate = {
			async verify(): Promise<GateResult> {
				verifyCalls++;
				return verifyCalls < 3
					? { passed: false, errors: "still red", commands: [] }
					: { passed: true, errors: "", commands: [] };
			},
		};

		const res = await runToGate(
			{ id: "pin", prompt: "p", base: { model: "sonnet", effort: "low" } },
			// A passthrough escalator ignores the attempt index -> the config never climbs.
			{ agent, workspace: fakeWorkspace(), gate, persist: recordingPersister(), escalate: (b) => b },
		);

		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(3);
		for (const c of seenConfigs) {
			expect(c).toEqual({ model: "sonnet", effort: "low" });
		}
	});

	it("gives up after maxAttempts and returns the last gate errors", async () => {
		const agent: Agent = {
			async dispatch() {
				return { text: "x" };
			},
		};
		const gate: Gate = {
			async verify(): Promise<GateResult> {
				return { passed: false, errors: "still broken", commands: [] };
			},
		};

		const res = await runToGate(
			{ id: "t3", prompt: "p" },
			{ agent, workspace: fakeWorkspace(), gate, persist: recordingPersister() },
			{ maxAttempts: 2 },
		);

		expect(res.passed).toBe(false);
		expect(res.attempts).toBe(2);
		expect(res.errors).toBe("still broken");
	});

	it("re-verifies an inconclusive gate instead of treating it as a fixable failure", async () => {
		const prompts: string[] = [];
		let verifyCalls = 0;
		const agent: Agent = {
			async dispatch(d) {
				prompts.push(d.prompt);
				return { text: "x" };
			},
		};
		const gate: Gate = {
			async verify(): Promise<GateResult> {
				verifyCalls++;
				if (verifyCalls === 1) return { passed: false, errors: "flake", commands: [], inconclusive: true };
				return { passed: true, errors: "", commands: [] };
			},
		};

		const res = await runToGate(
			{ id: "t4", prompt: "ORIGINAL" },
			{ agent, workspace: fakeWorkspace(), gate, persist: recordingPersister() },
		);

		expect(res.passed).toBe(true);
		// The inconclusive verdict must not have rewritten the prompt with error feedback.
		expect(prompts.every((p) => p === "ORIGINAL")).toBe(true);
	});

	it("treats an empty no-cost dispatch as a non-pass (#19 false-pass guard), not a silent pass", async () => {
		let n = 0;
		const agent: Agent = {
			async dispatch() {
				n++;
				return n === 1
					? { text: "", usage: { input: 0, output: 0, cacheRead: 0 } }
					: { text: "done", usage: { input: 10, output: 5, cacheRead: 0 } };
			},
		};
		const ws = fakeWorkspace();

		// passingGate would commit on attempt 0 if the empty turn reached it.
		const res = await runToGate(
			{ id: "g1", prompt: "p" },
			{ agent, workspace: ws, gate: passingGate, persist: recordingPersister() },
		);

		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(2); // attempt 0 guarded; the pass came on the real attempt 1
		expect(ws.committed).toEqual(["anvil: g1"]); // exactly one commit, on the real turn
	});

	it("treats API-error result text as a non-pass, not a verified success", async () => {
		let verifyCalls = 0;
		let n = 0;
		const agent: Agent = {
			async dispatch() {
				n++;
				return n === 1 ? { text: "API Error: 503 overloaded_error" } : { text: "done" };
			},
		};
		const gate: Gate = {
			async verify(): Promise<GateResult> {
				verifyCalls++;
				return { passed: true, errors: "", commands: [] };
			},
		};

		const res = await runToGate(
			{ id: "g2", prompt: "p" },
			{ agent, workspace: fakeWorkspace(), gate, persist: recordingPersister() },
		);

		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(2);
		expect(verifyCalls).toBe(1); // the gate ran only for the real turn, not the API-error turn
	});
});

describe("classifyDispatch", () => {
	it("flags empty text with zero tokens as 'empty' (the turn never ran)", () => {
		expect(classifyDispatch({ text: "  ", usage: { input: 0, output: 0, cacheRead: 0 } })).toBe("empty");
		expect(classifyDispatch({ text: "" })).toBe("empty");
	});

	it("flags result text that is itself a provider error as 'api-error'", () => {
		expect(classifyDispatch({ text: "API Error: overloaded_error" })).toBe("api-error");
		expect(classifyDispatch({ text: "503 Internal Server Error" })).toBe("api-error");
	});

	it("treats real output as 'ok', including a short non-empty answer with no usage reported", () => {
		expect(classifyDispatch({ text: "done" })).toBe("ok");
		expect(classifyDispatch({ text: "implemented sum", usage: { input: 10, output: 5, cacheRead: 0 } })).toBe("ok");
		const long = "I fixed the failing assertion and the tests pass now. ".repeat(8);
		expect(classifyDispatch({ text: long })).toBe("ok");
	});
});
