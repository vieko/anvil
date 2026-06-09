import type { RunRecord, StatePersister } from "./types.ts";

/**
 * In-memory {@link StatePersister}: keeps the latest record per outcome. The
 * default for tests and ephemeral runs. Pure — no node, no disk. For durable
 * crash-resumability across processes, use the node `FileStatePersister`.
 */
export class MemoryStatePersister implements StatePersister {
	private readonly records = new Map<string, RunRecord>();

	async save(record: RunRecord): Promise<void> {
		this.records.set(record.outcomeId, { ...record });
	}

	async load(outcomeId: string): Promise<RunRecord | null> {
		const record = this.records.get(outcomeId);
		return record ? { ...record } : null;
	}

	async list(): Promise<RunRecord[]> {
		return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
}

/** A {@link StatePersister} that discards everything. For runs that don't need persistence. */
export const nullStatePersister: StatePersister = {
	async save() {},
	async load() {
		return null;
	},
	async list() {
		return [];
	},
};
