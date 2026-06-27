import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Gate, GateResult, Workspace } from "@anvil/core";
import { MemoryStatePersister } from "@anvil/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunOptions } from "../src/cli.ts";
import { executeRun, type Io, renderActivity, resolveOutcome } from "../src/run.ts";

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
		branch: "anvil/feat/abc",
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

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
	verify: [],
	share: [],
	install: true,
	oracle: [],
	scope: [],
	quiet: false,
	verbose: false,
	json: false,
	...over,
});

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

	it("--json emits one machine-readable result object (pass)", async () => {
		const out: string[] = [];
		const err: string[] = [];
		const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
		const code = await executeRun(
			{ id: "feat", prompt: "p", base: { model: "sonnet" } },
			opts({ json: true }),
			{ agent: fakeAgent(), workspace: fakeWorkspace(), gate: gate(true), persist: new MemoryStatePersister() },
			io,
		);
		expect(code).toBe(0);
		expect(out).toHaveLength(1); // exactly one JSON line on stdout, no prose
		// A weak green: auto-detected gate, no oracle, no scope -> a caller should flag
		// this for review rather than integrate blind.
		expect(JSON.parse(out[0])).toEqual({
			id: "feat",
			passed: true,
			attempts: 1,
			finalModel: "sonnet",
			branch: "anvil/feat/abc",
			gate: { commands: [], source: "autodetect" },
			oracle: false,
			scope: false,
		});
	});

	it("--json carries gate provenance so a caller can tell a strong green from a weak one", async () => {
		const out: string[] = [];
		const io: Io = { out: (l) => out.push(l), err: () => {} };
		const provenanceGate: Gate = {
			async verify(): Promise<GateResult> {
				return {
					passed: true,
					errors: "",
					commands: [{ cmd: "tsc --noEmit", passed: true, output: "", durationMs: 1 }],
				};
			},
		};
		const code = await executeRun(
			{ id: "feat", prompt: "p", base: { model: "sonnet" } },
			opts({ json: true, verify: ["tsc --noEmit"], oracle: ["oracle.test.ts"], scope: ["src/**"] }),
			{ agent: fakeAgent(), workspace: fakeWorkspace(), gate: provenanceGate, persist: new MemoryStatePersister() },
			io,
		);
		expect(code).toBe(0);
		// A strong green: explicit verify, a held oracle, a held scope -> safe to integrate blind.
		expect(JSON.parse(out[0])).toMatchObject({
			passed: true,
			gate: { commands: ["tsc --noEmit"], source: "explicit" },
			oracle: true,
			scope: true,
		});
	});

	it("--json includes errors and exits 1 on failure", async () => {
		const out: string[] = [];
		const io: Io = { out: (l) => out.push(l), err: () => {} };
		const code = await executeRun(
			{ id: "feat", prompt: "p", base: { model: "sonnet" } },
			opts({ json: true, maxAttempts: 1 }),
			{
				agent: fakeAgent(),
				workspace: fakeWorkspace(),
				gate: gate(false, "tsc: boom"),
				persist: new MemoryStatePersister(),
			},
			io,
		);
		expect(code).toBe(1);
		const payload = JSON.parse(out[0]);
		expect(payload).toMatchObject({ id: "feat", passed: false, errors: "tsc: boom" });
	});
});

describe("renderActivity", () => {
	it("renders tool start/end as concise ASCII lines", () => {
		expect(renderActivity({ kind: "tool-start", tool: "bash", summary: "npm test" })).toBe("  > bash: npm test");
		expect(renderActivity({ kind: "tool-start", tool: "read" })).toBe("  > read");
		expect(renderActivity({ kind: "tool-end", tool: "bash", ok: true })).toBe("  + bash");
		expect(renderActivity({ kind: "tool-end", tool: "edit", ok: false })).toBe("  x edit");
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
