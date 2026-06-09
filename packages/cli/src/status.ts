import { join, resolve } from "node:path";
import { FileStatePersister } from "@anvil/core/node";
import type { Io } from "./run.ts";

const MARK: Record<string, string> = { passed: "+", failed: "x" };

/** List recorded runs (newest first) from the repo's `.anvil/runs` store. */
export async function executeStatus(dir: string, io: Io): Promise<number> {
	const persist = new FileStatePersister({ dir: join(resolve(dir), ".anvil", "runs") });
	const records = await persist.list();
	if (records.length === 0) {
		io.out("no runs recorded");
		return 0;
	}
	for (const r of records) {
		const mark = MARK[r.state] ?? ">";
		io.out(
			`${mark} ${r.state.padEnd(9)} ${r.outcomeId}  (attempt ${r.attempt + 1}/${r.maxAttempts}, ${r.config.model})`,
		);
	}
	return 0;
}
