import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeRepoPath, repoStateDirs, stateRoot } from "../src/state-paths.ts";

describe("encodeRepoPath", () => {
	it("mirrors pi's encodeCwd: strip leading sep, replace separators+colon, wrap in --..--", () => {
		expect(encodeRepoPath("/Users/vieko/dev/gtm")).toBe("--Users-vieko-dev-gtm--");
	});

	it("encodes Windows-style paths (backslashes and drive colon)", () => {
		// Faithful to pi: ':' and '\' each map to '-' without collapsing the run,
		// so the drive prefix becomes 'C--'.
		expect(encodeRepoPath("C:\\Users\\vieko\\dev")).toBe("--C--Users-vieko-dev--");
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
		const { runsDir, sessionsDir } = repoStateDirs("/Users/vieko/dev/gtm", env);
		expect(runsDir).toBe(join("/x/state", "anvil", "--Users-vieko-dev-gtm--", "runs"));
		expect(sessionsDir).toBe(join("/x/state", "anvil", "--Users-vieko-dev-gtm--", "sessions"));
	});

	it("never lands inside the target repo working tree", () => {
		const { runsDir, sessionsDir } = repoStateDirs("/Users/vieko/dev/gtm", { XDG_STATE_HOME: "/x/state" });
		expect(runsDir.startsWith("/Users/vieko/dev/gtm")).toBe(false);
		expect(sessionsDir.startsWith("/Users/vieko/dev/gtm")).toBe(false);
	});
});
