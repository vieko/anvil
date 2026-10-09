import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { ExecError as CommandErrorCode } from "../index.ts";

// anvil's execution environment: the filesystem + shell seam that the agent's
// tools and the worktree workspace share. pi 1.0 dropped the ExecutionEnv this
// used to sit on, so anvil owns the small part that matters to it (bounded
// combined output, Result-typed failures, path resolution) and borrows pi's
// local shell operations for the hard part (process-tree kill, timeout, abort,
// stdio handles held by detached descendants).

/** Why a file operation could not complete. */
export type FileErrorCode = "aborted" | "not_found" | "io_error";

/** A failed command (codes the gate reads as "inconclusive") or file operation. */
export interface ExecFailure<TCode extends string = CommandErrorCode | FileErrorCode> {
	code: TCode;
	message: string;
}

export type ExecOutcome<T, TCode extends string = CommandErrorCode | FileErrorCode> =
	| { ok: true; value: T }
	| { ok: false; error: ExecFailure<TCode> };

/** Source-side bound on retained command output. The tail is kept. */
export interface OutputLimits {
	maxBytes: number;
	maxLines: number;
}

export interface CapturedExec {
	/** Combined stdout+stderr in arrival order, bounded by the requested limits. */
	output: string;
	/** True when the limits dropped part of the output. */
	truncated: boolean;
	exitCode: number;
}

export interface CapturedExecOptions {
	/** Variables layered over `process.env` for this command. */
	env?: Record<string, string>;
	/** Timeout in whole seconds. */
	timeout?: number;
	signal?: AbortSignal;
	limits: OutputLimits;
}

/** The filesystem + shell seam rooted at one directory (a worktree). Relative paths resolve against `cwd`. */
export interface ExecEnv {
	readonly cwd: string;
	exec(command: string, options: CapturedExecOptions): Promise<ExecOutcome<CapturedExec, CommandErrorCode>>;
	readTextFile(path: string, signal?: AbortSignal): Promise<ExecOutcome<string, FileErrorCode>>;
	writeFile(path: string, content: string, signal?: AbortSignal): Promise<ExecOutcome<void, FileErrorCode>>;
	exists(path: string): Promise<boolean>;
}

export interface NodeExecEnvOptions {
	cwd: string;
	/** Custom bash path. Default: pi's resolution (/bin/bash, then bash on PATH, then sh). */
	shellPath?: string;
}

/** The node-backed {@link ExecEnv}. Each `exec` is a fresh subprocess, so no shell state carries over. */
export class NodeExecEnv implements ExecEnv {
	readonly cwd: string;
	private readonly ops: BashOperations;

	constructor(options: NodeExecEnvOptions) {
		this.cwd = resolve(options.cwd);
		this.ops = createLocalBashOperations(
			options.shellPath === undefined ? undefined : { shellPath: options.shellPath },
		);
	}

	async exec(command: string, options: CapturedExecOptions): Promise<ExecOutcome<CapturedExec, CommandErrorCode>> {
		if (options.signal?.aborted) return { ok: false, error: { code: "aborted", message: "aborted" } };
		const tail = new TailBuffer(options.limits);
		try {
			// pi's shell ops replace the child env rather than layering it, so the
			// merge over process.env happens here (and keeps pi's own bin dir off PATH).
			const { exitCode } = await this.ops.exec(command, this.cwd, {
				onData: (chunk) => tail.push(chunk),
				env: { ...process.env, ...options.env },
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.timeout === undefined ? {} : { timeout: options.timeout }),
			});
			const { output, truncated } = tail.result();
			return { ok: true, value: { output, truncated, exitCode: exitCode ?? 1 } };
		} catch (error) {
			return { ok: false, error: classifyExecError(error, options.signal) };
		}
	}

	async readTextFile(path: string, signal?: AbortSignal): Promise<ExecOutcome<string, FileErrorCode>> {
		const resolved = this.resolve(path);
		try {
			return { ok: true, value: await readFile(resolved, { encoding: "utf8", ...(signal ? { signal } : {}) }) };
		} catch (error) {
			return { ok: false, error: fileError(error, resolved) };
		}
	}

	async writeFile(path: string, content: string, signal?: AbortSignal): Promise<ExecOutcome<void, FileErrorCode>> {
		const resolved = this.resolve(path);
		try {
			if (signal?.aborted) return { ok: false, error: { code: "aborted", message: "aborted" } };
			await mkdir(dirname(resolved), { recursive: true });
			await writeFile(resolved, content, { encoding: "utf8", ...(signal ? { signal } : {}) });
			return { ok: true, value: undefined };
		} catch (error) {
			return { ok: false, error: fileError(error, resolved) };
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await access(this.resolve(path));
			return true;
		} catch {
			return false;
		}
	}

	/** Resolve against cwd; `~` / `~/` expand to the home directory (the convention coding models use). */
	private resolve(path: string): string {
		if (path === "~") return homedir();
		if (path.startsWith("~/")) return join(homedir(), path.slice(2));
		return isAbsolute(path) ? path : resolve(this.cwd, path);
	}
}

/** pi's shell ops throw `aborted`, `timeout:<n>`, or a spawn/cwd error; map them onto anvil's codes. */
function classifyExecError(error: unknown, signal: AbortSignal | undefined): ExecFailure<CommandErrorCode> {
	const message = error instanceof Error ? error.message : String(error);
	if (signal?.aborted || message === "aborted") return { code: "aborted", message: "aborted" };
	if (message.startsWith("timeout:") || message.startsWith("Invalid timeout")) return { code: "timeout", message };
	return { code: "spawn_error", message };
}

function fileError(error: unknown, path: string): ExecFailure<FileErrorCode> {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOENT") return { code: "not_found", message: `File not found: ${path}` };
	if (code === "ABORT_ERR" || (error as { name?: unknown } | null)?.name === "AbortError") {
		return { code: "aborted", message: "aborted" };
	}
	return { code: "io_error", message };
}

/**
 * Keeps the tail of a byte stream within a line and byte budget. Chunks are
 * kept raw and decoded once at the end, so a multi-byte character split across
 * chunks is never mangled; memory stays near the budget because whole chunks
 * fall off the front once the retained bytes exceed it.
 */
class TailBuffer {
	private readonly limits: OutputLimits;
	private chunks: Buffer[] = [];
	private bytes = 0;
	private dropped = false;

	constructor(limits: OutputLimits) {
		this.limits = limits;
	}

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		// Keep at most one chunk beyond the byte budget; result() trims precisely.
		while (this.chunks.length > 1 && this.bytes - this.chunks[0].length >= this.limits.maxBytes) {
			this.bytes -= this.chunks[0].length;
			this.chunks.shift();
			this.dropped = true;
		}
	}

	result(): { output: string; truncated: boolean } {
		let buffer = Buffer.concat(this.chunks);
		let truncated = this.dropped;
		if (buffer.length > this.limits.maxBytes) {
			buffer = buffer.subarray(buffer.length - this.limits.maxBytes);
			// Skip UTF-8 continuation bytes so the retained tail starts on a character boundary.
			let start = 0;
			while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
			buffer = buffer.subarray(start);
			truncated = true;
		}
		let output = buffer.toString("utf8");
		const lines = output.split("\n");
		// A trailing newline ends the last line; it does not start a new one.
		const lineCount = output.endsWith("\n") ? lines.length - 1 : lines.length;
		if (lineCount > this.limits.maxLines) {
			output = lines.slice(lineCount - this.limits.maxLines).join("\n");
			truncated = true;
		}
		return { output, truncated };
	}
}
