import { join, resolve } from "node:path";
import type { AgentEventSink } from "@anvil/core";
import { CommandGate, FileStatePersister, PiAgent, WorktreeWorkspace } from "@anvil/core/node";
import type { RunOptions } from "./cli.ts";
import type { RunDeps } from "./run.ts";

/**
 * Build the real, node-bound engine seams for a `run`:
 *  - an isolated git worktree on a fresh `anvil/<id>/<ts>` branch (the agent
 *    edits it; the gate verifies it; a pass commits there),
 *  - a pi-backed agent over that worktree's execution env,
 *  - the command gate (explicit `--verify` commands, else auto-detection),
 *  - a durable per-repo state store under `.anvil/runs` (enables status/resume).
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
	const branch = `anvil/${outcomeId}/${Date.now().toString(36)}`;
	const workspace = await WorktreeWorkspace.create({
		repoRoot,
		branch,
		baseRef: options.base,
		sharedFiles: options.share.length > 0 ? options.share : undefined,
		oracleFiles: options.oracle.length > 0 ? options.oracle : undefined,
		scopeGlobs: options.scope.length > 0 ? options.scope : undefined,
		install: options.install,
	});

	// The base model (`--model`) rides on the outcome, resolved per-dispatch by
	// PiAgent's default resolver; the agent itself needs no model wiring here.
	// Transcripts persist as JSONL under the main repo's `.anvil/sessions` (beside
	// run records, so they survive worktree cleanup); `-v` streams via onActivity.
	const agent = new PiAgent({
		env: workspace.env,
		sessionsRoot: join(repoRoot, ".anvil", "sessions"),
		sessionCwd: workspace.cwd,
		onActivity,
	});
	const commands = options.verify.length > 0 ? options.verify.map((cmd) => ({ cmd })) : undefined;
	const gate = new CommandGate({ commands });
	const persist = new FileStatePersister({ dir: join(repoRoot, ".anvil", "runs") });

	return { deps: { agent, workspace, gate, persist }, workspace, branch };
}
