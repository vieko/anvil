import { describe, expect, it } from "vitest";
import { runToGate } from "../src/run-to-gate.ts";
import type { Agent, Gate, GateResult, ModelEffort, RunRecord, StatePersister, Workspace } from "../src/types.ts";

// Frozen contract (anvil dogfood): the DEFAULT base must run sonnet at HIGH
// effort so attempt 0 reasons by default, and the default-cap escalation ladder
// must be sonnet/high -> opus/high -> opus/xhigh. Drives runToGate with NO base
// (so it relies on DEFAULT_BASE) and records the dispatched config per attempt.

function fakeWorkspace(): Workspace {
	return {
		cwd: "/tmp/anvil-default-base-contract",
		async exec() {
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		async readText() {
			return null;
		},
		async exists() {
			return false;
		},
		async commit() {
			return true;
		},
		async cleanup() {},
	};
}

function nullPersister(): StatePersister {
	return {
		async save(_record: RunRecord) {},
	};
}

describe("default base (frozen contract)", () => {
	it("dispatches sonnet/high on attempt 0, then opus/high, then opus/xhigh", async () => {
		const seen: ModelEffort[] = [];
		const agent: Agent = {
			async dispatch(d) {
				seen.push(d.config);
				return { text: "x" };
			},
		};
		let calls = 0;
		const gate: Gate = {
			async verify(): Promise<GateResult> {
				calls++;
				return calls < 3
					? { passed: false, errors: `fail ${calls}`, commands: [] }
					: { passed: true, errors: "", commands: [] };
			},
		};

		const res = await runToGate(
			{ id: "default-base", prompt: "p" },
			{ agent, workspace: fakeWorkspace(), gate, persist: nullPersister() },
		);

		expect(res.passed).toBe(true);
		expect(seen).toEqual([
			{ model: "sonnet", effort: "high" },
			{ model: "opus", effort: "high" },
			{ model: "opus", effort: "xhigh" },
		]);
	});
});
