import type { CommandResult, ExecResult, Gate, GateResult, Workspace } from "../index.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface GateCommand {
	cmd: string;
	label?: string;
	/** Per-command timeout (ms). Falls back to the gate default. */
	timeoutMs?: number;
}

export interface CommandGateOptions {
	/** Explicit commands. When omitted, {@link detect} runs (default: Node/TS detection). */
	commands?: GateCommand[];
	/** Detect commands from the workspace when none are given. */
	detect?: (ws: Workspace) => Promise<GateCommand[]>;
	/** Times to run a failing/erroring command to rule out a flake. Clamped to >= 1. Default 2. */
	flakeRuns?: number;
	/** Env overrides for every gate command (clean environment). Default `{ CI: "1" }`. */
	env?: Record<string, string>;
	/** Default per-command timeout (ms). Default 120000. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FLAKE_RUNS = 2;
const MAX_OUTPUT = 10 * 1024;
const DEFAULT_ENV: Record<string, string> = { CI: "1" };

type Verdict = "pass" | "fail" | "inconclusive";

/**
 * The gate: the sole authority on "done". Runs detected (or supplied) build/test
 * commands in a clean environment and reports a structured, actionable verdict.
 *
 * Flake-resistance (the A3 mandate — a flaky gate is a first-class failure mode):
 *  - a command that fails then passes on re-run is FLAKY -> inconclusive, never a
 *    hard failure (avoids false-fail; the engine re-verifies rather than sending
 *    the agent to "fix" a flake).
 *  - a command that cannot run (timeout/spawn) is inconclusive, never a failure.
 *  - a real failure (ran, non-zero, repeatable) dominates: if any command truly
 *    fails, the gate fails even if others were inconclusive.
 *
 * Known limitation: false-pass (a lucky flaky test passing once) is not guarded
 * by default — that needs repeated runs of PASSING commands, which is expensive.
 * Opt-in paranoid confirmation is a later refinement.
 */
export class CommandGate implements Gate {
	private readonly options: CommandGateOptions;

	constructor(options: CommandGateOptions = {}) {
		this.options = options;
	}

	async verify(ws: Workspace, signal?: AbortSignal): Promise<GateResult> {
		const detect = this.options.detect ?? detectNodeTs;
		const commands = this.options.commands ?? (await detect(ws));

		if (commands.length === 0) {
			// A gate that checks nothing cannot vouch for correctness. Anvil refuses to
			// call this a pass (that would violate the core thesis); it signals
			// inconclusive so the caller configures real verification.
			return {
				passed: false,
				errors: "anvil: no verification commands detected — cannot vouch for correctness",
				commands: [],
				inconclusive: true,
			};
		}

		const results: CommandResult[] = [];
		const errorBlocks: string[] = [];
		let anyFail = false;
		let anyInconclusive = false;

		for (const gc of commands) {
			if (signal?.aborted) {
				anyInconclusive = true;
				break;
			}
			const { verdict, result } = await this.runCommand(ws, gc, signal);
			results.push(result);
			if (verdict === "fail") {
				anyFail = true;
				errorBlocks.push(`Command failed: ${gc.cmd}\n${result.output}`);
			} else if (verdict === "inconclusive") {
				anyInconclusive = true;
			}
		}

		const passed = !anyFail && !anyInconclusive;
		return {
			passed,
			errors: errorBlocks.join("\n\n"),
			commands: results,
			// Inconclusive only when there is no real failure to act on.
			inconclusive: !passed && !anyFail && anyInconclusive,
		};
	}

	private async runCommand(
		ws: Workspace,
		gc: GateCommand,
		signal?: AbortSignal,
	): Promise<{ verdict: Verdict; result: CommandResult }> {
		const flakeRuns = Math.max(1, this.options.flakeRuns ?? DEFAULT_FLAKE_RUNS);
		const env = { ...DEFAULT_ENV, ...this.options.env };
		const timeoutMs = gc.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		const runs: { verdict: Verdict; exec: ExecResult }[] = [];
		let totalMs = 0;

		for (let i = 0; i < flakeRuns; i++) {
			if (signal?.aborted) break;
			const started = Date.now();
			const exec = await ws.exec(gc.cmd, { timeoutMs, env, signal });
			totalMs += Date.now() - started;
			const verdict: Verdict = exec.error ? "inconclusive" : exec.exitCode === 0 ? "pass" : "fail";
			runs.push({ verdict, exec });

			// A clean first pass is trusted (single run). Otherwise stop as soon as the
			// outcome is decided, to avoid needless re-runs.
			if (i === 0 && verdict === "pass") break;
			const hasPass = runs.some((r) => r.verdict === "pass");
			const hasFail = runs.some((r) => r.verdict === "fail");
			if (hasPass && hasFail) break; // definitively flaky
			if (runs.filter((r) => r.verdict === "fail").length >= 2) break; // repeatably failing
		}

		const hasPass = runs.some((r) => r.verdict === "pass");
		const hasFail = runs.some((r) => r.verdict === "fail");
		let verdict: Verdict;
		if (hasPass && hasFail) verdict = "inconclusive";
		else if (hasPass) verdict = "pass";
		else if (hasFail) verdict = "fail";
		else verdict = "inconclusive";

		const representative = pickRepresentative(runs, verdict);
		const output = representative ? truncate(combinedOutput(representative.exec)) : "";
		return {
			verdict,
			result: { cmd: gc.cmd, passed: verdict === "pass", output, durationMs: totalMs },
		};
	}
}

function pickRepresentative(runs: { verdict: Verdict; exec: ExecResult }[], verdict: Verdict) {
	if (verdict === "pass") return runs.find((r) => r.verdict === "pass") ?? runs.at(-1);
	return runs.find((r) => r.verdict === "fail") ?? runs.at(-1);
}

function combinedOutput(exec: ExecResult): string {
	if (exec.error) return `[${exec.error}] ${exec.stderr || exec.stdout}`.trim();
	return (exec.stderr || "") + (exec.stdout || "");
}

function truncate(output: string): string {
	if (output.length <= MAX_OUTPUT) return output;
	return `${output.slice(0, MAX_OUTPUT)}\n... (truncated)`;
}

// ── Node/TS command detection ────────────────────────────────
// Ported from forge's verify.ts, minus monorepo scoping (anvil keeps that out
// of the core gate — it is an opt-in refinement layered on top, never baked in).

export async function detectPackageManager(ws: Workspace): Promise<PackageManager> {
	if ((await ws.exists("bun.lock")) || (await ws.exists("bun.lockb"))) return "bun";
	if (await ws.exists("pnpm-lock.yaml")) return "pnpm";
	if (await ws.exists("yarn.lock")) return "yarn";
	return "npm";
}

export async function detectNodeTs(ws: Workspace): Promise<GateCommand[]> {
	const raw = await ws.readText("package.json");
	if (raw === null) return [];
	let pkg: {
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	try {
		pkg = JSON.parse(raw);
	} catch {
		return [];
	}

	const scripts = pkg.scripts ?? {};
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const pm = await detectPackageManager(ws);
	const cmds: GateCommand[] = [];

	if (deps.typescript) cmds.push({ cmd: tscCommand(pm), label: "typecheck" });
	if (scripts.build) cmds.push({ cmd: `${pm} run build`, label: "build" });
	const testScript = pickTestScript(scripts);
	if (testScript) {
		cmds.push({ cmd: testScript === "test" ? `${pm} test` : `${pm} run ${testScript}`, label: "test" });
	}
	return cmds;
}

function tscCommand(pm: PackageManager): string {
	switch (pm) {
		case "bun":
			return "bun run tsc --noEmit";
		case "pnpm":
			return "pnpm exec tsc --noEmit";
		case "yarn":
			return "yarn tsc --noEmit";
		default:
			return "npx tsc --noEmit";
	}
}

// Test-script precedence (issue #4): a CI-deterministic variant beats plain
// `test`. In real monorepos a package's `test` chains the full pyramid
// (e.g. `vitest run && vitest run --config integration && playwright test`);
// auto-gating on it drags a browser + running app + real secrets into anvil's
// fresh, secret-light worktree, so the gate fails or flakes on environment
// noise instead of the change -- and the escalation ladder burns attempts on it.
// Prefer the narrow deterministic tier (what CI actually gates on) and fall
// back to plain `test` only when no such variant exists. Order: `test:unit`
// (purest, fewest infra needs) before `test:ci` (may chain integration) before
// plain `test`. `--verify` remains the explicit escape hatch.
function pickTestScript(scripts: Record<string, string>): string | null {
	if (scripts["test:unit"]) return "test:unit";
	if (scripts["test:ci"]) return "test:ci";
	if (scripts.test && !scripts.test.includes("no test specified")) return "test";
	return null;
}
