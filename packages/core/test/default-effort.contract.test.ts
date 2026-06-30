import { describe, expect, it } from "vitest";
import { runToGate } from "../src/run-to-gate.ts";
import type { Agent, Gate, GateResult, ModelEffort, RunRecord, StatePersister, Workspace } from "../src/types.ts";

// Frozen contract (#18): an unset base effort must normalize to a single
// DEFAULT_EFFORT ("high") at the runToGate boundary, so a base with a model but
// no effort (e.g. `--model opus` and no `--effort`) dispatches at high on
// attempt 0 -- no more thinking-off-by-accident. Explicit effort is untouched
// (the gentle ladder stays available via `--effort low`).

function fakeWorkspace(): Workspace {
	return {
		cwd: "/tmp/anvil-default-effort-contract",
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

function recordingAgent(seen: ModelEffort[]): Agent {
	return {
		async dispatch(d) {
			seen.push(d.config);
			return { text: "x" };
		},
	};
}

function gatePassingOnAttempt(pass: number): Gate {
	let calls = 0;
	return {
		async verify(): Promise<GateResult> {
			calls++;
			return calls < pass
				? { passed: false, errors: `fail ${calls}`, commands: [] }
				: { passed: true, errors: "", commands: [] };
		},
	};
}

describe("default effort (frozen contract)", () => {
	it("normalizes an unset base effort to high so attempt 0 reasons", async () => {
		const seen: ModelEffort[] = [];
		const res = await runToGate(
			{ id: "no-effort", prompt: "p", base: { model: "opus" } },
			{
				agent: recordingAgent(seen),
				workspace: fakeWorkspace(),
				gate: gatePassingOnAttempt(1),
				persist: nullPersister(),
			},
		);
		expect(res.passed).toBe(true);
		expect(seen[0]).toEqual({ model: "opus", effort: "high" });
	});

	it("leaves an explicit base effort untouched (gentle ladder still climbs from it)", async () => {
		const seen: ModelEffort[] = [];
		await runToGate(
			{ id: "low", prompt: "p", base: { model: "sonnet", effort: "low" } },
			{
				agent: recordingAgent(seen),
				workspace: fakeWorkspace(),
				gate: gatePassingOnAttempt(3),
				persist: nullPersister(),
			},
		);
		expect(seen).toEqual([
			{ model: "sonnet", effort: "low" },
			{ model: "sonnet", effort: "high" },
			{ model: "opus", effort: "high" },
		]);
	});
});
