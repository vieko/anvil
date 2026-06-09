import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace's @anvil/core to SOURCE during tests (not built dist),
// so the CLI suite never goes stale against an unbuilt engine. Order matters:
// the more specific "/node" subpath must precede the bare package.
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: "@anvil/core/node", replacement: `${here}../core/src/node/index.ts` },
			{ find: "@anvil/core", replacement: `${here}../core/src/index.ts` },
		],
	},
});
