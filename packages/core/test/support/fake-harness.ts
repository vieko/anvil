import type { AbortResult, AgentHarnessOptions, RunResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import type { Harness, HarnessEvents, HarnessFactory } from "../../src/node/pi-agent.ts";

// A fake of the harness seam PiAgent drives (`PiAgentOptions.createHarness`).
//
// pi 0.84 made `AgentHarness`'s constructor private and left `prompt`/`events`
// unimplemented, so tests can neither subclass nor drive the real class: the
// substitution boundary moves from "the model" to "the harness". The fake is
// still real where it matters -- it executes the tools it is handed against the
// filesystem and emits the harness's own event shapes -- so tool wiring, the
// activity stream, and the runToGate loop are exercised, not simulated.

/** One scripted tool call the fake model makes. Executed against the tools the agent handed the harness. */
export interface FakeToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** One scripted run: everything a single `prompt()` does before it settles. */
export interface FakeRun {
	/** Thinking segment, forwarded as one `message_update` carrying a `thinking_end` assistant event. */
	thinking?: string;
	/** Tool calls executed in order, each bracketed by `tool_start`/`tool_end`. */
	toolCalls?: FakeToolCall[];
	/** Raw events emitted verbatim before the scripted work, to pin how anvil reads a given payload shape. */
	rawEvents?: { type: string; event: unknown }[];
	/** Final assistant text. */
	text?: string;
	/** Usage reported on the final assistant message. */
	usage?: Partial<Usage>;
	/** Settle with this result instead of the default `ok`/`completed` outcome (failure-path tests). */
	result?: RunResult;
	/** Throw from `prompt()` instead of settling. */
	throws?: unknown;
}

export interface FakeHarnessScript {
	/** Scripted runs, consumed in order across every harness the factory builds (one per dispatch). */
	runs?: FakeRun[];
	/** Result returned by `abort()`. Default: accepted. */
	abort?: AbortResult;
	/** Throw from `abort()` instead of returning a result. */
	abortThrows?: unknown;
	/** Throw from `events.on()`, the way a harness that does not implement its event registry does. */
	subscribeThrows?: unknown;
}

export interface FakeHarnessLog {
	/** Options the agent passed to the factory, one entry per dispatch. */
	options: AgentHarnessOptions[];
	/** Prompt text of every `prompt()` call. */
	prompts: string[];
	/** Number of `abort()` calls. */
	aborts: number;
	/** Number of `close()` calls. */
	closes: number;
	/** Event types every registered listener was subscribed to. */
	subscribed: string[];
}

export interface FakeHarnessHandle {
	factory: HarnessFactory;
	log: FakeHarnessLog;
	/** Options of the most recent dispatch. */
	lastOptions(): AgentHarnessOptions | undefined;
}

type Listener = (event: unknown) => void | Promise<void>;

class FakeEventBus implements HarnessEvents {
	private readonly listeners = new Map<string, Set<Listener>>();
	private readonly log: FakeHarnessLog;
	private readonly subscribeThrows: unknown;

	constructor(log: FakeHarnessLog, subscribeThrows?: unknown) {
		this.log = log;
		this.subscribeThrows = subscribeThrows;
	}

	on(type: string, listener: Listener): () => void {
		if (this.subscribeThrows !== undefined) throw this.subscribeThrows;
		this.log.subscribed.push(type);
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener);
		this.listeners.set(type, set);
		return () => set.delete(listener);
	}

	async emit(type: string, event: unknown): Promise<void> {
		for (const listener of [...(this.listeners.get(type) ?? [])]) await listener(event);
	}
}

class FakeHarnessLane implements Harness {
	readonly events: FakeEventBus;
	private readonly options: AgentHarnessOptions;
	private readonly script: FakeHarnessScript;
	private readonly runs: FakeRun[];
	private readonly log: FakeHarnessLog;
	private toolCalls = 0;

	constructor(options: AgentHarnessOptions, script: FakeHarnessScript, runs: FakeRun[], log: FakeHarnessLog) {
		this.options = options;
		this.script = script;
		this.runs = runs;
		this.log = log;
		this.events = new FakeEventBus(log, script.subscribeThrows);
	}

	async prompt(text: string): Promise<RunResult> {
		this.log.prompts.push(text);
		const run = this.runs.shift();
		if (!run) throw new Error(`fake harness: no scripted run left for prompt(${JSON.stringify(text)})`);
		if (run.throws !== undefined) throw run.throws;

		const runId = `run-${this.log.prompts.length}`;
		await this.events.emit("run_start", { type: "run_start", lane: "main", runId });
		for (const raw of run.rawEvents ?? []) await this.events.emit(raw.type, raw.event);
		if (run.thinking !== undefined) await this.emitThinking(runId, run.thinking);
		for (const call of run.toolCalls ?? []) await this.executeTool(runId, call);

		const finalMessage = buildFinalMessage(run);
		const finalEntryId = await this.options.session.appendMessage(finalMessage);
		await this.events.emit("run_end", {
			type: "run_end",
			lane: "main",
			runId,
			outcome: "completed",
			leafId: finalEntryId,
		});
		if (run.result) return run.result;
		return { ok: true, value: { runId, kind: "completed", leafId: finalEntryId, finalEntryId, finalMessage } };
	}

	async abort(): Promise<AbortResult> {
		this.log.aborts += 1;
		if (this.script.abortThrows !== undefined) throw this.script.abortThrows;
		return this.script.abort ?? { ok: true, value: { runId: "run-abort", steer: [], followUp: [] } };
	}

	async close(): Promise<void> {
		this.log.closes += 1;
	}

	/** The harness's streamed reasoning: one `message_update` carrying pi-ai's `thinking_end` assistant event. */
	private async emitThinking(runId: string, thinking: string): Promise<void> {
		await this.events.emit("message_update", {
			type: "message_update",
			lane: "main",
			runId,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: thinking,
				partial: fauxAssistantMessage([fauxThinking(thinking)]),
			},
		});
	}

	/** Bracket a real tool execution with the harness's `tool_start`/`tool_end` events. */
	private async executeTool(runId: string, call: FakeToolCall): Promise<void> {
		const tool = (this.options.tools ?? []).find((candidate) => candidate.name === call.name);
		if (!tool) throw new Error(`fake harness: the agent supplied no tool named "${call.name}"`);
		const toolCallId = `call-${++this.toolCalls}`;
		await this.events.emit("tool_start", {
			type: "tool_start",
			lane: "main",
			runId,
			toolCallId,
			toolName: tool.name,
			args: call.args,
		});
		let isError = false;
		let result: unknown;
		try {
			result = await tool.execute(toolCallId, call.args as never, undefined, undefined);
		} catch (error) {
			isError = true;
			result = { content: [fauxText(String(error))], details: {} };
		}
		await this.events.emit("tool_end", {
			type: "tool_end",
			lane: "main",
			runId,
			toolCallId,
			toolName: tool.name,
			isError,
			result,
		});
	}
}

function buildFinalMessage(run: FakeRun): AssistantMessage {
	const message = fauxAssistantMessage(run.text ?? "");
	const withUsage = run.usage ? { ...message, usage: { ...message.usage, ...run.usage } } : message;
	// Sessions reject durable payloads carrying explicit `undefined`, which the faux message builder leaves behind.
	return Object.fromEntries(Object.entries(withUsage).filter(([, value]) => value !== undefined)) as AssistantMessage;
}

/** Build a {@link HarnessFactory} over a script of runs, plus the log of what the agent asked of it. */
export function createFakeHarness(script: FakeHarnessScript = {}): FakeHarnessHandle {
	const runs = [...(script.runs ?? [])];
	const log: FakeHarnessLog = { options: [], prompts: [], aborts: 0, closes: 0, subscribed: [] };
	return {
		log,
		factory: async (options) => {
			log.options.push(options);
			return new FakeHarnessLane(options, script, runs, log);
		},
		lastOptions: () => log.options.at(-1),
	};
}
