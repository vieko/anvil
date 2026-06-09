import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../src/index.ts";
import { FileStatePersister } from "../src/node/file-state-persister.ts";

let dir: string;

function record(partial: Partial<RunRecord> & Pick<RunRecord, "outcomeId" | "state">): RunRecord {
	return {
		attempt: 0,
		maxAttempts: 3,
		config: { model: "sonnet" },
		updatedAt: new Date().toISOString(),
		...partial,
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "anvil-persist-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("FileStatePersister", () => {
	it("persists and reloads the latest record for an outcome", async () => {
		const p = new FileStatePersister({ dir: join(dir, "runs") });
		await p.save(record({ outcomeId: "auth/login.md", state: "running" }));
		await p.save(record({ outcomeId: "auth/login.md", state: "passed", attempt: 1 }));

		const loaded = await p.load("auth/login.md");
		expect(loaded?.state).toBe("passed");
		expect(loaded?.attempt).toBe(1);
	});

	it("returns null / empty when nothing is stored", async () => {
		const p = new FileStatePersister({ dir: join(dir, "empty") });
		expect(await p.load("nope")).toBeNull();
		expect(await p.list()).toEqual([]);
	});

	it("lists the latest record per outcome, newest first", async () => {
		const p = new FileStatePersister({ dir });
		await p.save(record({ outcomeId: "a", state: "passed", updatedAt: "2026-01-01T00:00:00Z" }));
		await p.save(record({ outcomeId: "b", state: "failed", updatedAt: "2026-01-02T00:00:00Z" }));
		expect((await p.list()).map((r) => r.outcomeId)).toEqual(["b", "a"]);
	});

	it("keeps distinct files for ids that sanitize to the same readable prefix", async () => {
		const p = new FileStatePersister({ dir });
		await p.save(record({ outcomeId: "a/b", state: "running", errors: "from-slash" }));
		await p.save(record({ outcomeId: "a-b", state: "failed", errors: "from-dash" }));

		expect((await p.load("a/b"))?.errors).toBe("from-slash");
		expect((await p.load("a-b"))?.errors).toBe("from-dash");
	});

	it("leaves no temp files behind after a save (atomic rename)", async () => {
		const p = new FileStatePersister({ dir });
		await p.save(record({ outcomeId: "x", state: "running" }));
		const names = await readdir(dir);
		expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
		expect(names.every((n) => n.endsWith(".json"))).toBe(true);
	});
});
