import { describe, expect, it } from "vitest";
import { parse, parseSince } from "../src/cli.ts";

describe("parse", () => {
	it("parses an inline run with defaults", () => {
		const cmd = parse(["run", "make the build green"]);
		expect(cmd).toEqual({
			kind: "run",
			outcome: "make the build green",
			options: {
				dir: undefined,
				from: undefined,
				model: undefined,
				maxAttempts: undefined,
				verify: [],
				gateCrashPattern: [],
				baseline: true,
				link: [],
				install: true,
				contract: [],
				scope: [],
				quiet: false,
				verbose: false,
				reasoning: false,
				json: false,
			},
		});
	});

	it("parses run options", () => {
		const cmd = parse([
			"run",
			"specs/auth.md",
			"--from",
			"main",
			"--model",
			"opus",
			"-n",
			"5",
			"--verify",
			"npm test",
			"--gate-crash-pattern",
			"runner died",
			"--gate-crash-pattern",
			"spawn error",
			"--no-baseline",
			"--verify",
			"tsc --noEmit",
			"--link",
			"**/.env.local",
			"--no-install",
			"--contract",
			"tests/x.test.ts",
			"--scope",
			"apps/**/route.ts",
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
				from: "main",
				model: "opus",
				maxAttempts: 5,
				verify: ["npm test", "tsc --noEmit"],
				gateCrashPattern: ["runner died", "spawn error"],
				baseline: false,
				link: ["**/.env.local"],
				install: false,
				contract: ["tests/x.test.ts"],
				scope: ["apps/**/route.ts"],
				quiet: true,
				verbose: true,
				reasoning: false,
				json: false,
			},
		});
	});

	it("parses --reasoning (display-only) and --effort (level setter)", () => {
		expect(parse(["run", "x", "--reasoning"])).toMatchObject({ kind: "run", options: { reasoning: true } });
		expect(parse(["run", "x", "--effort", "high"])).toMatchObject({ kind: "run", options: { effort: "high" } });
		expect(parse(["run", "x", "--effort", "bogus"])).toMatchObject({ kind: "error" });
	});

	it("parses --json for run and status", () => {
		expect(parse(["run", "x", "--json"])).toMatchObject({ kind: "run", options: { json: true } });
		expect(parse(["status", "--json"])).toEqual({
			kind: "status",
			dir: undefined,
			json: true,
			since: undefined,
			all: false,
			prune: false,
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
		expect(parse(["status"])).toEqual({
			kind: "status",
			dir: undefined,
			json: false,
			since: undefined,
			all: false,
			prune: false,
		});
		expect(parse(["status", "-C", "/r"])).toEqual({
			kind: "status",
			dir: "/r",
			json: false,
			since: undefined,
			all: false,
			prune: false,
		});
	});

	it("parses status --prune", () => {
		expect(parse(["status", "--prune"])).toMatchObject({ kind: "status", prune: true });
	});

	it("parses status --since (duration or ISO date) and --all; rejects a malformed --since", () => {
		expect(parse(["status", "--since", "7d", "--all"])).toMatchObject({ kind: "status", since: "7d", all: true });
		expect(parse(["status", "--since", "2026-01-02"])).toMatchObject({ kind: "status", since: "2026-01-02" });
		expect(parse(["status", "--since", "soon"])).toMatchObject({ kind: "error" });
	});

	it("handles version, help, no-args, and unknowns", () => {
		expect(parse(["--version"])).toEqual({ kind: "version" });
		expect(parse(["--help"])).toEqual({ kind: "help" });
		expect(parse([])).toEqual({ kind: "help" });
		expect(parse(["bogus"])).toMatchObject({ kind: "error", message: expect.stringContaining("unknown command") });
		expect(parse(["run", "x", "--nope"])).toMatchObject({ kind: "error" });
	});
});

describe("parseSince", () => {
	const now = new Date("2026-03-10T12:00:00Z");

	it("resolves d/h/m durations back from now", () => {
		expect(parseSince("7d", now)?.toISOString()).toBe("2026-03-03T12:00:00.000Z");
		expect(parseSince("24h", now)?.toISOString()).toBe("2026-03-09T12:00:00.000Z");
		expect(parseSince("90m", now)?.toISOString()).toBe("2026-03-10T10:30:00.000Z");
	});

	it("accepts an ISO date and rejects anything else", () => {
		expect(parseSince("2026-03-01T00:00:00Z", now)?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
		expect(parseSince("2026-03-01", now)?.getTime()).toBe(Date.parse("2026-03-01"));
		expect(parseSince("7w", now)).toBeNull();
		expect(parseSince("yesterday", now)).toBeNull();
	});
});
