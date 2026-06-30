import { describe, expect, it } from "vitest";
import { parse } from "../src/cli.ts";

// Frozen contract (#18): `--effort` sets the base reasoning level, validated
// against the five Effort levels (low|medium|high|xhigh|max); an unknown level
// is an error; omitted -> undefined. This pins the new RunOptions.effort field
// and the parse-level validation; threading + normalization are gated by
// `npm run check` and the core default-effort contract.

describe("--effort flag (frozen contract)", () => {
	it("parses each valid level into RunOptions.effort", () => {
		for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
			const cmd = parse(["run", "x", "--effort", level]);
			expect(cmd.kind).toBe("run");
			if (cmd.kind === "run") expect(cmd.options.effort).toBe(level);
		}
	});

	it("rejects an unknown --effort level", () => {
		expect(parse(["run", "x", "--effort", "bogus"])).toMatchObject({ kind: "error" });
	});

	it("defaults effort to undefined when omitted", () => {
		const cmd = parse(["run", "x"]);
		expect(cmd.kind).toBe("run");
		if (cmd.kind === "run") expect(cmd.options.effort).toBeUndefined();
	});
});
