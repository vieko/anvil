import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommand, WorktreeWorkspace } from "../src/node/worktree-workspace.ts";

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

	it("copies opted-in shared files into the worktree (--share)", async () => {
		await mkdir(join(repoRoot, "apps", "web"), { recursive: true });
		await writeFile(join(repoRoot, "apps", "web", ".env.local"), "SECRET=shh\n");
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b5", sharedFiles: ["**/.env.local"] });
		try {
			expect(await ws.exists("apps/web/.env.local")).toBe(true);
			expect(await ws.readText("apps/web/.env.local")).toBe("SECRET=shh\n");
		} finally {
			await ws.cleanup();
		}
	});

	it("skips the dependency install when there is no lockfile", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b6", install: true });
		try {
			expect(await ws.exists("node_modules")).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	it("seeds an oracle into the base and detects agent tampering (hard freeze)", async () => {
		await writeFile(join(repoRoot, "oracle.test.ts"), "expect(true).toBe(true)\n");
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b7", oracleFiles: ["oracle.test.ts"] });
		try {
			// committed into the base -> present and clean
			expect(await ws.exists("oracle.test.ts")).toBe(true);
			expect(await ws.assertFrozen()).toBeNull();
			const log = await ws.exec("git log --oneline -1");
			expect(log.stdout).toContain("seed verification oracle");

			// the agent tampers with it -> a violation naming the path
			await writeFile(join(ws.cwd, "oracle.test.ts"), "expect(true).toBe(false)\n");
			const violation = await ws.assertFrozen();
			expect(violation?.path).toBe("oracle.test.ts");
			expect(violation?.diff).toContain("toBe(false)");
		} finally {
			await ws.cleanup();
		}
	});

	it("assertFrozen is a no-op when no oracle was seeded", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b8" });
		try {
			expect(await ws.assertFrozen()).toBeNull();
		} finally {
			await ws.cleanup();
		}
	});
});

describe("installCommand", () => {
	it("maps each package manager to its install command", () => {
		expect(installCommand("pnpm")).toBe("pnpm install --prefer-offline");
		expect(installCommand("bun")).toBe("bun install");
		expect(installCommand("yarn")).toBe("yarn install");
		expect(installCommand("npm")).toBe("npm install");
	});
});
