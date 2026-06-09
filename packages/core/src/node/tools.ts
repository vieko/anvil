import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// anvil's own read/edit/write/bash tools, bound to a pi ExecutionEnv. Lean and
// headless — no TUI/highlight/image deps. The contract (parameter names, the
// exact-unique-match edit, head/tail truncation) deliberately matches what
// coding models are trained on (cribbed from pi-coding-agent's tools), so a
// capable model uses them well; the implementations are ours.

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }, context: string): T {
	if (!result.ok) throw new Error(`${context}: ${result.error.message}`);
	return result.value;
}

// ── read ─────────────────────────────────────────────────────

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export function createReadTool(env: ExecutionEnv): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "Read",
		description:
			"Read the contents of a text file. Output is truncated to the first " +
			`${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
			"Use offset/limit to page through large files.",
		parameters: readSchema,
		async execute(_id, { path, offset, limit }) {
			const content = unwrap(await env.readTextFile(path), `Could not read ${path}`);
			const start = offset && offset > 0 ? offset - 1 : 0;
			let lines = content.split("\n").slice(start);
			const hasLimit = limit !== undefined && limit > 0;
			const maxLines = hasLimit ? limit : MAX_LINES;
			let truncated = false;
			if (lines.length > maxLines) {
				lines = lines.slice(0, maxLines);
				// An explicit limit is intentional paging, not truncation -- no marker.
				if (!hasLimit) truncated = true;
			}
			let out = lines.join("\n");
			if (Buffer.byteLength(out, "utf8") > MAX_BYTES) {
				out = Buffer.from(out, "utf8").subarray(0, MAX_BYTES).toString("utf8");
				truncated = true;
			}
			return { content: [text(truncated ? `${out}\n... (truncated)` : out)], details: {} };
		},
	};
}

// ── edit ─────────────────────────────────────────────────────

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({
				description:
					"Exact text for one targeted replacement. Must be unique in the file and must not overlap with another edit's oldText.",
			}),
			newText: Type.String({ description: "Replacement text for this edit." }),
		}),
		{ description: "One or more exact-text replacements applied to the file." },
	),
});

export function createEditTool(env: ExecutionEnv): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "Edit",
		description:
			"Edit a file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping " +
			"region of the file. Keep oldText minimal but unique; merge nearby changes into one edit rather than " +
			"emitting overlapping edits. Each oldText is matched against the original file, not after earlier edits apply.",
		parameters: editSchema,
		async execute(_id, { path, edits }) {
			const original = unwrap(await env.readTextFile(path), `Could not edit ${path}`);

			const spans: { start: number; end: number; newText: string }[] = [];
			edits.forEach(({ oldText, newText }, i) => {
				if (oldText.length === 0) throw new Error(`edits[${i}].oldText must not be empty.`);
				const first = original.indexOf(oldText);
				if (first === -1) throw new Error(`edits[${i}].oldText was not found in ${path}.`);
				if (original.indexOf(oldText, first + 1) !== -1) {
					throw new Error(`edits[${i}].oldText is not unique in ${path}. Add surrounding context to disambiguate.`);
				}
				spans.push({ start: first, end: first + oldText.length, newText });
			});

			spans.sort((a, b) => a.start - b.start);
			for (let i = 1; i < spans.length; i++) {
				if (spans[i].start < spans[i - 1].end) {
					throw new Error(`Overlapping edits in ${path}. Merge nearby changes into one edit.`);
				}
			}

			let out = original;
			for (let i = spans.length - 1; i >= 0; i--) {
				out = out.slice(0, spans[i].start) + spans[i].newText + out.slice(spans[i].end);
			}
			unwrap(await env.writeFile(path, out), `Could not write ${path}`);
			return { content: [text(`Successfully replaced ${edits.length} block(s) in ${path}.`)], details: {} };
		},
	};
}

// ── write ────────────────────────────────────────────────────

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full contents to write. Creates the file or overwrites it." }),
});

export function createWriteTool(env: ExecutionEnv): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "Write",
		description: "Create a new file or overwrite an existing one with the given contents.",
		parameters: writeSchema,
		async execute(_id, { path, content }) {
			unwrap(await env.writeFile(path, content), `Could not write ${path}`);
			return { content: [text(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}.`)], details: {} };
		},
	};
}

// ── bash ─────────────────────────────────────────────────────

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional; no default timeout)" })),
});

export function createBashTool(env: ExecutionEnv): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description:
			"Execute a bash command in the working directory. Returns combined stdout/stderr and the exit code. " +
			`Output is truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
			"A non-zero exit code is returned as output, not an error.",
		parameters: bashSchema,
		async execute(_id, { command, timeout }, signal) {
			const result = await env.exec(command, { timeout, abortSignal: signal });
			if (!result.ok) {
				// Could not run to completion (timeout/spawn/abort) -- a real tool error.
				throw new Error(`Command could not run (${result.error.code}): ${result.error.message}`);
			}
			const { stdout, stderr, exitCode } = result.value;
			const combined = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
			const { value, truncated } = tailTruncate(combined);
			const body = truncated ? `${value}\n... (truncated)` : value;
			return {
				content: [text(`${body}\n[exit code: ${exitCode}]`)],
				details: { exitCode },
			};
		},
	};
}

function tailTruncate(output: string): { value: string; truncated: boolean } {
	let truncated = false;
	let lines = output.split("\n");
	if (lines.length > MAX_LINES) {
		lines = lines.slice(-MAX_LINES);
		truncated = true;
	}
	let value = lines.join("\n");
	if (Buffer.byteLength(value, "utf8") > MAX_BYTES) {
		const buf = Buffer.from(value, "utf8");
		value = buf.subarray(buf.length - MAX_BYTES).toString("utf8");
		truncated = true;
	}
	return { value, truncated };
}

/** The default tool set that gives the agent hands: read, edit, write, bash. */
export function defaultTools(env: ExecutionEnv): AgentTool[] {
	return [createReadTool(env), createEditTool(env), createWriteTool(env), createBashTool(env)];
}
