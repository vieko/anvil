import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatePersister } from "../src/index.ts";
import { CommandGate, PiAgent, runToGate, WorktreeWorkspace } from "../src/node/index.ts";

// The capstone: the whole engine end-to-end with only the MODEL faked. A real
// git worktree, the real read/write tools mutating it, the real gate verifying
// via real shell exec, and a real commit on pass. This is the thesis in one
// test: define outcome -> agent works -> deterministic gate -> loop.

let tmpRoot: string;
let repoRoot: string;
let faux: ReturnType<typeof registerFauxProvider>;
let model: Model<string>;

const noopPersist: StatePersister = { async save() {} };

function git(args: string[]): void {
	execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
}

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "anvil-e2e-"));
	repoRoot = join(tmpRoot, "repo");
	await mkdir(repoRoot);
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@t.test"]);
	git(["config", "user.name", "tester"]);
	await writeFile(join(repoRoot, "README.md"), "seed\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "init"]);
	faux = registerFauxProvider({ models: [{ id: "faux", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
	model = faux.getModel();
});

afterEach(async () => {
	faux.unregister();
	await rm(tmpRoot, { recursive: true, force: true });
});

async function setup(branch: string) {
	const ws = await WorktreeWorkspace.create({ repoRoot, branch });
	const agent = new PiAgent({
		env: ws.env,
		resolveModel: () => model,
		systemPrompt: "test",
		getApiKeyAndHeaders: async () => ({ apiKey: "faux" }),
	});
	// The gate is satisfied only when answer.txt contains exactly "42".
	const gate = new CommandGate({ commands: [{ cmd: 'test "$(cat answer.txt 2>/dev/null)" = "42"' }] });
	return { ws, agent, gate };
}

describe("runToGate end-to-end (real worktree + tools + gate, faux model)", () => {
	it("the agent edits the worktree until the gate passes, then commits", async () => {
		const { ws, agent, gate } = await setup("e2e/pass");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "answer.txt", content: "42" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		try {
			const res = await runToGate(
				{ id: "answer", prompt: "make answer.txt contain 42" },
				{ agent, workspace: ws, gate, persist: noopPersist },
			);
			expect(res.passed).toBe(true);
			expect(res.attempts).toBe(1);
			expect(await readFile(join(ws.cwd, "answer.txt"), "utf8")).toBe("42");
			const log = await ws.exec("git log --oneline");
			expect(log.stdout).toContain("anvil: answer");
		} finally {
			await ws.cleanup();
		}
	});

	it("loops: a failing first attempt feeds the gate error back, then the second passes", async () => {
		const { ws, agent, gate } = await setup("e2e/loop");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "answer.txt", content: "0" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("first attempt"),
			fauxAssistantMessage([fauxToolCall("write", { path: "answer.txt", content: "42" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("second attempt"),
		]);
		try {
			const res = await runToGate(
				{ id: "answer", prompt: "make answer.txt contain 42" },
				{ agent, workspace: ws, gate, persist: noopPersist },
			);
			expect(res.passed).toBe(true);
			expect(res.attempts).toBe(2);
			expect(await readFile(join(ws.cwd, "answer.txt"), "utf8")).toBe("42");
		} finally {
			await ws.cleanup();
		}
	});
});
