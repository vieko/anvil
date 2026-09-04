import type { AgentHarnessTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { ConstrainedSamplingConfig, TextContent } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { execCaptured } from "./pi-exec.ts";

// anvil's own read/edit/write/bash tools, bound to a pi ExecutionEnv. Lean and
// headless — no TUI/highlight/image deps. The contract (parameter names, the
// exact-unique-match edit, head/tail truncation) deliberately matches what
// coding models are trained on (cribbed from pi-coding-agent's tools), so a
// capable model uses them well; the implementations are ours.
//
// pi 0.85 tools are harness-native: `execute` receives the turn's Context as its
// last argument (cancellation + telemetry) and every ExecutionEnv call takes it.
// anvil needs no per-turn tool context, so TContext is `undefined`.

/** An anvil tool: a pi harness tool with no tool context of its own. */
export type AnvilTool<TParameters extends TSchema = TSchema> = AgentHarnessTool<undefined, TParameters>;

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB

// Prefer (never require) strict JSON-Schema constrained sampling on every
// anvil tool: on providers/models that advertise `supportsStrictTools`, this
// tightens argument generation; everywhere else the model degrades to normal
// tool-calling, so a `require` here would be a correctness hazard, not a gain.
const PREFER_STRICT_JSON_SCHEMA: ConstrainedSamplingConfig = { type: "json_schema", strict: "prefer" };

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

export function createReadTool(env: ExecutionEnv): AnvilTool<typeof readSchema> {
	return {
		name: "read",
		label: "Read",
		description:
			"Read the contents of a text file. Output is truncated to the first " +
			`${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
			"Use offset/limit to page through large files.",
		parameters: readSchema,
		constrainedSampling: PREFER_STRICT_JSON_SCHEMA,
		async execute(_id, { path, offset, limit }, _onUpdate, _toolContext, _invocation, context) {
			const content = unwrap(await env.readTextFile(path, context), `Could not read ${path}`);
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

export function createEditTool(env: ExecutionEnv): AnvilTool<typeof editSchema> {
	return {
		name: "edit",
		label: "Edit",
		description:
			"Edit a file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping " +
			"region of the file. Keep oldText minimal but unique; merge nearby changes into one edit rather than " +
			"emitting overlapping edits. Each oldText is matched against the original file, not after earlier edits apply.",
		parameters: editSchema,
		constrainedSampling: PREFER_STRICT_JSON_SCHEMA,
		async execute(_id, { path, edits }, _onUpdate, _toolContext, _invocation, context) {
			const original = unwrap(await env.readTextFile(path, context), `Could not edit ${path}`);

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
			unwrap(await env.writeFile(path, out, context), `Could not write ${path}`);
			return { content: [text(`Successfully replaced ${edits.length} block(s) in ${path}.`)], details: {} };
		},
	};
}

// ── write ────────────────────────────────────────────────────

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full contents to write. Creates the file or overwrites it." }),
});

export function createWriteTool(env: ExecutionEnv): AnvilTool<typeof writeSchema> {
	return {
		name: "write",
		label: "Write",
		description: "Create a new file or overwrite an existing one with the given contents.",
		parameters: writeSchema,
		constrainedSampling: PREFER_STRICT_JSON_SCHEMA,
		async execute(_id, { path, content }, _onUpdate, _toolContext, _invocation, context) {
			unwrap(await env.writeFile(path, content, context), `Could not write ${path}`);
			return { content: [text(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}.`)], details: {} };
		},
	};
}

// ── bash ─────────────────────────────────────────────────────

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional; no default timeout)" })),
});

export function createBashTool(env: ExecutionEnv, extraEnv?: Record<string, string>): AnvilTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description:
			"Execute a bash command in the working directory. Returns combined stdout/stderr and the exit code. " +
			`Output is truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
			"A non-zero exit code is returned as output, not an error.",
		parameters: bashSchema,
		constrainedSampling: PREFER_STRICT_JSON_SCHEMA,
		async execute(_id, { command, timeout }, _onUpdate, _toolContext, _invocation, context) {
			// pi 0.85 bounds shell output at the source: the retained tail is exactly
			// anvil's documented cap, so no second truncation pass is needed here.
			const result = await execCaptured(
				env,
				command,
				{
					...(timeout === undefined ? {} : { timeout }),
					...(extraEnv === undefined ? {} : { env: extraEnv }),
					limits: { maxBytes: MAX_BYTES, maxLines: MAX_LINES, retain: "tail" },
				},
				context,
			);
			if (!result.ok) {
				// Could not run to completion (timeout/spawn/abort) -- a real tool error.
				throw new Error(`Command could not run (${result.error.code}): ${result.error.message}`);
			}
			const { output, truncated, exitCode } = result.value;
			const body = truncated ? `${output}\n... (truncated)` : output;
			return {
				content: [text(`${body}\n[exit code: ${exitCode}]`)],
				details: { exitCode },
			};
		},
	};
}

/**
 * The default tool set that gives the agent hands: read, edit, write, bash.
 * `bashEnv` (e.g. `ANVIL_RUN_ID` / `ANVIL_ATTEMPT` / `ANVIL_MODEL` /
 * `ANVIL_EFFORT`) is layered into every bash tool invocation's environment.
 */
export function defaultTools(env: ExecutionEnv, bashEnv?: Record<string, string>): AnvilTool[] {
	return [createReadTool(env), createEditTool(env), createWriteTool(env), createBashTool(env, bashEnv)];
}
