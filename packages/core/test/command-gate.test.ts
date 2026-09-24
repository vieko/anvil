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

	it("classifies a missing gate executable as a harness crash", async () => {
		const ws = fakeWorkspace({
			exec: { "./scripts/check.sh": [{ exitCode: 127, stderr: "./scripts/check.sh: No such file or directory" }] },
		});
		const res = await new CommandGate({ commands: [{ cmd: "./scripts/check.sh" }] }).verify(ws);
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBe(true);
		expect(res.commands[0].crash).toBe(true);
		expect(res.errors).toContain(
			"anvil: gate command could not run (harness crash), not a failure of the work: ./scripts/check.sh",
		);
		expect(res.errors).toContain("No such file or directory");
	});

	it("classifies a verifier that cannot be resolved by node as a harness crash", async () => {
		const stderr =
			"node:internal/modules/cjs/loader:1568\n  throw err;\n  ^\n\nError: Cannot find module '/tmp/wt/scripts/openwiki/behavior/gate.mjs'";
		const ws = fakeWorkspace({ exec: { "node scripts/openwiki/behavior/gate.mjs": [{ exitCode: 1, stderr }] } });
		const res = await new CommandGate({ commands: [{ cmd: "node scripts/openwiki/behavior/gate.mjs" }] }).verify(ws);
		expect(res.inconclusive).toBe(true);
		expect(res.commands[0].crash).toBe(true);
	});

	it("classifies a traceback inside the verifier script itself as a harness crash", async () => {
		const stderr =
			"Traceback (most recent call last):\n  File \"/tmp/wt/verify.py\", line 37, in <module>\n    data = json.loads(run([...]))\nKeyError: 'results'";
		const ws = fakeWorkspace({ exec: { "python3 /tmp/wt/verify.py": [{ exitCode: 1, stderr }] } });
		const res = await new CommandGate({ commands: [{ cmd: "python3 /tmp/wt/verify.py" }] }).verify(ws);
		expect(res.inconclusive).toBe(true);
		expect(res.commands[0].crash).toBe(true);
	});

	it("classifies ENOENT naming the verifier's own script as a crash, but not ENOENT naming only the program", async () => {
		const own = fakeWorkspace({
			exec: { "bash scripts/gate.sh": [{ exitCode: 1, stderr: "spawn ENOENT: scripts/gate.sh" }] },
		});
		const crashed = await new CommandGate({ commands: [{ cmd: "bash scripts/gate.sh" }] }).verify(own);
		expect(crashed.commands[0].crash).toBe(true);

		const program = fakeWorkspace({
			exec: {
				"node verify.mjs": [{ exitCode: 1, stderr: "Error: ENOENT: no such file, open 'fixtures/a.json' node:fs" }],
			},
		});
		const failed = await new CommandGate({ commands: [{ cmd: "node verify.mjs" }], flakeRuns: 1 }).verify(program);
		expect(failed.inconclusive).toBeFalsy();
		expect(failed.commands[0].crash).toBeUndefined();
	});

	it("does not confuse missing imports in tested code with a broken verifier", async () => {
		const ws = fakeWorkspace({ exec: { "npm test": [{ exitCode: 1, stderr: "Cannot find module './lib/thing'" }] } });
		const res = await new CommandGate({ commands: [{ cmd: "npm test" }], flakeRuns: 1 }).verify(ws);
		expect(res.inconclusive).toBeFalsy();
		expect(res.commands[0].crash).toBeUndefined();
	});

	it("does not classify a traceback in code under test as a harness crash", async () => {
		const stderr = 'Traceback (most recent call last):\n  File "app.py", line 2, in run\nRuntimeError: broken';
		const ws = fakeWorkspace({ exec: { "python verifier.py": [{ exitCode: 1, stderr }] } });
		const res = await new CommandGate({ commands: [{ cmd: "python verifier.py" }], flakeRuns: 1 }).verify(ws);
		expect(res.inconclusive).toBeFalsy();
		expect(res.commands[0].crash).toBeUndefined();
	});

	it("does not classify unrelated ENOENT output or a plain non-zero exit as a crash", async () => {
		for (const stderr of ["test output: ENOENT missing fixture.txt", "assertion failed"]) {
			const ws = fakeWorkspace({ exec: { "node verify.mjs": [{ exitCode: 1, stderr }] } });
			const res = await new CommandGate({ commands: [{ cmd: "node verify.mjs" }], flakeRuns: 1 }).verify(ws);
			expect(res.inconclusive).toBeFalsy();
			expect(res.commands[0].crash).toBeUndefined();
		}
	});

	it("lets a repeatable failure dominate a crashed verifier sibling", async () => {
		const ws = fakeWorkspace({
			exec: {
				"./gate.sh": [{ exitCode: 127, stderr: "./gate.sh: command not found" }],
				"npm test": [{ exitCode: 1, stderr: "assertion failed" }],
			},
		});
		const res = await new CommandGate({ commands: [{ cmd: "./gate.sh" }, { cmd: "npm test" }] }).verify(ws);
		expect(res.inconclusive).toBeFalsy();
		expect(res.errors).toContain("Command failed: npm test");
		expect(res.errors).toContain("harness crash");
	});

	it("supports caller-supplied harness crash patterns", async () => {
		const ws = fakeWorkspace({ exec: { "opaque gate": [{ exitCode: 1, stderr: "runner died" }] } });
		const res = await new CommandGate({
			commands: [{ cmd: "opaque gate" }],
			crashPatterns: [/runner died/],
			flakeRuns: 1,
		}).verify(ws);
		expect(res.inconclusive).toBe(true);
		expect(res.commands[0].crash).toBe(true);
	});

	it("refuses to vouch when no commands are detected (inconclusive, not a silent pass)", async () => {
		const gate = new CommandGate({ commands: [] });
		const res = await gate.verify(fakeWorkspace());
		expect(res.passed).toBe(false);
		expect(res.inconclusive).toBe(true);
		expect(res.errors).toContain("no verification commands");
	});
});
