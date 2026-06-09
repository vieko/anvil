import { parseArgs } from "node:util";

/** Options for the `run` command, parsed from argv. `dir` defaults to cwd at the surface. */
export interface RunOptions {
	dir?: string;
	model?: string;
	maxAttempts?: number;
	/** Explicit gate commands; when empty the gate auto-detects. */
	verify: string[];
	quiet: boolean;
}

export type Command =
	| { kind: "run"; outcome: string; options: RunOptions }
	| { kind: "status"; dir?: string }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "error"; message: string };

/**
 * Parse argv (without node/script) into a {@link Command}. Pure: no fs, no cwd,
 * no process state — so the whole surface is unit-testable. Spec-file vs inline
 * prompt resolution happens later (it touches the filesystem).
 */
export function parse(argv: string[]): Command {
	let values: Record<string, unknown>;
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				dir: { type: "string", short: "C" },
				model: { type: "string" },
				"max-attempts": { type: "string", short: "n" },
				verify: { type: "string", multiple: true },
				quiet: { type: "boolean", short: "q" },
				help: { type: "boolean", short: "h" },
				version: { type: "boolean" },
			},
		}) as { values: Record<string, unknown>; positionals: string[] });
	} catch (error) {
		return { kind: "error", message: (error as Error).message };
	}

	if (values.version) return { kind: "version" };

	const command = positionals[0];
	if (!command || values.help) return { kind: "help" };

	const dir = values.dir as string | undefined;

	switch (command) {
		case "run": {
			const outcome = positionals[1];
			if (!outcome) {
				return { kind: "error", message: "run: missing outcome (a prompt, or a path to a spec file)" };
			}
			let maxAttempts: number | undefined;
			const raw = values["max-attempts"] as string | undefined;
			if (raw !== undefined) {
				maxAttempts = Number(raw);
				if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
					return { kind: "error", message: `--max-attempts must be a positive integer (got "${raw}")` };
				}
			}
			return {
				kind: "run",
				outcome,
				options: {
					dir,
					model: values.model as string | undefined,
					maxAttempts,
					verify: (values.verify as string[] | undefined) ?? [],
					quiet: (values.quiet as boolean | undefined) ?? false,
				},
			};
		}
		case "status":
			return { kind: "status", dir };
		default:
			return { kind: "error", message: `unknown command: ${command}` };
	}
}

export const HELP = `anvil — define an outcome, the agent works, a deterministic gate decides done.

Usage:
  anvil run <outcome>     Run an outcome to its gate in an isolated worktree
  anvil status            List recorded runs and their state
  anvil --help            Show this help
  anvil --version         Show the version

<outcome> is a prompt string, or a path to a spec file.

run options:
  -C, --dir <path>        Target repository (default: current directory)
      --model <name>      Base model: alias (sonnet/opus/haiku) or provider:id
  -n, --max-attempts <n>  Attempt cap before giving up (default: 3)
      --verify <cmd>      Gate command (repeatable; overrides auto-detection)
  -q, --quiet             Print only the final verdict`;
