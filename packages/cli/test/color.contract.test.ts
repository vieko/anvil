import type { AgentActivity } from "@anvil/core";
import { describe, expect, it } from "vitest";
import { ansiPalette, paletteFor, plainPalette } from "../src/color.ts";
import { renderActivity } from "../src/run.ts";

// Frozen contract (#22): activity rendering is color-agnostic via an injected
// palette. The plain palette must reproduce byte-for-byte the output anvil emits
// today (pipe/log/capture-pane safety is the invariant); the ansi palette wraps
// the same glyphs and text in escapes. paletteFor honors the destination's TTY
// status and the NO_COLOR convention.

const ESC = "\u001b[";
const toolEnd = (ok: boolean): AgentActivity => ({ kind: "tool-end", tool: "edit", ok });
const reasoning: AgentActivity = { kind: "reasoning", text: "thinking" };
const toolStart: AgentActivity = { kind: "tool-start", tool: "bash", summary: "ls" };

describe("color (frozen contract)", () => {
	it("plain palette reproduces today's output byte-for-byte (no escapes)", () => {
		expect(renderActivity(toolStart, plainPalette)).toBe("  > bash: ls");
		expect(renderActivity(toolEnd(true), plainPalette)).toBe("  + edit");
		expect(renderActivity(toolEnd(false), plainPalette)).toBe("  x edit");
		expect(renderActivity(reasoning, plainPalette)).toBe("  ~ thinking");
		expect(renderActivity(reasoning, plainPalette).includes(ESC)).toBe(false);
	});

	it("plain is also the default palette (one-arg callers stay plain)", () => {
		expect(renderActivity(toolEnd(true))).toBe("  + edit");
		expect(renderActivity(reasoning)).toBe("  ~ thinking");
	});

	it("ansi palette adds color cues (green +, red x, dim reasoning) and keeps the text", () => {
		const GREEN = "\u001b[32m";
		const RED = "\u001b[31m";
		const DIM = "\u001b[2m";

		// The glyph is colored; the tool name trails in default fg.
		const ok = renderActivity(toolEnd(true), ansiPalette);
		expect(ok.includes(GREEN)).toBe(true);
		expect(ok.endsWith(" edit")).toBe(true);

		const fail = renderActivity(toolEnd(false), ansiPalette);
		expect(fail.includes(RED)).toBe(true);
		expect(fail.endsWith(" edit")).toBe(true);

		// The whole reasoning line is dimmed, text intact.
		const think = renderActivity(reasoning, ansiPalette);
		expect(think.includes(DIM)).toBe(true);
		expect(think.includes("~ thinking")).toBe(true);
	});

	it("paletteFor picks plain for a non-TTY stream", () => {
		expect(paletteFor({ isTTY: false }, {})).toBe(plainPalette);
		expect(paletteFor({}, {})).toBe(plainPalette);
	});

	it("paletteFor picks ansi for a TTY stream", () => {
		expect(paletteFor({ isTTY: true }, {})).toBe(ansiPalette);
	});

	it("paletteFor honors NO_COLOR even on a TTY", () => {
		expect(paletteFor({ isTTY: true }, { NO_COLOR: "1" })).toBe(plainPalette);
	});
});
