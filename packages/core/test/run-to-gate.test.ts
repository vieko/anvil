import { describe, expect, it } from "vitest";
import { runToGate } from "../src/run-to-gate.ts";
import type { Agent, Gate, GateResult, RunRecord, StatePersister, Workspace } from "../src/types.ts";

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

	it("loops, escalates the model, and feeds errors back until the gate goes green", async () => {
		const seenModels: string[] = [];
		let verifyCalls = 0;
		const agent: Agent = {
			async dispatch(d) {
				seenModels.push(d.config.model);
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
		// Monotonic strengthening: sonnet@low -> sonnet@high -> opus@high
		expect(seenModels).toEqual(["sonnet", "sonnet", "opus"]);
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
});
