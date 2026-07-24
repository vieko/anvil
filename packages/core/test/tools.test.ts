import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, createEditTool, createReadTool, createWriteTool, defaultTools } from "../src/node/tools.ts";

let dir: string;
let env: NodeExecutionEnv;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "anvil-tools-"));
	env = new NodeExecutionEnv({ cwd: dir });
});

afterEach(async () => {
	await env.cleanup();
	await rm(dir, { recursive: true, force: true });
});

function run(tool: any, params: any, signal?: AbortSignal): Promise<string> {
	return tool
		.execute("id", params, signal)
		.then((r: { content: { type: string; text?: string }[] }) =>
			r.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
		);
}

describe("read tool", () => {
	it("reads a file, honoring offset/limit (1-indexed)", async () => {
		await writeFile(join(dir, "f.txt"), "l1\nl2\nl3\nl4\nl5");
		const read = createReadTool(env);
		expect(await run(read, { path: "f.txt" })).toBe("l1\nl2\nl3\nl4\nl5");
		expect(await run(read, { path: "f.txt", offset: 2, limit: 2 })).toBe("l2\nl3");
	});

	it("truncates beyond the line cap with a marker", async () => {
		await writeFile(join(dir, "big.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"));
		const out = await run(createReadTool(env), { path: "big.txt" });
		expect(out).toContain("... (truncated)");
		expect(out.split("\n").length).toBeLessThan(2100);
	});
});

describe("edit tool", () => {
	it("applies a single exact replacement", async () => {
		await writeFile(join(dir, "f.txt"), "hello world");
		await run(createEditTool(env), { path: "f.txt", edits: [{ oldText: "world", newText: "there" }] });
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("hello there");
	});

	it("applies a batch of non-overlapping edits against the original", async () => {
		await writeFile(join(dir, "f.txt"), "a b c");
		await run(createEditTool(env), {
			path: "f.txt",
			edits: [
				{ oldText: "a", newText: "X" },
				{ oldText: "c", newText: "Z" },
			],
		});
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("X b Z");
	});

	it("fails loudly when oldText is not found", async () => {
		await writeFile(join(dir, "f.txt"), "hello");
		await expect(
			run(createEditTool(env), { path: "f.txt", edits: [{ oldText: "zzz", newText: "x" }] }),
		).rejects.toThrow(/was not found/);
	});

	it("fails loudly when oldText is not unique", async () => {
		await writeFile(join(dir, "f.txt"), "x x");
		await expect(run(createEditTool(env), { path: "f.txt", edits: [{ oldText: "x", newText: "y" }] })).rejects.toThrow(
			/not unique/,
		);
	});

	it("rejects overlapping edits", async () => {
		await writeFile(join(dir, "f.txt"), "abcdef");
		await expect(
			run(createEditTool(env), {
				path: "f.txt",
				edits: [
					{ oldText: "abc", newText: "" },
					{ oldText: "cde", newText: "" },
				],
			}),
		).rejects.toThrow(/[Oo]verlapping/);
	});
});

describe("write tool", () => {
	it("creates a new file", async () => {
		await run(createWriteTool(env), { path: "new.txt", content: "hi\n" });
		expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("hi\n");
	});
});

describe("bash tool", () => {
	it("returns stdout and a zero exit code", async () => {
		const out = await run(createBashTool(env), { command: "echo hi" });
		expect(out).toContain("hi");
		expect(out).toContain("[exit code: 0]");
	});

	it("returns a non-zero exit code as output, not an error", async () => {
		const out = await run(createBashTool(env), { command: "exit 3" });
		expect(out).toContain("[exit code: 3]");
	});

	it("exposes injected env vars (ANVIL_RUN_ID/ANVIL_ATTEMPT/...) to the executed command", async () => {
		const out = await run(createBashTool(env, { ANVIL_RUN_ID: "r1", ANVIL_ATTEMPT: "1" }), {
			command: "echo $ANVIL_RUN_ID:$ANVIL_ATTEMPT",
		});
		expect(out).toContain("r1:1");
	});

	it("reflects a different attempt's env vars on the next call (no state leaks across attempts)", async () => {
		const first = await run(createBashTool(env, { ANVIL_RUN_ID: "r1", ANVIL_ATTEMPT: "1" }), {
			command: "echo $ANVIL_RUN_ID:$ANVIL_ATTEMPT",
		});
		const second = await run(createBashTool(env, { ANVIL_RUN_ID: "r1", ANVIL_ATTEMPT: "2" }), {
			command: "echo $ANVIL_RUN_ID:$ANVIL_ATTEMPT",
		});
		expect(first).toContain("r1:1");
		expect(second).toContain("r1:2");
	});

	it("still inherits the ambient environment alongside the injected vars", async () => {
		const out = await run(createBashTool(env, { ANVIL_RUN_ID: "r1" }), {
			command: '[ -n "$PATH" ] && echo has-path:$ANVIL_RUN_ID',
		});
		expect(out).toContain("has-path:r1");
	});
});

describe("defaultTools", () => {
	it("gives the agent read/edit/write/bash", () => {
		expect(
			defaultTools(env)
				.map((t) => t.name)
				.sort(),
		).toEqual(["bash", "edit", "read", "write"]);
	});

	it("threads bashEnv into the bash tool only", async () => {
		const tools = defaultTools(env, { ANVIL_RUN_ID: "r7", ANVIL_ATTEMPT: "3" });
		const bash = tools.find((t) => t.name === "bash");
		const out = await run(bash, { command: "echo $ANVIL_RUN_ID:$ANVIL_ATTEMPT" });
		expect(out).toContain("r7:3");
	});

	it("prefers (never requires) strict JSON-Schema constrained sampling on every tool", () => {
		for (const tool of defaultTools(env)) {
			expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		}
	});
});
