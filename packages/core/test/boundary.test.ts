import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The "." entry of @anvil/core must stay runtime-agnostic: no node builtins, no
// SDK, no git. Node-bound code lives only under src/node/ (the "./node" entry).
// This test enforces that invariant structurally — any new file at the src root
// must stay pure, or the gate fails.

const SRC = join(import.meta.dirname, "..", "src");

function pureSourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "node") continue; // the node-bound closure
			pureSourceFiles(full, acc);
		} else if (entry.endsWith(".ts")) {
			acc.push(full);
		}
	}
	return acc;
}

function isNodeBound(spec: string): boolean {
	return (
		spec.startsWith("node:") ||
		spec.startsWith("@earendil-works") ||
		spec === "./node" ||
		spec.includes("/node/") ||
		spec.endsWith("/node.ts")
	);
}

describe("core purity boundary", () => {
	const files = pureSourceFiles(SRC);

	it("finds the pure source closure", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		const rel = file.slice(SRC.length + 1);
		it(`${rel} imports nothing node-bound`, () => {
			const src = readFileSync(file, "utf8");
			const specs = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
			const leaks = specs.filter(isNodeBound);
			expect(leaks, `${rel} leaks node-bound imports: ${leaks.join(", ")}`).toEqual([]);
		});
	}
});
