import { describe, expect, it } from "vitest";
import { parse } from "../src/cli.ts";

describe("parse", () => {
	it("parses an inline run with defaults", () => {
		const cmd = parse(["run", "make the build green"]);
		expect(cmd).toEqual({
			kind: "run",
			outcome: "make the build green",
			options: {
				dir: undefined,
				model: undefined,
				maxAttempts: undefined,
				verify: [],
				share: [],
				install: true,
				quiet: false,
				verbose: false,
			},
		});
	});

	it("parses run options", () => {
		const cmd = parse([
			"run",
			"specs/auth.md",
			"--model",
			"opus",
			"-n",
			"5",
			"--verify",
			"npm test",
			"--verify",
			"tsc --noEmit",
			"--share",
			"**/.env.local",
			"--no-install",
			"-C",
			"/tmp/repo",
			"-q",
			"-v",
		]);
		expect(cmd).toEqual({
			kind: "run",
			outcome: "specs/auth.md",
			options: {
				dir: "/tmp/repo",
				model: "opus",
				maxAttempts: 5,
				verify: ["npm test", "tsc --noEmit"],
				share: ["**/.env.local"],
				install: false,
				quiet: true,
				verbose: true,
			},
		});
	});

	it("errors when run has no outcome", () => {
		expect(parse(["run"])).toMatchObject({ kind: "error" });
	});

	it("rejects a non-positive --max-attempts", () => {
		expect(parse(["run", "x", "-n", "0"])).toMatchObject({ kind: "error" });
		expect(parse(["run", "x", "-n", "nope"])).toMatchObject({ kind: "error" });
	});

	it("parses status (with optional -C)", () => {
		expect(parse(["status"])).toEqual({ kind: "status", dir: undefined });
		expect(parse(["status", "-C", "/r"])).toEqual({ kind: "status", dir: "/r" });
	});

	it("handles version, help, no-args, and unknowns", () => {
		expect(parse(["--version"])).toEqual({ kind: "version" });
		expect(parse(["--help"])).toEqual({ kind: "help" });
		expect(parse([])).toEqual({ kind: "help" });
		expect(parse(["bogus"])).toMatchObject({ kind: "error", message: expect.stringContaining("unknown command") });
		expect(parse(["run", "x", "--nope"])).toMatchObject({ kind: "error" });
	});
});
