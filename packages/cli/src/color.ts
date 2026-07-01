/**
 * ANSI color for the human `-v` stream, kept deliberately tiny and injectable.
 *
 * The stream is append-only and routinely piped, `tee`'d, and `tmux
 * capture-pane`'d, so color must never leak into a non-TTY. We model that as a
 * {@link Palette}: render functions take one, production passes the TTY-derived
 * palette, and tests pass {@link plainPalette} to assert byte-for-byte plain
 * output. No dependency -- escapes are plain ASCII (ESC = 0x1b).
 */
export interface Palette {
	/** Secondary text (the reasoning trace). */
	dim(text: string): string;
	/** A passing signal (`+`, the verdict on success). */
	green(text: string): string;
	/** A failing signal (`x`, the verdict on failure). */
	red(text: string): string;
	/** Emphasis (the run-header id). */
	bold(text: string): string;
}

/** No-op palette: every method returns its input unchanged. The pipe/log default. */
export const plainPalette: Palette = {
	dim: (text) => text,
	green: (text) => text,
	red: (text) => text,
	bold: (text) => text,
};

const ESC = "\u001b[";
const wrap = (open: number, close: number, text: string): string => `${ESC}${open}m${text}${ESC}${close}m`;

/** ANSI palette for an interactive terminal. */
export const ansiPalette: Palette = {
	dim: (text) => wrap(2, 22, text),
	green: (text) => wrap(32, 39, text),
	red: (text) => wrap(31, 39, text),
	bold: (text) => wrap(1, 22, text),
};

/**
 * Pick a palette for a stream. Precedence, strongest to weakest:
 *
 *   1. `NO_COLOR` (https://no-color.org) -- the off switch always wins, so a
 *      caller can force plain output regardless of anything else.
 *   2. `FORCE_COLOR` -- the escape hatch for environments whose TTY probe lies
 *      (CI logs, `less -R`, a tmux pane reporting isTTY=false). Follows the
 *      supports-color convention: "0" (or empty) is off, any other value is on.
 *   3. The stream's own `isTTY` -- ansi on a real terminal, plain when piped,
 *      tee'd, or capture-pane'd.
 *
 * The env is injected so the decision is pure and testable.
 */
export function paletteFor(stream: { isTTY?: boolean }, env: Record<string, string | undefined>): Palette {
	if (env.NO_COLOR) return plainPalette;
	if (env.FORCE_COLOR !== undefined) {
		return env.FORCE_COLOR === "" || env.FORCE_COLOR === "0" ? plainPalette : ansiPalette;
	}
	return stream.isTTY ? ansiPalette : plainPalette;
}

/**
 * Per-stream palettes. Color is gated by the destination's own TTY status so a
 * redirected stdout (e.g. `anvil run x > out.txt`) stays plain even when stderr
 * is still a terminal -- `out` paints stdout writes, `err` paints stderr writes.
 */
export interface Palettes {
	out: Palette;
	err: Palette;
}

/** Both streams plain: the pipe/log default and the test default. */
export const plainPalettes: Palettes = { out: plainPalette, err: plainPalette };
