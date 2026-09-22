import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunRecord, RunState, TokenUsage } from "@anvil/core";
import { defaultWorktreePath, FileStatePersister } from "@anvil/core/node";
import { parseSince } from "./cli.ts";
import type { Io } from "./run.ts";
import { decodeRepoBasename, decodeRepoPath, repoStateDirs, stateRoot } from "./state-paths.ts";

const MARK: Record<string, string> = { passed: "+", failed: "x" };
/** Distinct mark for a stale row (#41) -- never a real terminal verdict, never plain "in flight". */
const STALE_MARK = "!";

const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["passed", "failed"]);

/**
 * How long a non-terminal record with no `pid` (written before #41, or by a
 * fake in tests) may go without a heartbeat before `status` calls it dead.
 * Records with a `pid` are checked by actual liveness instead and never rely
 * on this constant.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

export interface StatusOptions {
	/** Emit the record ledger as a JSON array instead of rows. */
	json?: boolean;
	/** Only records whose `updatedAt` is on/after this duration-ago (`7d`, `24h`, `90m`) or ISO date. */
	since?: string;
	/** Read every repo bucket under the state root, prefixing rows with the repo name. */
	all?: boolean;
	/** Reference instant for `since` durations and staleness checks. Default: the current time. */
	now?: Date;
	/**
	 * Rewrite every stale row (#41) to `state: "failed"` with an `orphaned:`
	 * note, print what changed, and print (never run) the `git worktree remove`
	 * command for its worktree if it still exists. Never deletes anything.
	 */
	prune?: boolean;
}

/** A run record plus the repo bucket it was read from (`--all`) and its runs dir (for `--prune`). */
interface StatusRow {
	repo?: string;
	record: RunRecord;
	runsDir: string;
	/** The repo's absolute root, when known -- decoded from the bucket name in `--all` mode. Used by `--prune` for the worktree hint. */
	repoRoot?: string;
}

/**
 * List recorded runs (newest first) from this repo's user-level state bucket,
 * or from every bucket with `--all`, with each run's tokens and USD cost and a
 * spend footer.
 */
export async function executeStatus(dir: string, io: Io, options: StatusOptions = {}): Promise<number> {
	const now = options.now ?? new Date();
	const since = options.since === undefined ? undefined : parseSince(options.since, now);
	if (options.since !== undefined && since === null) {
		io.err(`anvil: --since must be a duration (7d, 24h, 90m) or an ISO date (got "${options.since}")`);
		return 2;
	}
	const resolvedDir = resolve(dir);
	let rows = options.all ? await allRepoRows() : await repoRows(repoStateDirs(resolvedDir).runsDir, resolvedDir);
	if (since) rows = rows.filter((row) => Date.parse(row.record.updatedAt) >= since.getTime());
	rows.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt));

	if (options.prune) return prune(rows, now, io);

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
		const stale = isStale(r, now);
		const mark = stale ? STALE_MARK : (MARK[r.state] ?? ">");
		const label = stale ? `stale ${formatAge(r.updatedAt, now)}` : r.state;
		const prefix = repo === undefined ? "" : `${repo}  `;
		const summary = `(attempt ${r.attempt + 1}/${r.maxAttempts}, ${r.config.model})`;
		io.out(`${mark} ${label.padEnd(9)} ${prefix}${r.outcomeId}  ${summary}${usageColumns(r.usage)}`);
	}
	io.out(
		footer(
			rows.map((row) => row.record),
			now,
		),
	);
	return 0;
}

/**
 * `anvil status --prune` (#41): rewrite every stale row to a terminal
 * `failed` with an `orphaned:` note (so a dead run stops looking in-flight
 * forever), report each rewrite, and print -- never run -- the worktree
 * removal command when that worktree still exists. Branches and worktrees are
 * never touched here; that decision stays with whoever reads the printed
 * command.
 */
async function prune(rows: StatusRow[], now: Date, io: Io): Promise<number> {
	const stale = rows.filter((row) => isStale(row.record, now));
	if (stale.length === 0) {
		io.out("no stale runs to prune");
		return 0;
	}
	for (const row of stale) {
		const note = `orphaned: process gone, marked by anvil status --prune ${now.toISOString()}`;
		const updated: RunRecord = { ...row.record, state: "failed", note, updatedAt: now.toISOString() };
		await new FileStatePersister({ dir: row.runsDir }).save(updated);
		const prefix = row.repo === undefined ? "" : `${row.repo}  `;
		io.out(
			`pruned ${prefix}${row.record.outcomeId} (was ${row.record.state}, ${formatAge(row.record.updatedAt, now)} old)`,
		);
		const worktree = worktreeRemoveHint(row);
		if (worktree) io.out(`  ${worktree}`);
	}
	return 0;
}

/** The `git worktree remove` command for a stale row's worktree, when it's still on disk; null otherwise. */
function worktreeRemoveHint(row: StatusRow): string | null {
	if (!row.record.branch || !row.repoRoot) return null;
	const path = defaultWorktreePath(row.repoRoot, row.record.branch);
	if (!existsSync(path)) return null;
	return `git worktree remove ${path}`;
}

async function repoRows(runsDir: string, repoRoot: string, repo?: string): Promise<StatusRow[]> {
	const records = await new FileStatePersister({ dir: runsDir }).list();
	return records.map((record) => ({ repo, record, runsDir, repoRoot }));
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
		const repoRoot = decodeRepoPath(name, isDirectory) ?? undefined;
		rows.push(
			...(await repoRows(join(stateRoot(), name, "runs"), repoRoot ?? name, decodeRepoBasename(name, isDirectory))),
		);
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

/**
 * True when a non-terminal record's process is gone (#41): a dead `pid`
 * (`kill -0` fails), or no `pid` at all and `updatedAt` hasn't moved in
 * {@link STALE_AFTER_MS}. Terminal records (`passed`/`failed`) are never
 * stale -- they already answered the "is this done" question.
 */
function isStale(record: RunRecord, now: Date): boolean {
	if (TERMINAL_STATES.has(record.state)) return false;
	if (record.pid !== undefined) return !isProcessAlive(record.pid);
	return now.getTime() - Date.parse(record.updatedAt) > STALE_AFTER_MS;
}

/** `kill -0`: true if `pid` names a live process (including one we can't signal but that still exists). */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** `16d` / `3h` / `45m`: coarse age since `updatedAt`, one unit, rounded down. */
function formatAge(updatedAt: string, now: Date): string {
	const ms = Math.max(0, now.getTime() - Date.parse(updatedAt));
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** `  2.3M ctx  $4.21`: context tokens (input + cache read + cache write) and USD cost, each omitted when unknown. */
function usageColumns(usage: TokenUsage | undefined): string {
	if (!usage) return "";
	const ctx = usage.input + usage.cacheRead + (usage.cacheWrite ?? 0);
	const cost = usage.cost === undefined ? "" : `  ${formatCost(usage.cost)}`;
	return `  ${formatTokens(ctx)} ctx${cost}`;
}

/**
 * `N runs, P passed, F failed, S stale, $X.XX` -- `stale` (#41) is omitted
 * when zero, so the common case matches the pre-#41 footer exactly. The `$`
 * total sums known costs and is omitted when none is known.
 */
function footer(records: RunRecord[], now: Date): string {
	const passed = records.filter((r) => r.state === "passed").length;
	const failed = records.filter((r) => r.state === "failed").length;
	const stale = records.filter((r) => isStale(r, now)).length;
	const costs = records.map((r) => r.usage?.cost).filter((c): c is number => c !== undefined);
	const total = costs.length === 0 ? "" : `, ${formatCost(costs.reduce((sum, c) => sum + c, 0))}`;
	const staleLabel = stale === 0 ? "" : `, ${stale} stale`;
	return `${records.length} run${records.length === 1 ? "" : "s"}, ${passed} passed, ${failed} failed${staleLabel}${total}`;
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
