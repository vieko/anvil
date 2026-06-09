import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord, StatePersister } from "../index.ts";

export interface FileStatePersisterOptions {
	/** Directory to store run records in (one JSON file per outcome). Created on first save. */
	dir: string;
}

/**
 * Durable {@link StatePersister}: one JSON file per outcome under `dir`, each
 * written atomically (temp file + rename) so a crash mid-write never corrupts
 * state. This is what makes `runToGate({ resume: true })` survive a process
 * crash. One file per outcome keeps the store naturally bounded.
 */
export class FileStatePersister implements StatePersister {
	private readonly dir: string;

	constructor(options: FileStatePersisterOptions) {
		this.dir = options.dir;
	}

	async save(record: RunRecord): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const target = join(this.dir, fileNameFor(record.outcomeId));
		const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, JSON.stringify(record, null, 2));
		await rename(tmp, target); // atomic on POSIX
	}

	async load(outcomeId: string): Promise<RunRecord | null> {
		try {
			return JSON.parse(await readFile(join(this.dir, fileNameFor(outcomeId)), "utf8")) as RunRecord;
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	async list(): Promise<RunRecord[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const records: RunRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue; // skip in-flight .tmp files
			try {
				records.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as RunRecord);
			} catch {
				// skip unreadable/partial files
			}
		}
		return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
}

/** Deterministic, collision-safe, human-readable file name for an outcome id. */
function fileNameFor(outcomeId: string): string {
	const readable = outcomeId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
	const hash = createHash("sha256").update(outcomeId).digest("hex").slice(0, 12);
	return `${readable}.${hash}.json`;
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
