import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where anvil keeps its per-run state (run records + session transcripts).
 *
 * State lives in a user-level directory bucketed by the target repo path, NOT
 * inside the target repo's working tree. Writing under `<repo>/.anvil/...`
 * pollutes `git status` with untracked files -- a mild annoyance solo, actively
 * disruptive on a checkout shared across concurrent sessions, where another
 * agent/dev sees anvil's records as noise that survives worktree cleanup
 * (issue #7).
 *
 * The layout mirrors pi's `~/.pi/agent/sessions/<encoded-cwd>/`: one bucket per
 * repo, keyed by an encoded absolute path, so cross-repo `anvil status` can read
 * every run from one root and state is decoupled from the `.git` lifecycle.
 */

/**
 * Encode an absolute repo path into a single path segment, mirroring pi's
 * `JsonlSessionRepo.encodeCwd`: strip a leading separator, replace path
 * separators and ':' with '-', wrap in '--...--'. Keeping the exact scheme means
 * anvil's buckets line up with pi's session layout.
 */
export function encodeRepoPath(repoRoot: string): string {
	return `--${repoRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Root of anvil's user-level state: `$XDG_STATE_HOME/anvil`, falling back to
 * `~/.anvil`. `env` is injectable for tests; production passes `process.env`.
 */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_STATE_HOME?.trim();
	return xdg ? join(xdg, "anvil") : join(homedir(), ".anvil");
}

/**
 * The per-repo state bucket for `repoRoot` (must be absolute): `runs/` for run
 * records, `sessions/` for transcripts. Both the writer (`buildRunDeps`) and the
 * reader (`status`) call this so they always agree on the location.
 */
export function repoStateDirs(
	repoRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): { runsDir: string; sessionsDir: string } {
	const base = join(stateRoot(env), encodeRepoPath(repoRoot));
	return { runsDir: join(base, "runs"), sessionsDir: join(base, "sessions") };
}

interface DecodedCandidate {
	path: string;
	name: string;
	exists: boolean;
}

/**
 * Best-effort inverse of {@link encodeRepoPath}. The encoding is lossy (a '-'
 * inside a directory name and a separator both became '-'), so every decoding
 * whose prefixes exist on disk (`isDir`) is tried -- from a missing prefix only
 * the dash-join can still lead to a real directory, which keeps the search
 * small -- and the last segment stands in when none does.
 */
function decodeCandidates(encoded: string, isDir: (path: string) => boolean): DecodedCandidate[] {
	const segments = encoded.replace(/^--/, "").replace(/--$/, "").split("-");
	let candidates: DecodedCandidate[] = [{ path: "", name: "", exists: true }];
	for (const segment of segments) {
		const next: DecodedCandidate[] = [];
		for (const c of candidates) {
			if (c.exists) {
				const path = `${c.path}/${segment}`;
				next.push({ path, name: segment, exists: isDir(path) });
			}
			if (c.path !== "") {
				const path = `${c.path}-${segment}`;
				next.push({ path, name: `${c.name}-${segment}`, exists: isDir(path) });
			}
		}
		candidates = next;
	}
	return candidates;
}

/** Best-effort inverse of {@link encodeRepoPath}: the repo's basename. */
export function decodeRepoBasename(encoded: string, isDir: (path: string) => boolean = () => false): string {
	const segments = encoded.replace(/^--/, "").replace(/--$/, "").split("-");
	if (segments.length === 0 || segments[0] === "") return encoded;
	const candidates = decodeCandidates(encoded, isDir);
	return candidates.find((c) => c.exists)?.name ?? segments[segments.length - 1];
}

/**
 * Best-effort inverse of {@link encodeRepoPath}: the repo's full absolute path,
 * used by `anvil status --prune` (#41) to point at a stale run's worktree.
 * Null when no candidate resolves to a real directory (the repo was moved or
 * deleted since the run) -- the caller then has nothing trustworthy to print.
 */
export function decodeRepoPath(encoded: string, isDir: (path: string) => boolean = () => false): string | null {
	const candidate = decodeCandidates(encoded, isDir).find((c) => c.exists);
	return candidate ? candidate.path : null;
}
