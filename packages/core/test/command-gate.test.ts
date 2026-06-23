import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Workspace } from "../src/index.ts";
import { CommandGate, detectNodeTs, detectPackageManager } from "../src/node/command-gate.ts";

type ExecReply = Partial<ExecResult>;

interface FakeOptions {
	/** Per-command result queue. >1 entry => one per call (sticky on the last). */
	exec?: Record<string, ExecReply[]>;
	files?: Record<string, string>;
	/** Paths that should report as existing (in addition to `files` keys). */
	present?: string[];
}

function fakeWorkspace(opts: FakeOptions = {}): Workspace & { calls: string[] } {
	const queues: Record<string, ExecReply[]> = {};
	for (const [k, v] of Object.entries(opts.exec ?? {})) queues[k] = [...v];
	const calls: string[] = [];
	return {
		cwd: "/tmp/fake",
		calls,
		async exec(command: string, _opts?: ExecOptions): Promise<ExecResult> {
			calls.push(command);
			const q = queues[command];
			const reply = q && q.length > 0 ? (q.length > 1 ? (q.shift() as ExecReply) : q[0]) : { exitCode: 0 };
			return { stdout: "", stderr: "", exitCode: 0, ...reply };
		},
		async readText(path: string) {
			return opts.files?.[path] ?? null;
		},
		async exists(path: string) {
			return (opts.present ?? []).includes(path) || opts.files?.[path] !== undefined;
		},
		async commit() {
			return true;
		},
		async cleanup() {},
	};
}

describe("detectPackageManager", () => {
	it("prefers bun, then pnpm, then yarn, then npm", async () => {
		expect(await detectPackageManager(fakeWorkspace({ present: ["bun.lock"] }))).toBe("bun");
		expect(await detectPackageManager(fakeWorkspace({ present: ["pnpm-lock.yaml"] }))).toBe("pnpm");
		expect(await detectPackageManager(fakeWorkspace({ present: ["yarn.lock"] }))).toBe("yarn");
		expect(await detectPackageManager(fakeWorkspace())).toBe("npm");
	});
});

describe("detectNodeTs", () => {
	it("builds typecheck/build/test from package.json + lockfile", async () => {
		const ws = fakeWorkspace({
			files: {
				"package.json": JSON.stringify({ scripts: { build: "x", test: "y" }, devDependencies: { typescript: "5" } }),
			},
			present: ["pnpm-lock.yaml"],
		});
		expect(await detectNodeTs(ws)).toEqual([
			{ cmd: "pnpm exec tsc --noEmit", label: "typecheck" },
			{ cmd: "pnpm run build", label: "build" },
			{ cmd: "pnpm test", label: "test" },
		]);
	});

	it("omits typecheck when typescript is not a dependency, and falls back test:unit", async () => {
		const ws = fakeWorkspace({
			files: { "package.json": JSON.stringify({ scripts: { "test:unit": "v" } }) },
		});
		expect(await detectNodeTs(ws)).toEqual([{ cmd: "npm run test:unit", label: "test" }]);
	});

	it("prefers a deterministic test:unit over a plain test that chains e2e (issue #4)", async () => {
		const ws = fakeWorkspace({
			files: {
				"package.json": JSON.stringify({
					scripts: {
						"test:unit": "vitest run",
						test: "vitest run && vitest run --config integration && playwright test",
					},
				}),
			},
		});
		expect(await detectNodeTs(ws)).toEqual([{ cmd: "npm run test:unit", label: "test" }]);
	});

	it("prefers test:ci over plain test when no test:unit exists", async () => {
		const ws = fakeWorkspace({
			files: {
				"package.json": JSON.stringify({ scripts: { "test:ci": "vitest run", test: "vitest && playwright test" } }),
			},
		});
		expect(await detectNodeTs(ws)).toEqual([{ cmd: "npm run test:ci", label: "test" }]);
	});

	it("prefers test:unit over test:ci when both exist", async () => {
		const ws = fakeWorkspace({
			files: { "package.json": JSON.stringify({ scripts: { "test:unit": "a", "test:ci": "b" } }) },
		});
		expect(await detectNodeTs(ws)).toEqual([{ cmd: "npm run test:unit", label: "test" }]);
	});

	it("falls back to plain test only when no deterministic variant exists", async () => {
		const ws = fakeWorkspace({
			files: { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) },
		});
		expect(await detectNodeTs(ws)).toEqual([{ cmd: "npm test", label: "test" }]);
	});

	it("returns nothing when there is no package.json", async () => {
		expect(await detectNodeTs(fakeWorkspace())).toEqual([]);
	});
});

describe("CommandGate verdicts", () => {
	it("passes when every command is green (single run each)", async () => {
		const ws = fakeWorkspace();
		const gate = new CommandGate({ commands: [{ cmd: "a" }, { cmd: "b" }] });
		const res = await gate.verify(ws);
		expect(res.passed).toBe(true);
		expect(res.errors).toBe("");
		expect(res.commands).toHaveLength(2);
		expect(ws.calls).toEqual(["a", "b"]); // no needless re-runs on a clean pass
	});

	it("fails with actionable errors on a repeatable failure", async () => {
		const ws = fakeWorkspace({ exec: { a: [{ exitCode: 1, stderr: "boom" }] } });
		const gate = new CommandGate({ commands: [{ cmd: "a" }] });
		const res = await gate.verify(ws);
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBeFalsy();
		expect(res.errors).toContain("Command failed: a");
		expect(res.errors).toContain("boom");
	});

	it("treats a fail-then-pass command as flaky -> inconclusive, not a hard failure", async () => {
		const ws = fakeWorkspace({ exec: { a: [{ exitCode: 1, stderr: "flaked" }, { exitCode: 0 }] } });
		const gate = new CommandGate({ commands: [{ cmd: "a" }] });
		const res = await gate.verify(ws);
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBe(true);
		expect(ws.calls.filter((c) => c === "a")).toHaveLength(2); // it rechecked
	});

	it("treats a command that cannot run (timeout) as inconclusive", async () => {
		const ws = fakeWorkspace({ exec: { a: [{ exitCode: -1, error: "timeout" }] } });
		const gate = new CommandGate({ commands: [{ cmd: "a" }] });
		const res = await gate.verify(ws);
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBe(true);
	});

	it("lets a real failure dominate an inconclusive sibling", async () => {
		const ws = fakeWorkspace({ exec: { a: [{ exitCode: 1 }], b: [{ exitCode: -1, error: "timeout" }] } });
		const gate = new CommandGate({ commands: [{ cmd: "a" }, { cmd: "b" }] });
		const res = await gate.verify(ws);
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBeFalsy(); // there is a real failure to fix
		expect(res.errors).toContain("Command failed: a");
	});

	it("flakeRuns:1 disables re-checks (a single failure is reported as failure)", async () => {
		const ws = fakeWorkspace({ exec: { a: [{ exitCode: 1 }, { exitCode: 0 }] } });
		const gate = new CommandGate({ commands: [{ cmd: "a" }], flakeRuns: 1 });
		const res = await gate.verify(ws);
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBeFalsy();
		expect(ws.calls.filter((c) => c === "a")).toHaveLength(1);
	});

	it("refuses to vouch when no commands are detected (inconclusive, not a silent pass)", async () => {
		const gate = new CommandGate({ commands: [] });
		const res = await gate.verify(fakeWorkspace());
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBe(true);
		expect(res.errors).toContain("no verification commands");
	});
});
