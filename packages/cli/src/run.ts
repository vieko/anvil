import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Agent, AgentActivity, Gate, ModelEffort, Outcome, StatePersister, Workspace } from "@anvil/core";
import { runToGate } from "@anvil/core";
import type { RunOptions } from "./cli.ts";
import { type Palette, type Palettes, plainPalette, plainPalettes } from "./color.ts";

/** The four engine seams the `run` command drives. */
export interface RunDeps {
	agent: Agent;
	workspace: Workspace;
	gate: Gate;
	persist: StatePersister;
}

/** Output sink. Injected so the surface is testable without touching the console. */
export interface Io {
	out(line: string): void;
	err(line: string): void;
}

export const consoleIo: Io = {
	out: (line) => {
		console.log(line);
	},
	err: (line) => {
		console.error(line);
	},
};

/**
 * Run a resolved outcome to its gate and report the verdict. Returns a process
 * exit code (0 = passed, 1 = failed). The deps are injected, so this is the
 * unit-testable heart of the command — no model, no git, no network required.
 */
export async function executeRun(
	outcome: Outcome,
	options: RunOptions,
	deps: RunDeps,
	io: Io,
	palettes: Palettes = plainPalettes,
): Promise<number> {
	const result = await runToGate(outcome, deps, { maxAttempts: options.maxAttempts });

	// Machine-readable mode: a single JSON object on stdout, regardless of verdict,
	// so an agent/script caller can assess the outcome without scraping prose.
	//
	// Beyond the verdict, the payload carries gate *provenance* (#14) -- how strong
	// the green is -- so an orchestrating caller can route trust as a rule, not a
	// guess: a strong green (explicit verify + a held contract + a held scope) is
	// safe to integrate blind; a weak green (auto-detected, no contract, no scope)
	// warrants human review. `contract`/`scope` are true when the guard was enforced;
	// since any violation voids the run, on a pass they also mean it *held*.
	// (`costUsd` and per-attempt history are still deferred -- see issue #12.)
	if (options.json) {
		io.out(
			JSON.stringify({
				id: outcome.id,
				passed: result.passed,
				attempts: result.attempts,
				finalModel: result.finalConfig.model,
				finalEffort: result.finalConfig.effort,
				branch: deps.workspace.branch,
				gate: {
					commands: result.gateCommands ?? [],
					source: options.verify.length > 0 ? "explicit" : "autodetect",
				},
				contract: options.contract.length > 0,
				scope: options.scope.length > 0,
				...(result.errors ? { errors: result.errors } : {}),
			}),
		);
		return result.passed ? 0 : 1;
	}

	const attempts = `${result.attempts} attempt${result.attempts === 1 ? "" : "s"}`;
	if (result.passed) {
		io.out(palettes.out.green(`+ ${outcome.id}: passed in ${attempts}`));
		return 0;
	}
	io.err(palettes.err.red(`x ${outcome.id}: failed after ${attempts}`));
	if (result.errors && !options.quiet) io.err(result.errors);
	return 1;
}

/**
 * Render a live agent activity event as concise ASCII for `-v` output. Indented
 * to nest under the run header. `>` running, `+` ok, `x` error, `~` reasoning.
 * Reasoning blocks span multiple lines; each line is prefixed so the trace reads
 * as a distinct, dim block rather than as actions. The {@link Palette} adds
 * color on a TTY and is a no-op when piped, so plain output is unchanged.
 */
export function renderActivity(event: AgentActivity, palette: Palette = plainPalette): string {
	switch (event.kind) {
		case "tool-start":
			return event.summary ? `  > ${event.tool}: ${event.summary}` : `  > ${event.tool}`;
		case "tool-end":
			return event.ok ? `  ${palette.green("+")} ${event.tool}` : `  ${palette.red("x")} ${event.tool}`;
		case "reasoning":
			return event.text
				.trim()
				.split("\n")
				.map((line) => palette.dim(`  ~ ${line}`))
				.join("\n");
	}
}

/**
 * Turn the `run` positional into an {@link Outcome}: a readable path becomes a
 * spec (id = file stem, prompt = contents); anything else is an inline prompt
 * (id = slug). Multi-word arguments are never treated as paths.
 */
export async function resolveOutcome(arg: string, options: RunOptions): Promise<Outcome> {
	// Build a base when EITHER --model or --effort is set, so `--effort max` works
	// standalone (not only alongside --model). The model defaults to "sonnet" to
	// match DEFAULT_BASE.model in @anvil/core; an unset effort is normalized to
	// DEFAULT_EFFORT at the runToGate boundary.
	let base: ModelEffort | undefined;
	if (options.model || options.effort !== undefined) {
		base = { model: options.model ?? "sonnet", effort: options.effort };
	}
	const spec = await readSpec(arg);
	return spec ? { id: spec.id, prompt: spec.prompt, base } : { id: slugify(arg), prompt: arg, base };
}

async function readSpec(arg: string): Promise<{ id: string; prompt: string } | null> {
	if (arg.includes(" ") || arg.includes("\n")) return null; // a prompt, not a path
	try {
		const prompt = await readFile(arg, "utf8");
		return { id: basename(arg).replace(/\.[^.]+$/, ""), prompt };
	} catch {
		return null;
	}
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
	return slug || "outcome";
}
