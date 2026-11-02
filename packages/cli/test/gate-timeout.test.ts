import type { ExecOptions, RunRecord, Workspace } from "@anvil/core";
import { WorktreeWorkspace } from "@anvil/core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "../src/cli.ts";
import { executeRun } from "../src/run.ts";
import { buildRunDeps } from "../src/wiring.ts";

afterEach(() => vi.restoreAllMocks());

describe("gate timeout wiring and provenance", () => {
	it.each([
		{ duration: "300", explicit: true, timeoutMs: 300_000, passed: true },
		{ duration: "300s", explicit: false, timeoutMs: 300_000, passed: true },
		{ duration: "10m", explicit: true, timeoutMs: 600_000, passed: true },
		{ duration: undefined, explicit: true, timeoutMs: 120_000, passed: false },
		{ duration: undefined, explicit: false, timeoutMs: 120_000, passed: false },
	])("uses $timeoutMs ms (explicit: $explicit)", async ({ duration, explicit, timeoutMs, passed }) => {
		// Model a 150-second gate without a real command or a wall-clock wait.
		const exec = vi.fn(async (_command: string, options?: ExecOptions) =>
			(options?.timeoutMs ?? 0) >= 150_000
				? { stdout: "ok", stderr: "", exitCode: 0 }
				: { stdout: "", stderr: "timed out", exitCode: -1, error: "timeout" as const },
		);
		const workspace: Workspace = {
			cwd: "/fake/repo-worktree",
			branch: "anvil/timeout/test",
			exec,
			readText: async () => JSON.stringify({ scripts: { test: "vitest run" } }),
			exists: async () => false,
			commit: async () => true,
			cleanup: async () => {},
		};
		vi.spyOn(WorktreeWorkspace, "create").mockResolvedValue(workspace as WorktreeWorkspace);
		const argv = ["run", "timeout", "--json"];
		if (duration) argv.push("--gate-timeout", duration);
		if (explicit) argv.push("--verify", "npm test");
		const command = parse(argv);
		if (command.kind !== "run") throw new Error("expected run command");
		const { deps } = await buildRunDeps("timeout", "/fake/repo", command.options);
		const dispatch = vi.fn(async () => ({ text: "ok" }));
		const records: RunRecord[] = [];
		const out: string[] = [];
		const code = await executeRun(
			{ id: "timeout", prompt: "p" },
			command.options,
			{
				...deps,
				agent: { dispatch },
				persist: {
					save: async (record) => {
						records.push(record);
					},
				},
			},
			{ out: (line) => out.push(line), err: () => {} },
		);
		expect(code).toBe(passed ? 0 : 1);
		expect(dispatch).toHaveBeenCalledTimes(passed ? 1 : 0);
		expect(exec).toHaveBeenCalled();
		for (const [cmd, options] of exec.mock.calls) {
			expect(cmd).toBe("npm test");
			expect(options?.timeoutMs).toBe(timeoutMs);
		}
		expect(records.length).toBeGreaterThan(0);
		for (const record of records) expect(record.gateTimeoutMs).toBe(timeoutMs);
		expect(records.at(-1)?.state).toBe(passed ? "passed" : "failed");
		expect(JSON.parse(out[0])).toMatchObject({
			passed,
			gate: { commands: ["npm test"], source: explicit ? "explicit" : "autodetect", timeoutMs },
		});
		if (!passed) expect(JSON.parse(out[0]).errors).toContain("inconclusive");
	});
});
