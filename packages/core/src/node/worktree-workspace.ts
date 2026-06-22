import { cp, glob, mkdir, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecOptions, ExecResult, Workspace } from "../index.ts";
import { detectPackageManager, type PackageManager } from "./command-gate.ts";

export interface WorktreeWorkspaceOptions {
	/** Repository to branch from (its root). */
	repoRoot: string;
	/** Branch to create for this run. */
	branch: string;
	/** Worktree location. Defaults to a sibling `<repo>-anvil/<safe-branch>` directory. */
	worktreePath?: string;
	/** Base ref to branch from. Defaults to "HEAD". */
	baseRef?: string;
	/** Env overrides applied to every command run through this workspace. */
	env?: Record<string, string>;
	/** Default per-command timeout (ms). Defaults to no timeout. */
	timeoutMs?: number;
	/** Custom shell path for the underlying pi ExecutionEnv. */
	shellPath?: string;
	/**
	 * Glob patterns (relative to the repo root) to copy into the worktree before
	 * the agent runs -- e.g. ["**\/.env.local"]. Symlink, with copy fallback.
	 * Brought in but never committed (a fresh worktree lacks gitignored files).
	 */
	sharedFiles?: string[];
	/**
	 * Install dependencies in the worktree before the agent runs, when a lockfile
	 * is present (detected package manager). Failure is fatal -- a broken install
	 * is never handed to the agent. Default false; the CLI defaults it on.
	 */
	install?: boolean;
}

// Committer identity so commits never fail in a temp repo with no global git
// identity configured. Overridable by the repo's own config when present.
const GIT_IDENTITY: Record<string, string> = {
	GIT_AUTHOR_NAME: "anvil",
	GIT_AUTHOR_EMAIL: "anvil@localhost",
	GIT_COMMITTER_NAME: "anvil",
	GIT_COMMITTER_EMAIL: "anvil@localhost",
};

/**
 * A {@link Workspace} backed by a git worktree and a pi `NodeExecutionEnv`.
 *
 * Isolation: each run gets its own worktree on a dedicated branch, so parallel
 * runs never touch each other's files. The same `ExecutionEnv` ({@link env}) is
 * handed to the agent harness, so the agent and the gate operate on the same
 * worktree — but each `exec` is a fresh subprocess (pi spawns per call), so the
 * agent cannot leave shell state behind for the gate. The gate's clean
 * environment is its own per-command `env` overrides over a stable `process.env`.
 */
export class WorktreeWorkspace implements Workspace {
	readonly cwd: string;
	/** The pi ExecutionEnv on the worktree. Handed to the agent harness (PiAgent, A3). */
	readonly env: NodeExecutionEnv;
	private readonly repoRoot: string;
	private readonly defaultEnv?: Record<string, string>;
	private readonly defaultTimeoutMs?: number;
	private readonly shellPath?: string;
	private removed = false;

	private constructor(args: {
		cwd: string;
		env: NodeExecutionEnv;
		repoRoot: string;
		defaultEnv?: Record<string, string>;
		defaultTimeoutMs?: number;
		shellPath?: string;
	}) {
		this.cwd = args.cwd;
		this.env = args.env;
		this.repoRoot = args.repoRoot;
		this.defaultEnv = args.defaultEnv;
		this.defaultTimeoutMs = args.defaultTimeoutMs;
		this.shellPath = args.shellPath;
	}

	/** Provision the worktree (creates the branch) and return a ready workspace. */
	static async create(opts: WorktreeWorkspaceOptions): Promise<WorktreeWorkspace> {
		const repoRoot = resolve(opts.repoRoot);
		const worktreePath = opts.worktreePath ? resolve(opts.worktreePath) : defaultWorktreePath(repoRoot, opts.branch);
		const baseRef = opts.baseRef ?? "HEAD";

		const provision = new NodeExecutionEnv({ cwd: repoRoot, shellPath: opts.shellPath });
		try {
			await provision.createDir(dirname(worktreePath), { recursive: true });
			const add = `git worktree add -b ${shellQuote(opts.branch)} ${shellQuote(worktreePath)} ${shellQuote(baseRef)}`;
			const res = await provision.exec(add);
			if (!res.ok) throw new Error(`anvil: could not run git worktree add: ${res.error.message}`);
			if (res.value.exitCode !== 0) {
				throw new Error(
					`anvil: git worktree add failed (exit ${res.value.exitCode}): ${res.value.stderr || res.value.stdout}`,
				);
			}
		} finally {
			await provision.cleanup();
		}

		const env = new NodeExecutionEnv({ cwd: worktreePath, shellPath: opts.shellPath });
		const ws = new WorktreeWorkspace({
			cwd: worktreePath,
			env,
			repoRoot,
			defaultEnv: opts.env,
			defaultTimeoutMs: opts.timeoutMs,
			shellPath: opts.shellPath,
		});
		await ws.prepare({ sharedFiles: opts.sharedFiles, install: opts.install });
		return ws;
	}

	/**
	 * Pre-agent worktree setup: bring in shared files (e.g. .env.local) and
	 * install dependencies. Runs once, after provisioning, before the agent's
	 * first turn. Install failure is fatal -- a broken install is never handed to
	 * the agent.
	 */
	private async prepare(opts: { sharedFiles?: string[]; install?: boolean }): Promise<void> {
		if (opts.sharedFiles?.length) {
			await copyShared(this.repoRoot, this.cwd, opts.sharedFiles);
		}
		if (opts.install && (await hasLockfile(this))) {
			const cmd = installCommand(await detectPackageManager(this));
			const res = await this.exec(cmd, { timeoutMs: 600_000 });
			if (res.exitCode !== 0) {
				throw new Error(
					`anvil: worktree dependency install failed (${cmd}, exit ${res.exitCode}):\n${res.stderr || res.stdout}`.trim(),
				);
			}
		}
	}

	async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
		const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
		const res = await this.env.exec(command, {
			env: { ...this.defaultEnv, ...opts?.env },
			// pi's timeout is in whole seconds; floor sub-second timeouts to 1s.
			timeout: timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(timeoutMs / 1000)),
			abortSignal: opts?.signal,
		});
		if (res.ok) {
			return { stdout: res.value.stdout, stderr: res.value.stderr, exitCode: res.value.exitCode };
		}
		// The command could not be run to completion (timeout/spawn/abort/...).
		return { stdout: "", stderr: res.error.message, exitCode: -1, error: res.error.code };
	}

	async readText(path: string): Promise<string | null> {
		const res = await this.env.readTextFile(path);
		return res.ok ? res.value : null;
	}

	async exists(path: string): Promise<boolean> {
		const res = await this.env.exists(path);
		return res.ok ? res.value : false;
	}

	async commit(message: string): Promise<boolean> {
		const status = await this.exec("git status --porcelain");
		if (status.exitCode === 0 && status.stdout.trim() === "") return false;
		// `git add -A` is correct here: the worktree is dedicated to this single run,
		// so there is no concurrent work to clobber — staging everything is the intent.
		const add = await this.exec("git add -A");
		if (add.exitCode !== 0) return false;
		const commit = await this.exec(`git commit -m ${shellQuote(message)}`, { env: GIT_IDENTITY });
		return commit.exitCode === 0;
	}

	async cleanup(): Promise<void> {
		if (this.removed) return;
		this.removed = true;
		await this.env.cleanup();
		const env = new NodeExecutionEnv({ cwd: this.repoRoot, shellPath: this.shellPath });
		try {
			await env.exec(`git worktree remove --force ${shellQuote(this.cwd)}`);
		} finally {
			await env.cleanup();
		}
	}
}

/** Default worktree location: a sibling `<repo>-anvil/<safe-branch>` directory. */
function defaultWorktreePath(repoRoot: string, branch: string): string {
	const safe = branch.replace(/[^a-zA-Z0-9._-]/g, "-");
	return join(dirname(repoRoot), `${basename(repoRoot)}-anvil`, safe);
}

/** POSIX single-quote a shell argument. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Copy shared files (e.g. .env.local) from the source repo into the worktree:
 * symlink, falling back to a copy. A fresh worktree lacks gitignored files, so
 * a gate that needs them (an app's integration suite) can opt in via `--share`.
 */
async function copyShared(srcRoot: string, destRoot: string, patterns: string[]): Promise<void> {
	const seen = new Set<string>();
	for (const pattern of patterns) {
		for await (const rel of glob(pattern, { cwd: srcRoot, exclude: excludeHeavyDirs })) {
			if (seen.has(rel)) continue;
			seen.add(rel);
			const dest = join(destRoot, rel);
			await mkdir(dirname(dest), { recursive: true });
			await rm(dest, { force: true });
			try {
				await symlink(join(srcRoot, rel), dest);
			} catch {
				await cp(join(srcRoot, rel), dest);
			}
		}
	}
}

/** Prune node_modules/.git when walking the source tree for shared-file globs. */
function excludeHeavyDirs(path: string): boolean {
	return path === "node_modules" || path === ".git" || path.includes("/node_modules") || path.includes("/.git");
}

async function hasLockfile(ws: Workspace): Promise<boolean> {
	for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json"]) {
		if (await ws.exists(f)) return true;
	}
	return false;
}

/** The install command for a package manager. pnpm prefers the warm store (fast in a fresh worktree). */
export function installCommand(pm: PackageManager): string {
	switch (pm) {
		case "pnpm":
			return "pnpm install --prefer-offline";
		case "bun":
			return "bun install";
		case "yarn":
			return "yarn install";
		default:
			return "npm install";
	}
}
