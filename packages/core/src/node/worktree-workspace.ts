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
	 * Glob patterns (relative to the repo root) to link into the worktree before
	 * the agent runs -- e.g. ["**\/.env.local"]. Symlink, with copy fallback.
	 * Linked in but never committed (a fresh worktree lacks gitignored files).
	 */
	linkedFiles?: string[];
	/**
	 * Install dependencies in the worktree before the agent runs, when a lockfile
	 * is present (detected package manager). Failure is fatal -- a broken install
	 * is never handed to the agent. Default false; the CLI defaults it on.
	 */
	install?: boolean;
	/**
	 * Contract file(s) (paths relative to the repo root) copied from the source
	 * tree into the worktree and committed into the base, then frozen: the agent
	 * must SATISFY them, not edit them. {@link WorktreeWorkspace.assertContract}
	 * reports any modification; the engine treats it as a terminal, non-pass failure.
	 */
	contractFiles?: string[];
	/**
	 * Blast-radius globs (relative to the repo root) for `--scope`. When set, the
	 * agent may only modify files matching one of these; {@link WorktreeWorkspace.assertScope}
	 * reports any change outside them and the engine treats it as a terminal,
	 * non-pass failure. The mirror of {@link contractFiles}'s freeze.
	 */
	scopeGlobs?: string[];
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
	/** The branch this worktree was created on. Surfaced to RunRecord via the Workspace seam. */
	readonly branch: string;
	/** The pi ExecutionEnv on the worktree. Handed to the agent harness (PiAgent, A3). */
	readonly env: NodeExecutionEnv;
	private readonly repoRoot: string;
	private readonly defaultEnv?: Record<string, string>;
	private readonly defaultTimeoutMs?: number;
	private readonly shellPath?: string;
	private removed = false;
	private contractPaths: string[] = [];
	private scopeGlobs: string[] = [];

	private constructor(args: {
		cwd: string;
		branch: string;
		env: NodeExecutionEnv;
		repoRoot: string;
		defaultEnv?: Record<string, string>;
		defaultTimeoutMs?: number;
		shellPath?: string;
	}) {
		this.cwd = args.cwd;
		this.branch = args.branch;
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
			branch: opts.branch,
			env,
			repoRoot,
			defaultEnv: opts.env,
			defaultTimeoutMs: opts.timeoutMs,
			shellPath: opts.shellPath,
		});
		ws.scopeGlobs = opts.scopeGlobs ?? [];
		await ws.prepare({ contractFiles: opts.contractFiles, linkedFiles: opts.linkedFiles, install: opts.install });
		return ws;
	}

	/**
	 * Pre-agent worktree setup: link in host files (e.g. .env.local) and install
	 * dependencies. Runs once, after provisioning, before the agent's first turn.
	 * Install failure is fatal -- a broken install is never handed to the agent.
	 */
	private async prepare(opts: { contractFiles?: string[]; linkedFiles?: string[]; install?: boolean }): Promise<void> {
		if (opts.contractFiles?.length) {
			this.contractPaths = await seedContract(this.repoRoot, this.cwd, opts.contractFiles, (cmd, o) =>
				this.exec(cmd, o),
			);
		}
		if (opts.linkedFiles?.length) {
			await linkFiles(this.repoRoot, this.cwd, opts.linkedFiles);
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
		// --no-verify: anvil's worktree commits are mechanism (capture/seed), not
		// developer commits. Project pre-commit hooks (husky/lint-staged/typecheck)
		// assume a dev's full toolchain and can be slow, flaky, or secret-dependent;
		// correctness is the gate's job, not the hook's.
		const commit = await this.exec(`git commit -m ${shellQuote(message)} --no-verify`, { env: GIT_IDENTITY });
		return commit.exitCode === 0;
	}

	/**
	 * Contract integrity: the first seeded contract path whose working-tree
	 * content differs from the seeded base commit (modified or deleted), or null
	 * when all are intact. No-op when no contract was seeded.
	 */
	async assertContract(): Promise<{ path: string; diff: string } | null> {
		for (const path of this.contractPaths) {
			const diff = await this.exec(`git diff HEAD -- ${shellQuote(path)}`);
			if (diff.exitCode === 0 && diff.stdout.trim() !== "") {
				return { path, diff: diff.stdout };
			}
		}
		return null;
	}

	/**
	 * Blast-radius check: the agent-modified paths (working tree, vs the base the
	 * worktree forked from) that match NONE of the configured scope globs, or null
	 * when every change is in scope (or no scope was set). The seeded contract is
	 * committed into the base, so it never appears here -- only the agent's own
	 * uncommitted edits are scoped.
	 */
	async assertScope(): Promise<{ outside: string[] } | null> {
		if (this.scopeGlobs.length === 0) return null;
		const changed = await this.changedPaths();
		const outside = changed.filter((p) => !this.scopeGlobs.some((g) => matchesGlob(g, p)));
		return outside.length > 0 ? { outside } : null;
	}

	/** Every path touched in the worktree (modified, added, deleted, renamed, untracked). */
	private async changedPaths(): Promise<string[]> {
		const res = await this.exec("git status --porcelain");
		if (res.exitCode !== 0) return [];
		const paths = new Set<string>();
		for (const line of res.stdout.split("\n")) {
			if (line.trim() === "") continue;
			const body = line.slice(3); // strip the "XY " status prefix
			const arrow = body.indexOf(" -> "); // rename/copy: both endpoints count
			if (arrow >= 0) {
				paths.add(unquoteGitPath(body.slice(0, arrow)));
				paths.add(unquoteGitPath(body.slice(arrow + 4)));
			} else {
				paths.add(unquoteGitPath(body));
			}
		}
		return [...paths];
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
 * Link host files (e.g. .env.local) from the source repo into the worktree:
 * symlink, falling back to a copy. A fresh worktree lacks gitignored files, so
 * a gate that needs them (an app's integration suite) can opt in via `--link`.
 */
async function linkFiles(srcRoot: string, destRoot: string, patterns: string[]): Promise<void> {
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

/** Prune node_modules/.git when walking the source tree for linked-file globs. */
function excludeHeavyDirs(path: string): boolean {
	return path === "node_modules" || path === ".git" || path.includes("/node_modules") || path.includes("/.git");
}

/**
 * Copy contract file(s) from the source tree into the worktree and commit them
 * into the base, so they are present at HEAD and {@link WorktreeWorkspace.assertContract}
 * can diff against them. Returns the committed relative paths. A missing source
 * file is fatal (a user error in `--contract`).
 */
async function seedContract(
	srcRoot: string,
	destRoot: string,
	files: string[],
	exec: (cmd: string, opts?: ExecOptions) => Promise<ExecResult>,
): Promise<string[]> {
	for (const rel of files) {
		const dest = join(destRoot, rel);
		await mkdir(dirname(dest), { recursive: true });
		try {
			await cp(join(srcRoot, rel), dest);
		} catch {
			throw new Error(`anvil: --contract file not found in the source repo: ${rel}`);
		}
	}
	const add = await exec(`git add ${files.map(shellQuote).join(" ")}`);
	if (add.exitCode !== 0) {
		throw new Error(`anvil: could not stage contract file(s): ${(add.stderr || add.stdout).trim()}`);
	}
	// `git diff --cached --quiet` exits non-zero when there ARE staged changes.
	const staged = await exec("git diff --cached --quiet");
	if (staged.exitCode !== 0) {
		// --no-verify: see WorktreeWorkspace.commit -- skip project pre-commit hooks.
		const commit = await exec(`git commit -m ${shellQuote("anvil: seed contract")} --no-verify`, {
			env: GIT_IDENTITY,
		});
		if (commit.exitCode !== 0) {
			throw new Error(`anvil: could not commit contract file(s): ${(commit.stderr || commit.stdout).trim()}`);
		}
	}
	return files;
}

async function hasLockfile(ws: Workspace): Promise<boolean> {
	for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json"]) {
		if (await ws.exists(f)) return true;
	}
	return false;
}

/** git status --porcelain double-quotes paths with special chars and C-escapes them; undo that. */
function unquoteGitPath(path: string): string {
	if (path.startsWith('"') && path.endsWith('"')) {
		return path.slice(1, -1).replace(/\\(.)/g, "$1");
	}
	return path;
}

/**
 * Match a repo-relative path against a simple glob: `**` spans path segments,
 * `*` matches within a segment, `?` one non-slash char. Deterministic and
 * fs-free (unlike node's fs.glob), so --scope matching needs no disk walk.
 */
export function matchesGlob(glob: string, path: string): boolean {
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					re += "(?:[^/]+/)*"; // "**/" -> zero or more path segments
					i++;
				} else {
					re += ".*"; // trailing/bare "**" -> anything, including slashes
				}
			} else {
				re += "[^/]*"; // "*" -> within one segment
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
		}
	}
	return new RegExp(`${re}$`).test(path);
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
