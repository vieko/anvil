import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Agent, Gate, Outcome, StatePersister, Workspace } from "@anvil/core";
import { runToGate } from "@anvil/core";
import type { RunOptions } from "./cli.ts";

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
export async function executeRun(outcome: Outcome, options: RunOptions, deps: RunDeps, io: Io): Promise<number> {
	const result = await runToGate(outcome, deps, { maxAttempts: options.maxAttempts });
	const attempts = `${result.attempts} attempt${result.attempts === 1 ? "" : "s"}`;
	if (result.passed) {
		io.out(`+ ${outcome.id}: passed in ${attempts}`);
		return 0;
	}
	io.err(`x ${outcome.id}: failed after ${attempts}`);
	if (result.errors && !options.quiet) io.err(result.errors);
	return 1;
}

/**
 * Turn the `run` positional into an {@link Outcome}: a readable path becomes a
 * spec (id = file stem, prompt = contents); anything else is an inline prompt
 * (id = slug). Multi-word arguments are never treated as paths.
 */
export async function resolveOutcome(arg: string, options: RunOptions): Promise<Outcome> {
	const base = options.model ? { model: options.model } : undefined;
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
