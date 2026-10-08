import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecEnv } from "../src/node/exec-env.ts";

// anvil's own exec env (pi 1.0 dropped the ExecutionEnv anvil used to sit on):
// bounded combined output, Result-typed failures with the codes the gate keys
// "inconclusive" on, and env layered over process.env.

const WIDE = { maxBytes: 1024 * 1024, maxLines: 100_000 };

let dir: string;
let env: NodeExecEnv;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "anvil-exec-env-"));
	env = new NodeExecEnv({ cwd: dir });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("NodeExecEnv.exec", () => {
	it("runs in cwd and returns combined stdout+stderr with the exit code", async () => {
		const res = await env.exec("pwd; echo out; echo err >&2; exit 3", { limits: WIDE });
		if (!res.ok) throw new Error(res.error.message);
		expect(res.value.exitCode).toBe(3);
		expect(res.value.output).toContain("out\n");
		expect(res.value.output).toContain("err\n");
		expect(res.value.output.split("\n")[0]).toMatch(/anvil-exec-env-/);
		expect(res.value.truncated).toBe(false);
	});

	it("layers env over process.env (PATH survives) without leaking between calls", async () => {
		const withVar = await env.exec('printf "%s|%s" "$ANVIL_X" "$(command -v git)"', {
			env: { ANVIL_X: "1" },
			limits: WIDE,
		});
		if (!withVar.ok) throw new Error(withVar.error.message);
		const [value, git] = withVar.value.output.split("|");
		expect(value).toBe("1");
		expect(git).toMatch(/git$/);
		const without = await env.exec('[ -z "$ANVIL_X" ] && printf unset', { limits: WIDE });
		expect(without.ok && without.value.output).toBe("unset");
	});

	it("keeps the tail within the line cap and marks truncation", async () => {
		const res = await env.exec("seq 1 100", { limits: { maxBytes: 1024 * 1024, maxLines: 10 } });
		if (!res.ok) throw new Error(res.error.message);
		expect(res.value.truncated).toBe(true);
		expect(res.value.output.trimEnd().split("\n")).toEqual(Array.from({ length: 10 }, (_, i) => String(91 + i)));
	});

	it("keeps the tail within the byte cap without splitting a multi-byte character", async () => {
		const res = await env.exec("for i in $(seq 1 2000); do printf 'é'; done; printf END", {
			limits: { maxBytes: 101, maxLines: 100_000 },
		});
		if (!res.ok) throw new Error(res.error.message);
		expect(res.value.truncated).toBe(true);
		expect(Buffer.byteLength(res.value.output, "utf8")).toBeLessThanOrEqual(101);
		expect(res.value.output.endsWith("END")).toBe(true);
		expect(res.value.output).not.toContain("\uFFFD");
	});

	it("reports a timeout as error code 'timeout', not an exit code", async () => {
		const res = await env.exec("sleep 5", { timeout: 1, limits: WIDE });
		expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout" }) });
	});

	it("reports an abort as error code 'aborted' (and refuses an already-aborted signal)", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const res = await env.exec("sleep 5", { signal: controller.signal, limits: WIDE });
		expect(res).toEqual({ ok: false, error: { code: "aborted", message: "aborted" } });
		const pre = await env.exec("echo never", { signal: AbortSignal.abort(), limits: WIDE });
		expect(pre).toEqual({ ok: false, error: { code: "aborted", message: "aborted" } });
	});

	it("reports a missing cwd as error code 'spawn_error'", async () => {
		const gone = new NodeExecEnv({ cwd: join(dir, "nope") });
		const res = await gone.exec("echo hi", { limits: WIDE });
		expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: "spawn_error" }) });
	});
});

describe("NodeExecEnv files", () => {
	it("writes (creating parent dirs), reads, and checks existence relative to cwd", async () => {
		expect(await env.writeFile("a/b/c.txt", "hello")).toEqual({ ok: true, value: undefined });
		expect(await readFile(join(dir, "a/b/c.txt"), "utf8")).toBe("hello");
		expect(await env.readTextFile("a/b/c.txt")).toEqual({ ok: true, value: "hello" });
		expect(await env.exists("a/b/c.txt")).toBe(true);
		expect(await env.exists(join(dir, "a"))).toBe(true);
		expect(await env.exists("missing.txt")).toBe(false);
	});

	it("reports a missing file as 'not_found'", async () => {
		const res = await env.readTextFile("missing.txt");
		expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
	});
});
