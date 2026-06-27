import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommand, matchesGlob, WorktreeWorkspace } from "../src/node/worktree-workspace.ts";

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
		expect(ws.branch).toBe("anvil/run-1"); // surfaced to RunRecord via the Workspace seam

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

	it("links opted-in files into the worktree (--link)", async () => {
		await mkdir(join(repoRoot, "apps", "web"), { recursive: true });
		await writeFile(join(repoRoot, "apps", "web", ".env.local"), "SECRET=shh\n");
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b5", linkedFiles: ["**/.env.local"] });
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

	it("seeds a contract into the base and detects agent tampering (hard freeze)", async () => {
		await writeFile(join(repoRoot, "contract.test.ts"), "expect(true).toBe(true)\n");
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b7", contractFiles: ["contract.test.ts"] });
		try {
			// committed into the base -> present and clean
			expect(await ws.exists("contract.test.ts")).toBe(true);
			expect(await ws.assertContract()).toBeNull();
			const log = await ws.exec("git log --oneline -1");
			expect(log.stdout).toContain("seed contract");

			// the agent tampers with it -> a violation naming the path
			await writeFile(join(ws.cwd, "contract.test.ts"), "expect(true).toBe(false)\n");
			const violation = await ws.assertContract();
			expect(violation?.path).toBe("contract.test.ts");
			expect(violation?.diff).toContain("toBe(false)");
		} finally {
			await ws.cleanup();
		}
	});

	it("forks from an explicit base ref regardless of the main tree's checked-out branch", async () => {
		// Simulate a concurrent session that has the main tree on a feature branch.
		git(["branch", "feature"]);
		git(["checkout", "feature"]);
		await writeFile(join(repoRoot, "feature.txt"), "feature work\n");
		git(["add", "feature.txt"]);
		git(["commit", "-m", "feature commit"]);
		const mainSha = execFileSync("git", ["rev-parse", "main"], { cwd: repoRoot }).toString().trim();

		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b9", baseRef: "main" });
		try {
			const head = await ws.exec("git rev-parse HEAD");
			expect(head.stdout.trim()).toBe(mainSha); // forked from main, not the checked-out feature branch
			expect(await ws.exists("feature.txt")).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	it("bypasses project pre-commit hooks for its own commits (--no-verify)", async () => {
		// A pre-commit hook that always fails -- linked worktrees share the main
		// repo's hooks, so this fires for commits made in the worktree too.
		const hooksDir = join(repoRoot, ".git", "hooks");
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		await writeFile(join(repoRoot, "contract2.test.ts"), "ok\n");
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b10", contractFiles: ["contract2.test.ts"] });
		try {
			// the seed commit succeeded despite the failing hook (else assertContract throws/diffs)
			expect(await ws.assertContract()).toBeNull();
			await writeFile(join(ws.cwd, "work.txt"), "agent work\n");
			expect(await ws.commit("anvil: capture")).toBe(true);
		} finally {
			await ws.cleanup();
		}
	});

	it("assertContract is a no-op when no contract was seeded", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b8" });
		try {
			expect(await ws.assertContract()).toBeNull();
		} finally {
			await ws.cleanup();
		}
	});

	it("voids the run when the agent edits outside --scope, allows in-scope edits", async () => {
		await mkdir(join(repoRoot, "src"), { recursive: true });
		await writeFile(join(repoRoot, "src", "a.ts"), "export const a = 1;\n");
		await writeFile(join(repoRoot, "README.md"), "# repo\n");
		git(["add", "-A"]);
		git(["commit", "-m", "seed src"]);
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b11", scopeGlobs: ["src/**"] });
		try {
			// no changes yet -> in scope (null)
			expect(await ws.assertScope()).toBeNull();

			// modify an in-scope tracked file + add a new in-scope file -> still null
			await writeFile(join(ws.cwd, "src", "a.ts"), "export const a = 2;\n");
			await writeFile(join(ws.cwd, "src", "b.ts"), "export const b = 3;\n");
			expect(await ws.assertScope()).toBeNull();

			// touch a file outside scope -> a violation naming it
			await writeFile(join(ws.cwd, "README.md"), "# repo edited\n");
			const violation = await ws.assertScope();
			expect(violation?.outside).toEqual(["README.md"]);
		} finally {
			await ws.cleanup();
		}
	});

	it("assertScope is a no-op when no scope was set", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "b12" });
		try {
			await writeFile(join(ws.cwd, "anything.txt"), "x\n");
			expect(await ws.assertScope()).toBeNull();
		} finally {
			await ws.cleanup();
		}
	});
});

describe("matchesGlob", () => {
	it("spans path segments with **, stays within a segment with *", () => {
		expect(matchesGlob("src/**", "src/a/b/route.ts")).toBe(true);
		expect(matchesGlob("src/**", "src/route.ts")).toBe(true);
		expect(matchesGlob("src/**", "lib/route.ts")).toBe(false);
		expect(matchesGlob("apps/x/**/route.ts", "apps/x/a/route.ts")).toBe(true);
		expect(matchesGlob("apps/x/**/route.ts", "apps/x/route.ts")).toBe(true);
		expect(matchesGlob("apps/x/**/route.ts", "apps/x/a/page.ts")).toBe(false);
		expect(matchesGlob("src/*.ts", "src/a.ts")).toBe(true);
		expect(matchesGlob("src/*.ts", "src/a/b.ts")).toBe(false);
		expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
		expect(matchesGlob("src/a.ts", "src/a.tsx")).toBe(false);
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
