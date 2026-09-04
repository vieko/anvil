import {
	applyShellOutputUpdate,
	BACKGROUND_CONTEXT,
	type Context,
	type ExecutionEnv,
	type ExecutionError,
	type Result,
	type ShellOutputLimits,
	type ShellOutputView,
	withAbortSignal,
} from "@earendil-works/pi-agent-core";

// pi 0.85 threads a Context through every ExecutionEnv/Session/harness call
// (cancellation + telemetry). anvil's own seams (Workspace.exec, the gate) carry
// an AbortSignal instead, so this is the single place that bridges the two.

/**
 * The Context for a call anvil makes outside a harness turn: the background
 * root, carrying the caller's AbortSignal when there is one (pi 0.85 dropped
 * `ShellExecOptions.abortSignal` — cancellation now travels on the Context).
 */
export function contextFor(signal?: AbortSignal): Context {
	return signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
}

export interface CapturedExec {
	/** Combined stdout+stderr, bounded by the requested limits. pi 0.85 merges the two streams. */
	output: string;
	/** True when the limits dropped part of the output. */
	truncated: boolean;
	exitCode: number;
}

export interface CapturedExecOptions {
	env?: Record<string, string>;
	/** Timeout in whole seconds (pi's unit). */
	timeout?: number;
	/** Source-side bound on the retained output. Callers state their own. */
	limits: ShellOutputLimits;
}

/**
 * Run a command and collect its bounded combined output. pi 0.85's `exec`
 * resolves to metadata only — the text arrives through `onUpdate` — so every
 * anvil caller that wants the output funnels through here.
 */
export async function execCaptured(
	env: ExecutionEnv,
	command: string,
	options: CapturedExecOptions,
	context: Context,
): Promise<Result<CapturedExec, ExecutionError>> {
	let view: ShellOutputView | undefined;
	const result = await env.exec(
		command,
		{
			...(options.env === undefined ? {} : { env: options.env }),
			...(options.timeout === undefined ? {} : { timeout: options.timeout }),
			capture: { limits: options.limits },
			onUpdate: (update) => {
				view = applyShellOutputUpdate(view, update);
			},
		},
		context,
	);
	if (!result.ok) return result;
	return {
		ok: true,
		value: {
			output: view?.text ?? "",
			truncated: result.value.truncation.truncated,
			exitCode: result.value.exitCode,
		},
	};
}
