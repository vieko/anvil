import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRepoBasename, encodeRepoPath, repoStateDirs, stateRoot } from "../src/state-paths.ts";

describe("encodeRepoPath", () => {
	it("mirrors pi's encodeCwd: strip leading sep, replace separators+colon, wrap in --..--", () => {
		expect(encodeRepoPath("/Users/me/dev/project")).toBe("--Users-me-dev-project--");
	});

	it("encodes Windows-style paths (backslashes and drive colon)", () => {
		// Faithful to pi: ':' and '\' each map to '-' without collapsing the run,
		// so the drive prefix becomes 'C--'.
		expect(encodeRepoPath("C:\\Users\\me\\dev")).toBe("--C--Users-me-dev--");
	});
});

describe("stateRoot", () => {
	it("prefers $XDG_STATE_HOME/anvil when set", () => {
		expect(stateRoot({ XDG_STATE_HOME: "/x/state" })).toBe(join("/x/state", "anvil"));
	});

	it("falls back to ~/.anvil when XDG_STATE_HOME is unset or blank", () => {
		expect(stateRoot({})).toBe(join(homedir(), ".anvil"));
		expect(stateRoot({ XDG_STATE_HOME: "   " })).toBe(join(homedir(), ".anvil"));
	});
});

describe("repoStateDirs", () => {
	it("buckets runs/ and sessions/ under <stateRoot>/<encoded-repo>", () => {
		const env = { XDG_STATE_HOME: "/x/state" };
		const { runsDir, sessionsDir } = repoStateDirs("/Users/me/dev/project", env);
		expect(runsDir).toBe(join("/x/state", "anvil", "--Users-me-dev-project--", "runs"));
		expect(sessionsDir).toBe(join("/x/state", "anvil", "--Users-me-dev-project--", "sessions"));
	});

	it("never lands inside the target repo working tree", () => {
		const { runsDir, sessionsDir } = repoStateDirs("/Users/me/dev/project", { XDG_STATE_HOME: "/x/state" });
		expect(runsDir.startsWith("/Users/me/dev/project")).toBe(false);
		expect(sessionsDir.startsWith("/Users/me/dev/project")).toBe(false);
	});
});

describe("decodeRepoBasename", () => {
	it("returns the last path segment when nothing on disk disambiguates", () => {
		expect(decodeRepoBasename("--Users-me-dev-project--")).toBe("project");
	});

	it("re-joins dashed directory names greedily against the filesystem", () => {
		const dirs = new Set(["/Users", "/Users/me", "/Users/me/dev", "/Users/me/dev/my-repo", "/Users/me/dev/my"]);
		const isDir = (p: string) => dirs.has(p);
		// `/Users/me/dev/my` exists too, but `/Users/me/dev/my/repo` does not while
		// `/Users/me/dev/my-repo` does: the dashed name wins.
		expect(decodeRepoBasename("--Users-me-dev-my-repo--", isDir)).toBe("my-repo");
		expect(decodeRepoBasename("--Users-me-dev-my--", isDir)).toBe("my");
	});
});
