import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeWorkspace } from "../src/node/worktree-workspace.ts";

// Integration tests for the node-bound git adapter. These drive REAL git in a
// temp repo (git is deterministic, not flaky) — the engine/orchestration tests
// stay on fakes; the adapter is tested against the thing it adapts.

let tmpRoot: string;
let repoRoot: string;

function git(args: string[]): void {
	execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
}

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "anvil-wt-"));
	repoRoot = join(tmpRoot, "repo");
	await mkdir(repoRoot);
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@t.test"]);
	git(["config", "user.name", "tester"]);
	await writeFile(join(repoRoot, "hello.txt"), "world\n");
	git(["add", "hello.txt"]);
	git(["commit", "-m", "init"]);
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

describe("WorktreeWorkspace (real git)", () => {
	it("provisions an isolated worktree on a new branch and cleans it up", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "anvil/run-1" });
		expect(existsSync(ws.cwd)).toBe(true);
		expect(ws.cwd).not.toBe(repoRoot);

		const branch = await ws.exec("git rev-parse --abbrev-ref HEAD");
		expect(branch.stdout.trim()).toBe("anvil/run-1");

		await ws.cleanup();
		expect(existsSync(ws.cwd)).toBe(false);
	});

	it("distinguishes a real failure from a command that could not run", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b2" });
		try {
			const ok = await ws.exec("echo hi");
			expect(ok.exitCode).toBe(0);
			expect(ok.stdout.trim()).toBe("hi");
			expect(ok.error).toBeUndefined();

			const failed = await ws.exec("exit 3");
			expect(failed.exitCode).toBe(3);
			expect(failed.error).toBeUndefined(); // ran and failed -> a REAL failure

			const timedOut = await ws.exec("sleep 5", { timeoutMs: 100 });
			expect(timedOut.error).toBe("timeout"); // could not run to completion
		} finally {
			await ws.cleanup();
		}
	});

	it("reads files from the worktree", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b3" });
		try {
			expect(await ws.readText("hello.txt")).toBe("world\n");
			expect(await ws.readText("nope.txt")).toBe(null);
			expect(await ws.exists("hello.txt")).toBe(true);
			expect(await ws.exists("nope.txt")).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	it("commits changes and reports nothing-to-commit on a clean worktree", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b4" });
		try {
			expect(await ws.commit("no-op")).toBe(false);

			await writeFile(join(ws.cwd, "new.txt"), "added\n");
			expect(await ws.commit("anvil: add new.txt")).toBe(true);

			const log = await ws.exec("git log --oneline -1");
			expect(log.stdout).toContain("anvil: add new.txt");
		} finally {
			await ws.cleanup();
		}
	});
});
