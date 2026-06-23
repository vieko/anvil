import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStatePersister } from "@anvil/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/run.ts";
import { repoStateDirs } from "../src/state-paths.ts";
import { executeStatus } from "../src/status.ts";

let dir: string;
let xdg: string;
let prevXdg: string | undefined;

function capture(): { io: Io; lines: string[] } {
	const lines: string[] = [];
	return { lines, io: { out: (l) => lines.push(l), err: (l) => lines.push(l) } };
}

// Pin the user-level state root to a temp dir so the test reads/writes the same
// computed bucket and never touches the real ~/.anvil (issue #7).
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "anvil-status-"));
	xdg = await mkdtemp(join(tmpdir(), "anvil-xdg-"));
	prevXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = xdg;
});
afterEach(async () => {
	if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = prevXdg;
	await rm(dir, { recursive: true, force: true });
	await rm(xdg, { recursive: true, force: true });
});

describe("executeStatus", () => {
	it("reports when nothing is recorded", async () => {
		const { io, lines } = capture();
		expect(await executeStatus(dir, io)).toBe(0);
		expect(lines).toContain("no runs recorded");
	});

	it("lists recorded runs newest first with a verdict mark", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save({
			outcomeId: "older",
			state: "failed",
			attempt: 2,
			maxAttempts: 3,
			config: { model: "opus" },
			updatedAt: "2026-01-01T00:00:00Z",
		});
		await persist.save({
			outcomeId: "newer",
			state: "passed",
			attempt: 0,
			maxAttempts: 3,
			config: { model: "sonnet" },
			updatedAt: "2026-01-02T00:00:00Z",
		});

		const { io, lines } = capture();
		expect(await executeStatus(dir, io)).toBe(0);
		expect(lines[0]).toContain("+ passed");
		expect(lines[0]).toContain("newer");
		expect(lines[1]).toContain("x failed");
		expect(lines[1]).toContain("older");
	});

	it("--json emits the record ledger as a JSON array (empty array when none)", async () => {
		const empty = capture();
		expect(await executeStatus(dir, empty.io, true)).toBe(0);
		expect(JSON.parse(empty.lines[0])).toEqual([]);

		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save({
			outcomeId: "feat",
			state: "passed",
			attempt: 0,
			maxAttempts: 3,
			config: { model: "sonnet" },
			branch: "anvil/feat/xyz",
			updatedAt: "2026-01-02T00:00:00Z",
		});
		const { io, lines } = capture();
		expect(await executeStatus(dir, io, true)).toBe(0);
		const records = JSON.parse(lines[0]);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ outcomeId: "feat", state: "passed", branch: "anvil/feat/xyz" });
	});
});
