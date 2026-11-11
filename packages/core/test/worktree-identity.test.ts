import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeWorkspace } from "../src/node/worktree-workspace.ts";

// anvil#65: anvil commits use the configured git identity when there is one,
// so a host that signs commits produces commits GitHub can verify. The
// built-in `anvil` identity is only the fallback for a repo with none.
// Hermetic: the host's global and system git config are switched off, so
// neither a developer identity nor commit.gpgsign leaks into these repos.

let tmpRoot: string;
let repoRoot: string;
const saved: Record<string, string | undefined> = {};
const HERMETIC = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const BOOT = ["-c", "user.name=boot", "-c", "user.email=boot@boot.test"];

function git(args: string[], cwd = repoRoot): string {
	return execFileSync("git", args, { cwd, stdio: "pipe", env: process.env }).toString();
}

function lastIdentity(cwd: string): string {
	return git(["log", "-1", "--format=%an|%ae|%cn|%ce"], cwd).trim();
}

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "anvil-id-"));
	for (const k of HERMETIC) saved[k] = process.env[k];
	const emptyGlobal = join(tmpRoot, "gitconfig");
	await writeFile(emptyGlobal, "");
	process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	repoRoot = join(tmpRoot, "repo");
	await mkdir(repoRoot);
	git(["init", "-b", "main"]);
	await writeFile(join(repoRoot, "hello.txt"), "world\n");
	await writeFile(join(repoRoot, "contract.txt"), "frozen\n");
	git(["add", "hello.txt"]);
	git([...BOOT, "commit", "-m", "init"]);
});

afterEach(async () => {
	for (const k of HERMETIC) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	await rm(tmpRoot, { recursive: true, force: true });
});

describe("WorktreeWorkspace commit identity (anvil#65)", () => {
	it("commits as the repo's configured identity when one is set", async () => {
		git(["config", "user.name", "Dev Person"]);
		git(["config", "user.email", "dev@example.test"]);
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "anvil/id-1" });
		try {
			await writeFile(join(ws.cwd, "new.txt"), "x\n");
			expect(await ws.commit("work")).toBe(true);
			expect(lastIdentity(ws.cwd)).toBe("Dev Person|dev@example.test|Dev Person|dev@example.test");
		} finally {
			await ws.cleanup();
		}
	});

	it("seeds the contract as the configured identity when one is set", async () => {
		git(["config", "user.name", "Dev Person"]);
		git(["config", "user.email", "dev@example.test"]);
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "anvil/id-2", contractFiles: ["contract.txt"] });
		try {
			expect(git(["log", "-1", "--format=%s"], ws.cwd).trim()).toBe("anvil: seed contract");
			expect(lastIdentity(ws.cwd)).toBe("Dev Person|dev@example.test|Dev Person|dev@example.test");
		} finally {
			await ws.cleanup();
		}
	});

	it("falls back to the anvil identity when the repo has none", async () => {
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "anvil/id-3", contractFiles: ["contract.txt"] });
		try {
			expect(lastIdentity(ws.cwd)).toBe("anvil|anvil@localhost|anvil|anvil@localhost");
			await writeFile(join(ws.cwd, "new.txt"), "x\n");
			expect(await ws.commit("work")).toBe(true);
			expect(lastIdentity(ws.cwd)).toBe("anvil|anvil@localhost|anvil|anvil@localhost");
		} finally {
			await ws.cleanup();
		}
	});

	it("falls back to the anvil identity when only an email is set", async () => {
		git(["config", "user.email", "dev@example.test"]);
		const ws = await WorktreeWorkspace.create({ repoRoot, branch: "anvil/id-4" });
		try {
			await writeFile(join(ws.cwd, "new.txt"), "x\n");
			expect(await ws.commit("work")).toBe(true);
			expect(lastIdentity(ws.cwd)).toBe("anvil|anvil@localhost|anvil|anvil@localhost");
		} finally {
			await ws.cleanup();
		}
	});
});
