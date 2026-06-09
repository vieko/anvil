import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Gate, GateResult, Workspace } from "@anvil/core";
import { MemoryStatePersister } from "@anvil/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunOptions } from "../src/cli.ts";
import { executeRun, type Io, resolveOutcome } from "../src/run.ts";

function fakeAgent(): Agent {
	return {
		async dispatch() {
			return { text: "ok", sessionId: "s" };
		},
	};
}

function fakeWorkspace(): Workspace {
	return {
		cwd: "/tmp/ws",
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

const gate = (passed: boolean, errors = ""): Gate => ({
	async verify(): Promise<GateResult> {
		return { passed, errors, commands: [] };
	},
});

function capture(): { io: Io; lines: string[] } {
	const lines: string[] = [];
	return { lines, io: { out: (l) => lines.push(l), err: (l) => lines.push(l) } };
}

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({ verify: [], quiet: false, ...over });

describe("executeRun", () => {
	it("returns 0 and reports a pass", async () => {
		const { io, lines } = capture();
		const code = await executeRun(
			{ id: "feat", prompt: "p" },
			opts(),
			{ agent: fakeAgent(), workspace: fakeWorkspace(), gate: gate(true), persist: new MemoryStatePersister() },
			io,
		);
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("+ feat: passed in 1 attempt");
	});

	it("returns 1, reports the failure, and echoes the gate errors", async () => {
		const { io, lines } = capture();
		const code = await executeRun(
			{ id: "feat", prompt: "p" },
			opts({ maxAttempts: 1 }),
			{
				agent: fakeAgent(),
				workspace: fakeWorkspace(),
				gate: gate(false, "tsc: boom"),
				persist: new MemoryStatePersister(),
			},
			io,
		);
		expect(code).toBe(1);
		const out = lines.join("\n");
		expect(out).toContain("x feat: failed after 1 attempt");
		expect(out).toContain("tsc: boom");
	});
});

describe("resolveOutcome", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "anvil-cli-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("treats a multi-word argument as an inline prompt and slugs the id", async () => {
		const o = await resolveOutcome("Refactor the parser!", opts({ model: "opus" }));
		expect(o.prompt).toBe("Refactor the parser!");
		expect(o.id).toBe("refactor-the-parser");
		expect(o.base).toEqual({ model: "opus" });
	});

	it("reads a readable path as a spec (id = file stem, prompt = contents)", async () => {
		const file = join(dir, "auth-login.md");
		await writeFile(file, "Build a login flow.\n");
		const o = await resolveOutcome(file, opts());
		expect(o.id).toBe("auth-login");
		expect(o.prompt).toContain("Build a login flow.");
	});

	it("falls back to inline when a path-like arg does not exist", async () => {
		const o = await resolveOutcome("specs/missing.md", opts());
		expect(o.prompt).toBe("specs/missing.md");
		expect(o.id).toBe("specs-missing-md");
	});
});
