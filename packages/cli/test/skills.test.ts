import { describe, expect, it } from "vitest";
import { parse } from "../src/cli.ts";
import type { Io } from "../src/run.ts";
import { executeSkills } from "../src/skills.ts";

function capture(): { io: Io; lines: string[] } {
	const lines: string[] = [];
	return { lines, io: { out: (l) => lines.push(l), err: (l) => lines.push(l) } };
}

describe("parse skills", () => {
	it("defaults bare `skills` to list", () => {
		expect(parse(["skills"])).toEqual({ kind: "skills", action: "list", name: undefined, full: false });
	});

	it("parses `skills get <name> --full`", () => {
		expect(parse(["skills", "get", "core", "--full"])).toEqual({
			kind: "skills",
			action: "get",
			name: "core",
			full: true,
		});
	});

	it("errors on an unknown subcommand", () => {
		expect(parse(["skills", "frobnicate"])).toMatchObject({ kind: "error" });
	});
});

describe("executeSkills", () => {
	it("lists the bundled core guide", async () => {
		const { io, lines } = capture();
		expect(await executeSkills("list", undefined, false, io)).toBe(0);
		expect(lines.some((l) => l.startsWith("core"))).toBe(true);
	});

	it("prints the core guide, defaulting a missing name to core", async () => {
		const { io, lines } = capture();
		expect(await executeSkills("get", undefined, false, io)).toBe(0);
		const out = lines.join("\n");
		expect(out).toContain("anvil run");
		expect(out).toContain("gate");
	});

	it("appends reference material with --full", async () => {
		const plain = capture();
		await executeSkills("get", "core", false, plain.io);
		const full = capture();
		await executeSkills("get", "core", true, full.io);
		const plainText = plain.lines.join("\n");
		const fullText = full.lines.join("\n");
		expect(fullText.length).toBeGreaterThan(plainText.length);
		expect(fullText).toContain("reference:");
	});

	it("returns 1 for an unknown skill", async () => {
		const { io } = capture();
		expect(await executeSkills("get", "nope", false, io)).toBe(1);
	});
});
