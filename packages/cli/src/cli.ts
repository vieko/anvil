import { parseArgs } from "node:util";
import type { Effort } from "@anvil/core";

/** Options for the `run` command, parsed from argv. `dir` defaults to cwd at the surface. */
export interface RunOptions {
	dir?: string;
	/** Ref to fork the worktree from (default HEAD). Use "main" to fork from main regardless of the checked-out branch. */
	from?: string;
	model?: string;
	/** Base reasoning effort level. undefined → DEFAULT_EFFORT ("high") is applied at the runToGate boundary. */
	effort?: Effort;
	maxAttempts?: number;
	/** Explicit gate commands; when empty the gate auto-detects. */
	verify: string[];
	/** Glob patterns linked into the worktree before the agent runs (symlink, copy fallback; e.g. "**\/.env.local"). */
	link: string[];
	/** Install dependencies in the worktree when a lockfile is present (default true). */
	install: boolean;
	/** Contract file(s) seeded into the worktree and frozen (agent must satisfy, not edit). */
	contract: string[];
	/** Blast-radius globs: the only paths the agent may modify; a change outside voids the run. */
	scope: string[];
	quiet: boolean;
	/** Stream the agent's tool calls + gate progress to stderr as it works. */
	verbose: boolean;
	/**
	 * Also stream the agent's reasoning trace to stderr. Display-only and implies
	 * `--verbose`; `--effort` is the matching reasoning-*level* setter (show vs. set).
	 */
	reasoning: boolean;
	/** Emit a machine-readable JSON result to stdout (human chrome + `-v` go to stderr). */
	json: boolean;
}

export type Command =
	| { kind: "run"; outcome: string; options: RunOptions }
	| { kind: "status"; dir?: string; json: boolean }
	| { kind: "skills"; action: "list" | "get"; name?: string; full: boolean }
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
				from: { type: "string" },
				model: { type: "string" },
				effort: { type: "string" },
				"max-attempts": { type: "string", short: "n" },
				verify: { type: "string", multiple: true },
				link: { type: "string", multiple: true },
				contract: { type: "string", multiple: true },
				scope: { type: "string", multiple: true },
				"no-install": { type: "boolean" },
				full: { type: "boolean" },
				quiet: { type: "boolean", short: "q" },
				verbose: { type: "boolean", short: "v" },
				// `--reasoning` is display-only (the thinking trace).
				// `--effort` is the reasoning-level setter (the `Effort` knob).
				reasoning: { type: "boolean" },
				json: { type: "boolean" },
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
			const VALID_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
			let effort: Effort | undefined;
			const rawEffort = values.effort as string | undefined;
			if (rawEffort !== undefined) {
				if (!VALID_EFFORTS.includes(rawEffort)) {
					return {
						kind: "error",
						message: `--effort must be one of: ${VALID_EFFORTS.join(", ")} (got "${rawEffort}")`,
					};
				}
				effort = rawEffort as Effort;
			}
			return {
				kind: "run",
				outcome,
				options: {
					dir,
					from: values.from as string | undefined,
					model: values.model as string | undefined,
					effort,
					maxAttempts,
					verify: (values.verify as string[] | undefined) ?? [],
					link: (values.link as string[] | undefined) ?? [],
					contract: (values.contract as string[] | undefined) ?? [],
					scope: (values.scope as string[] | undefined) ?? [],
					install: !((values["no-install"] as boolean | undefined) ?? false),
					quiet: (values.quiet as boolean | undefined) ?? false,
					verbose: (values.verbose as boolean | undefined) ?? false,
					reasoning: (values.reasoning as boolean | undefined) ?? false,
					json: (values.json as boolean | undefined) ?? false,
				},
			};
		}
		case "status":
			return { kind: "status", dir, json: (values.json as boolean | undefined) ?? false };
		case "skills": {
			const action = positionals[1] ?? "list";
			if (action !== "list" && action !== "get") {
				return { kind: "error", message: `skills: unknown subcommand "${action}" (use: list, get)` };
			}
			return {
				kind: "skills",
				action,
				name: action === "get" ? positionals[2] : undefined,
				full: (values.full as boolean | undefined) ?? false,
			};
		}
		default:
			return { kind: "error", message: `unknown command: ${command}` };
	}
}

export const HELP = `anvil — define an outcome, the agent works, a deterministic gate decides done.

Usage:
  anvil run <outcome>     Run an outcome to its gate in an isolated worktree
  anvil status            List recorded runs and their state
  anvil skills get core   Print the agent usage guide (served by this binary)
  anvil skills list       List the bundled agent guides
  anvil --help            Show this help
  anvil --version         Show the version

<outcome> is a prompt string, or a path to a spec file.

run options:
  -C, --dir <path>        Target repository (default: current directory)
      --from <ref>        Ref to fork the worktree from (default: HEAD; e.g.
                          "main" to fork from main regardless of the checkout)
      --model <name>      Base model: alias (haiku/sonnet/opus) or provider:id
      --effort <level>    Base reasoning effort: low|medium|high|xhigh|max
                          (default: high when omitted)
  -n, --max-attempts <n>  Attempt cap before giving up (default: 3)
      --verify <cmd>      Gate command (repeatable; overrides auto-detection)
      --link <glob>       Link file(s) into the worktree before the run (symlink,
                          copy fallback; repeatable; e.g. "**/.env.local"). Off by default.
      --no-install        Skip the pre-run dependency install (on by default
                          when a lockfile is present)
      --contract <path>   Seed a file into the worktree and freeze it: the agent
                          must satisfy it, never edit it (repeatable)
      --scope <glob>      Restrict which paths the agent may modify (repeatable;
                          e.g. "src/**"). A change outside voids the run.
  -v, --verbose           Stream the agent's actions + gate progress (to stderr)
      --reasoning         Also stream the agent's reasoning trace (implies -v;
                          display-only — shows thinking the model emits;
                          use --effort to set the thinking level)
  -q, --quiet             Print only the final verdict
      --json              Emit a machine-readable JSON result to stdout (human
                          chrome and -v stream go to stderr). Works for run and
                          status.`;
