import { resolve } from "node:path";
import type { AgentEventSink } from "@anvil/core";
import { CommandGate, FileStatePersister, PiAgent, WorktreeWorkspace } from "@anvil/core/node";
import type { RunOptions } from "./cli.ts";
import type { RunDeps } from "./run.ts";
import { repoStateDirs } from "./state-paths.ts";

/**
 * Build the real, node-bound engine seams for a `run`:
 *  - an isolated git worktree on a fresh `anvil/<id>/<ts>` branch (the agent
 *    edits it; the gate verifies it; a pass commits there),
 *  - a pi-backed agent over that worktree's execution env,
 *  - the command gate (explicit `--verify` commands, else auto-detection),
 *  - a durable per-repo state store under the user-level state dir (enables
 *    status/resume), bucketed by repo path so it never pollutes the target tree.
 *
 * The worktree is left in place so the resulting branch can be inspected/merged.
 */
export async function buildRunDeps(
	outcomeId: string,
	dir: string,
	options: RunOptions,
	onActivity?: AgentEventSink,
): Promise<{ deps: RunDeps; workspace: WorktreeWorkspace; branch: string }> {
	const repoRoot = resolve(dir);
	const { runsDir, sessionsDir } = repoStateDirs(repoRoot);
	const branch = `anvil/${outcomeId}/${Date.now().toString(36)}`;
	const workspace = await WorktreeWorkspace.create({
		repoRoot,
		branch,
		baseRef: options.from,
		linkedFiles: options.link.length > 0 ? options.link : undefined,
		contractFiles: options.contract.length > 0 ? options.contract : undefined,
		scopeGlobs: options.scope.length > 0 ? options.scope : undefined,
		install: options.install,
	});

	// The base model (`--model`) rides on the outcome, resolved per-dispatch by
	// PiAgent's default resolver; the agent itself needs no model wiring here.
	// Transcripts persist as JSONL under the user-level state dir (beside run
	// records, bucketed by repo, so they survive worktree cleanup and never dirty
	// the target tree); `-v` streams via onActivity.
	const agent = new PiAgent({
		env: workspace.env,
		sessionsRoot: sessionsDir,
		sessionCwd: workspace.cwd,
		onActivity,
	});
	const commands = options.verify.length > 0 ? options.verify.map((cmd) => ({ cmd })) : undefined;
	const gate = new CommandGate({ commands });
	const persist = new FileStatePersister({ dir: runsDir });

	return { deps: { agent, workspace, gate, persist }, workspace, branch };
}
