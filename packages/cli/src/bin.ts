#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { AgentActivity } from "@anvil/core";
import { HELP, parse } from "./cli.ts";
import { paletteFor } from "./color.ts";
import { consoleIo, executeRun, renderActivity, resolveOutcome } from "./run.ts";
import { executeSkills } from "./skills.ts";
import { executeStatus } from "./status.ts";
import { buildRunDeps } from "./wiring.ts";

function version(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

async function main(): Promise<number> {
	const cmd = parse(process.argv.slice(2));
	switch (cmd.kind) {
		case "version":
			consoleIo.out(`anvil ${version()}`);
			return 0;
		case "help":
			consoleIo.out(HELP);
			return 0;
		case "error":
			consoleIo.err(`anvil: ${cmd.message}`);
			consoleIo.err("");
			consoleIo.err(HELP);
			return 2;
		case "status":
			return executeStatus(cmd.dir ?? process.cwd(), consoleIo, cmd.json);
		case "skills":
			return executeSkills(cmd.action, cmd.name, cmd.full, consoleIo);
		case "run": {
			const dir = cmd.options.dir ?? process.cwd();
			const outcome = await resolveOutcome(cmd.outcome, cmd.options);
			// `--reasoning` implies `-v` (no thoughts-without-actions state) and is
			// the only thing that unlocks reasoning lines; tool lines stream whenever
			// either is set. The surface filters by kind so core can emit reasoning
			// unconditionally.
			const showReasoning = cmd.options.reasoning;
			const showActivity = cmd.options.verbose || showReasoning;
			// Color is gated per destination stream's TTY status; piped / tee'd /
			// capture-pane'd output (or a redirected stdout alone) stays plain.
			const outPalette = paletteFor(process.stdout, process.env);
			const errPalette = paletteFor(process.stderr, process.env);
			const onActivity = showActivity
				? (event: AgentActivity) => {
						if (event.kind === "reasoning" && !showReasoning) return;
						consoleIo.err(renderActivity(event, errPalette));
					}
				: undefined;
			const { deps, workspace, branch } = await buildRunDeps(outcome.id, dir, cmd.options, onActivity);
			// In --json mode stdout is reserved for the JSON result, so the human run
			// header goes to stderr alongside the -v stream.
			if (!cmd.options.quiet) {
				// In --json mode the header goes to stderr (stdout is reserved for the
				// JSON), so it is painted with that stream's palette.
				const headerPalette = cmd.options.json ? errPalette : outPalette;
				const header = `${headerPalette.bold(`> ${outcome.id}`)}\n  ${workspace.cwd}\n  branch ${branch}`;
				if (cmd.options.json) consoleIo.err(header);
				else consoleIo.out(header);
			}
			return executeRun(outcome, cmd.options, deps, consoleIo, { out: outPalette, err: errPalette });
		}
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		consoleIo.err(`anvil: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
