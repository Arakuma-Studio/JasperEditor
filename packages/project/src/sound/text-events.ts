// Text animation timing shared by the cue deriver (`sound/cues/text.ts`) and the anchor resolver (`sound/anchor.ts`),
// so a typewriter or Range Selector cue resolves back to the frame it was derived at. Pure.

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Typed units of a text (`char`: every non-space grapheme; `word`: whitespace-separated words). */
export function textUnitCount(text: string, unit: 'char' | 'word'): number {
	if (typeof text !== 'string' || text.length === 0) return 0;
	if (unit === 'word') return text.split(/\s+/).filter(Boolean).length;
	const Seg = (globalThis as { Intl?: { Segmenter?: new (l?: string, o?: object) => unknown } }).Intl
		?.Segmenter;
	if (Seg) {
		const seg = new Seg(undefined, { granularity: 'grapheme' }) as {
			segment(s: string): Iterable<{ segment: string }>;
		};
		let n = 0;
		for (const s of seg.segment(text)) if (!/^\s+$/.test(s.segment)) n++;
		return n;
	}
	return Array.from(text).filter((ch) => !/\s/.test(ch)).length;
}

/**
 * Keystroke schedule of a typewriter window (the renderer's `typewriterSchedule`, `@jasper/motion`): unit `i` is typed
 * at `start + slot·i` ms; `delay` / `typing` are fractions of the window (typewriter@1 has neither).
 */
export function typewriterScheduleMs(
	units: number,
	durationMs: number,
	params: Record<string, unknown>,
): { start: number; slot: number } {
	const num = (v: unknown, d: number) => (fin(v) ? v : d);
	const total = Math.max(1, durationMs);
	const delay = Math.min(0.9, Math.max(0, num(params.delay, 0)));
	const typing = Math.min(1 - delay, Math.max(0.05, num(params.typing, 1)));
	return { start: total * delay, slot: (total * typing) / Math.max(1, Math.floor(units)) };
}

/**
 * Keystroke frames (offsets from the window start) of a typewriter window, from `typewriterScheduleMs`. In: unit i
 * shows from the first frame whose seek time reaches its keystroke (`⌈t/frame⌉`). Out plays the In timeline mirrored
 * (window frame k seeks `(N − 1 − k)` frames): the i-th deleted unit (the (n − 1 − i)-th typed) is gone from frame
 * `N − ⌈t/frame⌉` (N = the window's length: the first typed unit stays to the end).
 */
export function typewriterOffsets(
	units: number,
	windowFrames: number,
	fps: number,
	params: Record<string, unknown>,
	side: 'in' | 'out',
): number[] {
	const n = Math.max(0, Math.floor(units));
	if (n === 0 || windowFrames <= 0 || !(fps > 0)) return [];
	const frameMs = 1000 / fps;
	const { start, slot } = typewriterScheduleMs(n, windowFrames * frameMs, params);
	const typed = Array.from({ length: n }, (_, i) =>
		Math.min(windowFrames, Math.max(0, Math.ceil((start + slot * i) / frameMs - 1e-9))),
	);
	if (side === 'in') return typed;
	return typed.map((x) => windowFrames - x).reverse();
}
