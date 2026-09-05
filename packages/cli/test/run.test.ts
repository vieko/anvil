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
	link: [],
	install: true,
	contract: [],
	scope: [],
	quiet: false,
	verbose: false,
	reasoning: false,
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
		// A weak green: auto-detected gate, no contract, no scope -> a caller should flag
		// this for review rather than integrate blind.
		const payload = JSON.parse(out[0]);
		expect(payload).toEqual({
			id: "feat",
			passed: true,
			attempts: 1,
			timeline: payload.timeline,
			finalModel: "sonnet",
			finalEffort: "high",
			branch: "anvil/feat/abc",
			gate: { commands: [], source: "autodetect" },
			contract: false,
			scope: false,
		});
		// The per-attempt history (#12 Tier 3): one entry for the single attempt this
		// pass took, config/verdict/usage carried alongside the plain `attempts` count.
		expect(payload.timeline).toEqual([
			expect.objectContaining({ attempt: 0, config: { model: "sonnet", effort: "high" }, verdict: "passed" }),
		]);
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
			opts({ json: true, verify: ["tsc --noEmit"], contract: ["contract.test.ts"], scope: ["src/**"] }),
			{ agent: fakeAgent(), workspace: fakeWorkspace(), gate: provenanceGate, persist: new MemoryStatePersister() },
			io,
		);
		expect(code).toBe(0);
		// A strong green: explicit verify, a held contract, a held scope -> safe to integrate blind.
		expect(JSON.parse(out[0])).toMatchObject({
			passed: true,
			gate: { commands: ["tsc --noEmit"], source: "explicit" },
			contract: true,
			scope: true,
		});
	});

	it("appends the final config and the cumulative cost to the verdict line, omitting $ when unknown", async () => {
		const priced: Agent = {
			async dispatch() {
				return { text: "ok", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 2.106 } };
			},
		};
		const passed = capture();
		await executeRun(
			{ id: "feat", prompt: "p", base: { model: "fable", effort: "high" } },
			opts(),
			{ agent: priced, workspace: fakeWorkspace(), gate: gate(true), persist: new MemoryStatePersister() },
			passed.io,
		);
		expect(passed.lines).toContain("+ feat: passed in 1 attempt (fable@high) $2.11");

		// Two attempts, each $2.106: the line carries the run's cumulative spend (and the
		// escalated final config), in -q too.
		const failed = capture();
		await executeRun(
			{ id: "feat", prompt: "p", base: { model: "fable", effort: "high" } },
			opts({ maxAttempts: 2, quiet: true }),
			{ agent: priced, workspace: fakeWorkspace(), gate: gate(false, "boom"), persist: new MemoryStatePersister() },
			failed.io,
		);
		expect(failed.lines).toEqual(["x feat: failed after 2 attempts (fable@xhigh) $4.21"]);

		// No priced usage at all: no `$` suffix rather than a misleading $0.00.
		const unknown = capture();
		await executeRun(
			{ id: "feat", prompt: "p", base: { model: "sonnet" } },
			opts(),
			{ agent: fakeAgent(), workspace: fakeWorkspace(), gate: gate(true), persist: new MemoryStatePersister() },
			unknown.io,
		);
		expect(unknown.lines).toContain("+ feat: passed in 1 attempt (sonnet@high)");
	});

	it("--json carries per-attempt cost in timeline[].usage and the cumulative usage at the top level", async () => {
		let n = 0;
		const priced: Agent = {
			async dispatch() {
				n++;
				return { text: "ok", usage: { input: 10 * n, output: 5, cacheRead: 100, cacheWrite: 20, cost: 0.25 * n } };
			},
		};
		let verifyCalls = 0;
		const flaky: Gate = {
			async verify(): Promise<GateResult> {
				verifyCalls++;
				return verifyCalls === 1
					? { passed: false, errors: "nope", commands: [] }
					: { passed: true, errors: "", commands: [] };
			},
		};
		const out: string[] = [];
		const io: Io = { out: (l) => out.push(l), err: () => {} };
		const code = await executeRun(
			{ id: "feat", prompt: "p" },
			opts({ json: true }),
			{ agent: priced, workspace: fakeWorkspace(), gate: flaky, persist: new MemoryStatePersister() },
			io,
		);
		expect(code).toBe(0);
		const payload = JSON.parse(out[0]);
		expect(payload.timeline.map((a: { usage: { cost: number } }) => a.usage.cost)).toEqual([0.25, 0.5]);
		expect(payload.usage).toEqual({ input: 30, output: 10, cacheRead: 200, cacheWrite: 40, cost: 0.75 });
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
		expect(renderActivity({ kind: "reasoning", text: "first line\nsecond line" })).toBe(
			"  ~ first line\n  ~ second line",
		);
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

	it("threads --effort onto the base, defaulting the model to sonnet when --effort is given alone", async () => {
		const standalone = await resolveOutcome("do the thing now", opts({ effort: "max" }));
		expect(standalone.base).toEqual({ model: "sonnet", effort: "max" });
		const withModel = await resolveOutcome("do the thing now", opts({ model: "opus", effort: "low" }));
		expect(withModel.base).toEqual({ model: "opus", effort: "low" });
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
