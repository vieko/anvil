import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHermeticModelRuntime } from "../../src/node/pi-agent.ts";

/** A hermetic model runtime with the given (faux) providers registered: no network, no key. */
export async function fauxModelRuntime(...providers: Provider[]): Promise<ModelRuntime> {
	const runtime = await createHermeticModelRuntime();
	for (const provider of providers) runtime.registerNativeProvider(provider);
	return runtime;
}
