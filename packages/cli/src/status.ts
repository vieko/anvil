import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunRecord, TokenUsage } from "@anvil/core";
import { FileStatePersister } from "@anvil/core/node";
import { parseSince } from "./cli.ts";
import type { Io } from "./run.ts";
import { decodeRepoBasename, repoStateDirs, stateRoot } from "./state-paths.ts";

const MARK: Record<string, string> = { passed: "+", failed: "x" };

export interface StatusOptions {
	/** Emit the record ledger as a JSON array instead of rows. */
	json?: boolean;
	/** Only records whose `updatedAt` is on/after this duration-ago (`7d`, `24h`, `90m`) or ISO date. */
	since?: string;
	/** Read every repo bucket under the state root, prefixing rows with the repo name. */
	all?: boolean;
	/** Reference instant for `since` durations. Default: the current time. */
	now?: Date;
}

/** A run record plus the repo bucket it was read from (`--all`). */
interface StatusRow {
	repo?: string;
	record: RunRecord;
}

/**
 * List recorded runs (newest first) from this repo's user-level state bucket,
 * or from every bucket with `--all`, with each run's tokens and USD cost and a
 * spend footer.
 */
export async function executeStatus(dir: string, io: Io, options: StatusOptions = {}): Promise<number> {
	const since = options.since === undefined ? undefined : parseSince(options.since, options.now ?? new Date());
	if (options.since !== undefined && since === null) {
		io.err(`anvil: --since must be a duration (7d, 24h, 90m) or an ISO date (got "${options.since}")`);
		return 2;
	}
	let rows = options.all ? await allRepoRows() : await repoRows(repoStateDirs(resolve(dir)).runsDir);
	if (since) rows = rows.filter((row) => Date.parse(row.record.updatedAt) >= since.getTime());
	rows.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt));

	if (options.json) {
		// The full record ledger as a JSON array (empty array when nothing recorded).
		io.out(
			JSON.stringify(rows.map((row) => (row.repo === undefined ? row.record : { repo: row.repo, ...row.record }))),
		);
		return 0;
	}
	if (rows.length === 0) {
		io.out("no runs recorded");
		return 0;
	}
	for (const { repo, record: r } of rows) {
		const mark = MARK[r.state] ?? ">";
		const prefix = repo === undefined ? "" : `${repo}  `;
		const summary = `(attempt ${r.attempt + 1}/${r.maxAttempts}, ${r.config.model})`;
		io.out(`${mark} ${r.state.padEnd(9)} ${prefix}${r.outcomeId}  ${summary}${usageColumns(r.usage)}`);
	}
	io.out(footer(rows.map((row) => row.record)));
	return 0;
}

async function repoRows(runsDir: string, repo?: string): Promise<StatusRow[]> {
	const records = await new FileStatePersister({ dir: runsDir }).list();
	return records.map((record) => ({ repo, record }));
}

/** Every `--<encoded-repo>--` bucket under the state root, each labelled with its decoded repo name. */
async function allRepoRows(): Promise<StatusRow[]> {
	let names: string[];
	try {
		names = await readdir(stateRoot());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const rows: StatusRow[] = [];
	for (const name of names) {
		if (!/^--.*--$/.test(name)) continue;
		rows.push(...(await repoRows(join(stateRoot(), name, "runs"), decodeRepoBasename(name, isDirectory))));
	}
	return rows;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** `  2.3M ctx  $4.21`: context tokens (input + cache read + cache write) and USD cost, each omitted when unknown. */
function usageColumns(usage: TokenUsage | undefined): string {
	if (!usage) return "";
	const ctx = usage.input + usage.cacheRead + (usage.cacheWrite ?? 0);
	const cost = usage.cost === undefined ? "" : `  ${formatCost(usage.cost)}`;
	return `  ${formatTokens(ctx)} ctx${cost}`;
}

/** `N runs, P passed, F failed, $X.XX` -- the `$` total sums known costs and is omitted when none is known. */
function footer(records: RunRecord[]): string {
	const passed = records.filter((r) => r.state === "passed").length;
	const failed = records.filter((r) => r.state === "failed").length;
	const costs = records.map((r) => r.usage?.cost).filter((c): c is number => c !== undefined);
	const total = costs.length === 0 ? "" : `, ${formatCost(costs.reduce((sum, c) => sum + c, 0))}`;
	return `${records.length} run${records.length === 1 ? "" : "s"}, ${passed} passed, ${failed} failed${total}`;
}

/** USD with two decimals: `$4.21`. */
export function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

/** Token count in `K`/`M`: `812`, `9.6K`, `812K`, `2.3M`. */
export function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}K`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}K`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
