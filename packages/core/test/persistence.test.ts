import { describe, expect, it } from "vitest";
import type { Agent, Gate, GateResult, RunRecord, Workspace } from "../src/index.ts";
import { MemoryStatePersister, nullStatePersister, runToGate } from "../src/index.ts";

function record(partial: Partial<RunRecord> & Pick<RunRecord, "outcomeId" | "state">): RunRecord {
	return {
		attempt: 0,
		maxAttempts: 3,
		config: { model: "sonnet" },
		attempts: [],
		updatedAt: new Date().toISOString(),
		...partial,
	};
}

function fakeWorkspace(): Workspace {
	return {
		cwd: "/tmp/fake",
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

const passingGate: Gate = {
	async verify(): Promise<GateResult> {
		return { passed: true, errors: "", commands: [] };
	},
};

describe("MemoryStatePersister", () => {
	it("returns the latest record per outcome and lists newest first", async () => {
		const p = new MemoryStatePersister();
		await p.save(record({ outcomeId: "a", state: "running", updatedAt: "2026-01-01T00:00:00Z" }));
		await p.save(record({ outcomeId: "a", state: "passed", attempt: 1, updatedAt: "2026-01-02T00:00:00Z" }));
		await p.save(record({ outcomeId: "b", state: "failed", updatedAt: "2026-01-03T00:00:00Z" }));

		expect((await p.load("a"))?.state).toBe("passed");
		expect(await p.load("missing")).toBeNull();
		expect((await p.list()).map((r) => r.outcomeId)).toEqual(["b", "a"]);
	});
});

describe("runToGate resume", () => {
	function spyAgent(): Agent & { calls: { config: string; resume?: string }[] } {
		const calls: { config: string; resume?: string }[] = [];
		return {
			calls,
			async dispatch(d) {
				calls.push({ config: d.config.model, resume: d.resume });
				return { text: "ok", sessionId: d.resume ?? "new-session" };
			},
		};
	}

	it("returns immediately for a terminal `passed` record without dispatching", async () => {
		const persist = new MemoryStatePersister();
		await persist.save(record({ outcomeId: "t", state: "passed", attempt: 1, config: { model: "opus" } }));
		const agent = spyAgent();

		const res = await runToGate(
			{ id: "t", prompt: "p" },
			{ agent, workspace: fakeWorkspace(), gate: passingGate, persist },
			{ resume: true },
		);

		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(2);
		expect(agent.calls).toHaveLength(0);
	});

	it("returns the failure for a terminal `failed` record without dispatching", async () => {
		const persist = new MemoryStatePersister();
		await persist.save(record({ outcomeId: "t", state: "failed", attempt: 2, errors: "nope" }));
		const agent = spyAgent();

		const res = await runToGate(
			{ id: "t", prompt: "p" },
			{ agent, workspace: fakeWorkspace(), gate: passingGate, persist },
			{ resume: true },
		);

		expect(res.passed).toBe(false);
		expect(res.errors).toBe("nope");
		expect(agent.calls).toHaveLength(0);
	});

	it("continues a `retrying` record at the next attempt, reusing the session", async () => {
		const persist = new MemoryStatePersister();
		await persist.save(record({ outcomeId: "t", state: "retrying", attempt: 0, errors: "boom", sessionId: "s0" }));
		const agent = spyAgent();

		const res = await runToGate(
			{ id: "t", prompt: "p", base: { model: "sonnet", effort: "low" } },
			{ agent, workspace: fakeWorkspace(), gate: passingGate, persist },
			{ resume: true },
		);

		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(2); // resumed at attempt index 1, passed -> 2
		expect(agent.calls).toHaveLength(1);
		expect(agent.calls[0]).toEqual({ config: "sonnet", resume: "s0" }); // escalate(low, 1) = sonnet@high
	});

	it("rehydrates prior attempts on resume (#12), appending new entries after the loaded history", async () => {
		const prior = [
			{
				attempt: 0,
				config: { model: "sonnet", effort: "low" as const },
				verdict: "retrying" as const,
				usage: { input: 5, output: 2, cacheRead: 0 },
				errors: "boom",
				startedAt: "2026-01-01T00:00:00Z",
				endedAt: "2026-01-01T00:00:01Z",
			},
		];
		const persist = new MemoryStatePersister();
		await persist.save(
			record({ outcomeId: "t", state: "retrying", attempt: 0, errors: "boom", sessionId: "s0", attempts: prior }),
		);
		const agent = spyAgent();

		const res = await runToGate(
			{ id: "t", prompt: "p", base: { model: "sonnet", effort: "low" } },
			{ agent, workspace: fakeWorkspace(), gate: passingGate, persist },
			{ resume: true },
		);

		expect(res.passed).toBe(true);
		expect(res.timeline).toHaveLength(2); // the rehydrated attempt 0 plus the new attempt 1
		expect(res.timeline[0]).toEqual(prior[0]);
		expect(res.timeline[1]).toMatchObject({ attempt: 1, verdict: "passed" });
	});

	it("loads a legacy record with no `attempts` field as an empty history, without error (#12)", async () => {
		const persist = new MemoryStatePersister();
		// Simulate a pre-#12 record on disk: no `attempts` field at all.
		const { attempts: _omit, ...legacy } = record({
			outcomeId: "t",
			state: "retrying",
			attempt: 0,
			errors: "boom",
			sessionId: "s0",
		});
		await persist.save(legacy as RunRecord);
		const agent = spyAgent();

		const res = await runToGate(
			{ id: "t", prompt: "p", base: { model: "sonnet", effort: "low" } },
			{ agent, workspace: fakeWorkspace(), gate: passingGate, persist },
			{ resume: true },
		);

		expect(res.passed).toBe(true);
		expect(res.timeline).toHaveLength(1); // only the new attempt; no crash on the missing field
		expect(res.timeline[0]).toMatchObject({ attempt: 1, verdict: "passed" });
	});

	it("starts fresh when there is no prior record", async () => {
		const agent = spyAgent();
		const res = await runToGate(
			{ id: "fresh", prompt: "p" },
			{ agent, workspace: fakeWorkspace(), gate: passingGate, persist: new MemoryStatePersister() },
			{ resume: true },
		);
		expect(res.passed).toBe(true);
		expect(res.attempts).toBe(1);
		expect(agent.calls[0].resume).toBeUndefined();
	});

	it("nullStatePersister is a valid no-op sink", async () => {
		await nullStatePersister.save(record({ outcomeId: "x", state: "running" }));
		expect(await nullStatePersister.load?.("x")).toBeNull();
		expect(await nullStatePersister.list?.()).toEqual([]);
	});
});
