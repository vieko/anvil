import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "@anvil/core";
import { FileStatePersister } from "@anvil/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/run.ts";
import { repoStateDirs, stateRoot } from "../src/state-paths.ts";
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
			attempts: [],
			updatedAt: "2026-01-01T00:00:00Z",
		});
		await persist.save({
			outcomeId: "newer",
			state: "passed",
			attempt: 0,
			maxAttempts: 3,
			config: { model: "sonnet" },
			attempts: [],
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
		expect(await executeStatus(dir, empty.io, { json: true })).toBe(0);
		expect(JSON.parse(empty.lines[0])).toEqual([]);

		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		// A record's attempts[] (#12 Tier 3) is not summarized or reshaped by status --
		// it just dumps the record, so this also pins that the per-attempt history
		// round-trips through `status --json` untouched.
		await persist.save({
			outcomeId: "feat",
			state: "passed",
			attempt: 0,
			maxAttempts: 3,
			config: { model: "sonnet" },
			attempts: [
				{
					attempt: 0,
					config: { model: "sonnet" },
					verdict: "passed",
					usage: { input: 10, output: 5, cacheRead: 0 },
					startedAt: "2026-01-02T00:00:00Z",
					endedAt: "2026-01-02T00:00:01Z",
				},
			],
			branch: "anvil/feat/xyz",
			updatedAt: "2026-01-02T00:00:00Z",
		});
		const { io, lines } = capture();
		expect(await executeStatus(dir, io, { json: true })).toBe(0);
		const records = JSON.parse(lines[0]);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ outcomeId: "feat", state: "passed", branch: "anvil/feat/xyz" });
		expect(records[0].attempts).toEqual([
			expect.objectContaining({ attempt: 0, verdict: "passed", usage: { input: 10, output: 5, cacheRead: 0 } }),
		]);
	});
});

describe("executeStatus stale detection and --prune (#41)", () => {
	const record = (over: Partial<RunRecord>): RunRecord => ({
		outcomeId: "feat",
		state: "verifying",
		attempt: 2,
		maxAttempts: 3,
		config: { model: "fable" },
		attempts: [],
		updatedAt: "2026-01-01T00:00:00Z",
		...over,
	});

	it("renders a non-terminal record with a dead pid as stale, with its age", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		// A pid outside any realistic OS range is guaranteed dead.
		await persist.save(record({ pid: 999_999 }));

		const { io, lines } = capture();
		const now = new Date("2026-01-17T00:00:00Z"); // 16 days later
		expect(await executeStatus(dir, io, { now })).toBe(0);
		expect(lines[0]).toMatch(/^! stale 16d\s+feat\s/);
		expect(lines.at(-1)).toBe("1 run, 0 passed, 0 failed, 1 stale");
	});

	it("renders a pidless non-terminal record older than the threshold as stale", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save(record({ updatedAt: "2026-01-01T00:00:00Z" })); // no pid

		const stale = capture();
		const past31m = new Date("2026-01-01T00:31:00Z");
		expect(await executeStatus(dir, stale.io, { now: past31m })).toBe(0);
		expect(stale.lines[0]).toMatch(/^! stale 31m\s+feat\s/);

		const fresh = capture();
		const past29m = new Date("2026-01-01T00:29:00Z");
		await executeStatus(dir, fresh.io, { now: past29m });
		expect(fresh.lines[0]).toContain("> verifying");
	});

	it("a live pid with a recent heartbeat stays verifying, never stale", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save(record({ pid: process.pid, updatedAt: "2026-01-01T00:00:00Z" }));

		const { io, lines } = capture();
		expect(await executeStatus(dir, io, { now: new Date("2026-01-01T01:00:00Z") })).toBe(0); // 1h old
		expect(lines[0]).toContain("> verifying");
	});

	it("a live pid with a heartbeat older than 24h is stale (pid reuse after a reboot)", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save(record({ pid: process.pid, updatedAt: "2026-01-01T00:00:00Z" }));

		const { io, lines } = capture();
		expect(await executeStatus(dir, io, { now: new Date("2026-01-02T01:00:00Z") })).toBe(0); // 25h old
		expect(lines[0]).toMatch(/^! stale 1d\s+feat\s/);
	});

	it("--prune rewrites only stale records to failed with an orphaned note, leaving others untouched", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		const now = new Date("2026-01-17T00:00:00Z");
		await persist.save(record({ outcomeId: "dead", pid: 999_999 }));
		// A recent heartbeat, or the live pid would itself be flagged as reused (>24h idle).
		await persist.save(record({ outcomeId: "alive", pid: process.pid, updatedAt: now.toISOString() }));
		await persist.save({
			outcomeId: "already-passed",
			state: "passed",
			attempt: 0,
			maxAttempts: 3,
			config: { model: "fable" },
			attempts: [],
			updatedAt: "2026-01-01T00:00:00Z",
		});

		const { io, lines } = capture();
		expect(await executeStatus(dir, io, { prune: true, now })).toBe(0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("pruned");
		expect(lines[0]).toContain("dead");

		const records = await persist.list();
		const dead = records.find((r) => r.outcomeId === "dead");
		const alive = records.find((r) => r.outcomeId === "alive");
		const passed = records.find((r) => r.outcomeId === "already-passed");
		expect(dead?.state).toBe("failed");
		expect(dead?.note).toBe(`orphaned: process gone, marked by anvil status --prune ${now.toISOString()}`);
		expect(alive?.state).toBe("verifying");
		expect(alive?.note).toBeUndefined();
		expect(passed?.state).toBe("passed");
		expect(passed?.note).toBeUndefined();
	});

	it("--prune reports nothing to do when no row is stale", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		const now = new Date("2026-01-01T00:00:00Z");
		await persist.save(record({ pid: process.pid, updatedAt: now.toISOString() }));

		const { io, lines } = capture();
		expect(await executeStatus(dir, io, { prune: true, now })).toBe(0);
		expect(lines).toEqual(["no stale runs to prune"]);
	});
});

describe("executeStatus spend ledger", () => {
	const record = (over: Partial<RunRecord>): RunRecord => ({
		outcomeId: "feat",
		state: "passed",
		attempt: 0,
		maxAttempts: 3,
		config: { model: "fable" },
		attempts: [],
		updatedAt: "2026-03-01T00:00:00Z",
		...over,
	});

	it("appends context tokens and cost per row, omitting each when unknown, plus a spend footer", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save(
			record({
				outcomeId: "priced",
				usage: { input: 1_200_000, output: 40_000, cacheRead: 1_000_000, cacheWrite: 100_000, cost: 4.2149 },
				updatedAt: "2026-03-03T00:00:00Z",
			}),
		);
		await persist.save(
			record({
				outcomeId: "tokens-only",
				state: "failed",
				attempt: 2,
				config: { model: "sonnet" },
				usage: { input: 812, output: 40, cacheRead: 0 },
				updatedAt: "2026-03-02T00:00:00Z",
			}),
		);
		// A live pid (this test process) with a recent heartbeat keeps a
		// non-terminal record reporting its real state instead of being flagged
		// `stale` -- this test is about the spend-ledger columns, not staleness.
		await persist.save(
			record({ outcomeId: "bare", state: "running", updatedAt: "2026-03-01T00:00:00Z", pid: process.pid }),
		);

		const { io, lines } = capture();
		expect(await executeStatus(dir, io, { now: new Date("2026-03-01T00:05:00Z") })).toBe(0);
		expect(lines).toEqual([
			"+ passed    priced  (attempt 1/3, fable)  2.3M ctx  $4.21",
			"x failed    tokens-only  (attempt 3/3, sonnet)  812 ctx",
			"> running   bare  (attempt 1/3, fable)",
			"3 runs, 1 passed, 1 failed, $4.21",
		]);
	});

	it("footer sums the known costs and drops the $ total when none is known", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save(record({ outcomeId: "a", usage: { input: 1, output: 1, cacheRead: 0, cost: 1.01 } }));
		await persist.save(
			record({ outcomeId: "b", state: "failed", usage: { input: 1, output: 1, cacheRead: 0, cost: 2 } }),
		);
		const priced = capture();
		await executeStatus(dir, priced.io);
		expect(priced.lines.at(-1)).toBe("2 runs, 1 passed, 1 failed, $3.01");

		await rm(repoStateDirs(dir).runsDir, { recursive: true, force: true });
		await persist.save(record({ outcomeId: "c" }));
		const unpriced = capture();
		await executeStatus(dir, unpriced.io);
		expect(unpriced.lines.at(-1)).toBe("1 run, 1 passed, 0 failed");
	});

	it("--since filters by updatedAt with a duration (relative to now) or an ISO date; --json too", async () => {
		const persist = new FileStatePersister({ dir: repoStateDirs(dir).runsDir });
		await persist.save(record({ outcomeId: "old", updatedAt: "2026-03-01T00:00:00Z" }));
		await persist.save(record({ outcomeId: "recent", updatedAt: "2026-03-08T00:00:00Z" }));
		await persist.save(record({ outcomeId: "today", updatedAt: "2026-03-10T09:00:00Z" }));
		const now = new Date("2026-03-10T12:00:00Z");

		const week = capture();
		expect(await executeStatus(dir, week.io, { since: "7d", now })).toBe(0);
		expect(week.lines.slice(0, -1).map((l) => l.split(/\s+/)[2])).toEqual(["today", "recent"]);
		expect(week.lines.at(-1)).toBe("2 runs, 2 passed, 0 failed");

		const day = capture();
		await executeStatus(dir, day.io, { since: "24h", now });
		expect(day.lines.slice(0, -1).map((l) => l.split(/\s+/)[2])).toEqual(["today"]);

		// An ISO date is inclusive of records updated exactly at that instant.
		const iso = capture();
		await executeStatus(dir, iso.io, { since: "2026-03-08T00:00:00Z", now });
		expect(iso.lines.slice(0, -1).map((l) => l.split(/\s+/)[2])).toEqual(["today", "recent"]);

		const json = capture();
		await executeStatus(dir, json.io, { json: true, since: "2026-03-09", now });
		expect(JSON.parse(json.lines[0]).map((r: RunRecord) => r.outcomeId)).toEqual(["today"]);

		const bad = capture();
		expect(await executeStatus(dir, bad.io, { since: "soon", now })).toBe(2);
		expect(bad.lines[0]).toContain("--since");
	});

	it("--all reads every encoded repo bucket under the state root, prefixing rows with the repo basename", async () => {
		// Two "repos" (real dirs, so the lossy bucket name decodes back to their
		// dashed basenames) plus a stray non-bucket directory that must be ignored.
		const alpha = join(dir, "alpha-app");
		const beta = join(dir, "beta");
		await mkdir(alpha);
		await mkdir(beta);
		await mkdir(join(stateRoot(), "not-a-bucket"), { recursive: true });
		await new FileStatePersister({ dir: repoStateDirs(alpha).runsDir }).save(
			record({
				outcomeId: "a1",
				usage: { input: 5_000, output: 10, cacheRead: 0, cost: 1.5 },
				updatedAt: "2026-03-02T00:00:00Z",
			}),
		);
		await new FileStatePersister({ dir: repoStateDirs(beta).runsDir }).save(
			record({
				outcomeId: "b1",
				state: "failed",
				config: { model: "sonnet" },
				usage: { input: 500, output: 10, cacheRead: 0, cost: 0.25 },
				updatedAt: "2026-03-03T00:00:00Z",
			}),
		);
		await new FileStatePersister({ dir: repoStateDirs(beta).runsDir }).save(
			record({ outcomeId: "b0", updatedAt: "2026-02-01T00:00:00Z" }),
		);

		const { io, lines } = capture();
		expect(await executeStatus(dir, io, { all: true })).toBe(0);
		expect(lines).toEqual([
			"x failed    beta  b1  (attempt 1/3, sonnet)  500 ctx  $0.25",
			"+ passed    alpha-app  a1  (attempt 1/3, fable)  5.0K ctx  $1.50",
			"+ passed    beta  b0  (attempt 1/3, fable)",
			"3 runs, 2 passed, 1 failed, $1.75",
		]);

		// The weekly cross-repo review: --all composes with --since, and --json tags each record with its repo.
		const weekly = capture();
		await executeStatus(dir, weekly.io, { all: true, since: "7d", now: new Date("2026-03-05T00:00:00Z") });
		expect(weekly.lines.at(-1)).toBe("2 runs, 1 passed, 1 failed, $1.75");
		const json = capture();
		await executeStatus(dir, json.io, { all: true, json: true });
		expect(JSON.parse(json.lines[0]).map((r: { repo: string; outcomeId: string }) => [r.repo, r.outcomeId])).toEqual([
			["beta", "b1"],
			["alpha-app", "a1"],
			["beta", "b0"],
		]);
	});
});
