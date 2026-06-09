#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { HELP, parse } from "./cli.ts";
import { consoleIo, executeRun, resolveOutcome } from "./run.ts";
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
			return executeStatus(cmd.dir ?? process.cwd(), consoleIo);
		case "run": {
			const dir = cmd.options.dir ?? process.cwd();
			const outcome = await resolveOutcome(cmd.outcome, cmd.options);
			const { deps, workspace, branch } = await buildRunDeps(outcome.id, dir, cmd.options);
			if (!cmd.options.quiet) consoleIo.out(`> ${outcome.id}\n  ${workspace.cwd}\n  branch ${branch}`);
			return executeRun(outcome, cmd.options, deps, consoleIo);
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
