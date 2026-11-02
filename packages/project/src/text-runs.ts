// Styled runs of a text clip (spec 19 TL-093, docs/wp-notes/title-looks.md "Text"): the pure operations behind the
// in-place text toolbar. Offsets are UTF-16 code units of `content.text`, ends exclusive. Runs may overlap in a stored
// document (the renderers merge them, later wins); everything written here is flat: sorted, disjoint and minimal.
import type { TextContent, TextStyle } from './schema/sequence.ts';

export type TextRun = NonNullable<TextContent['runs']>[number];
type ParagraphOverride = NonNullable<TextContent['paragraphs']>[number];
/** What a run sets: style fields and, for the look on the clip, a finish for these letters (null clears it). */
export type RunPatch = { style?: Partial<TextStyle>; finish?: string | null };

const clampTo = (v: number, hi: number) => Math.min(hi, Math.max(0, Number.isFinite(v) ? Math.trunc(v) : 0));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sortedKeys<T extends Record<string, unknown>>(o: T): T {
	return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as T;
}

/**
 * Flat runs of `text`: overlaps resolved (later wins), out-of-range and empty runs dropped, style fields equal to
 * `base` removed, neighbours with the same style joined. Nothing the renderers draw changes.
 */
export function normalizeTextRuns(
	text: string,
	runs: readonly TextRun[] | undefined,
	base?: Partial<TextStyle>,
): TextRun[] {
	if (!runs?.length) return [];
	const n = text.length;
	const clamped = runs
		.map((r) => ({ ...r, from: clampTo(r.from, n), to: clampTo(r.to, n) }))
		.filter((r) => r.to > r.from);
	const cuts = [...new Set(clamped.flatMap((r) => [r.from, r.to]))].sort((a, b) => a - b);
	const out: TextRun[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		const from = cuts[i]!;
		const to = cuts[i + 1]!;
		const covering = clamped.filter((r) => r.from <= from && r.to >= to);
		if (!covering.length) continue;
		const style: Record<string, unknown> = Object.assign({}, ...covering.map((r) => r.style));
		if (base)
			for (const [k, v] of Object.entries(style))
				if (same(v, (base as Record<string, unknown>)[k])) delete style[k];
		let finish: string | undefined;
		for (const r of covering) if (typeof r.finish === 'string') finish = r.finish;
		if (Object.keys(style).length === 0 && finish === undefined) continue;
		const run: TextRun = { from, to, style: sortedKeys(style), ...(finish !== undefined ? { finish } : {}) };
		const last = out[out.length - 1];
		if (last && last.to === from && same(last.style, run.style) && last.finish === run.finish) last.to = to;
		else out.push(run);
	}
	return out;
}

/** What the runs set on the character at `offset` (later runs win), or null. */
export function textRunAt(runs: readonly TextRun[] | undefined, offset: number): TextRun | null {
	const covering = (runs ?? []).filter((r) => r.from <= offset && r.to > offset);
	if (!covering.length) return null;
	let finish: string | undefined;
	for (const r of covering) if (typeof r.finish === 'string') finish = r.finish;
	return {
		from: offset,
		to: offset + 1,
		style: Object.assign({}, ...covering.map((r) => r.style)),
		...(finish !== undefined ? { finish } : {}),
	};
}

/** `runs` with `patch` set on `[from, to)`; fields equal to `base` read as no override. */
export function applyRunPatch(
	text: string,
	runs: readonly TextRun[] | undefined,
	from: number,
	to: number,
	patch: RunPatch,
	base?: Partial<TextStyle>,
): TextRun[] {
	const flat = normalizeTextRuns(text, runs, base);
	const lo = clampTo(Math.min(from, to), text.length);
	const hi = clampTo(Math.max(from, to), text.length);
	if (hi <= lo) return flat;
	const finishOf = (old: string | undefined) => (patch.finish === null ? undefined : (patch.finish ?? old));
	const piece = (a: number, b: number, style: TextRun['style'], old: string | undefined): TextRun => {
		const finish = finishOf(old);
		return { from: a, to: b, style: { ...style, ...patch.style }, ...(finish ? { finish } : {}) };
	};
	const out: TextRun[] = [];
	let at = lo;
	for (const r of flat) {
		if (r.to <= lo || r.from >= hi) {
			out.push(r);
			continue;
		}
		if (r.from < lo) out.push({ ...r, to: lo });
		if (r.from > at) out.push(piece(at, r.from, {}, undefined));
		out.push(piece(Math.max(r.from, lo), Math.min(r.to, hi), r.style, r.finish));
		at = Math.min(r.to, hi);
		if (r.to > hi) out.push({ ...r, from: hi });
	}
	if (at < hi) out.push(piece(at, hi, {}, undefined));
	return normalizeTextRuns(text, out, base);
}

/** `runs` without any override on `[from, to)`. */
export function clearRuns(
	text: string,
	runs: readonly TextRun[] | undefined,
	from: number,
	to: number,
	base?: Partial<TextStyle>,
): TextRun[] {
	const flat = normalizeTextRuns(text, runs, base);
	const lo = clampTo(Math.min(from, to), text.length);
	const hi = clampTo(Math.max(from, to), text.length);
	return flat.flatMap((r) => {
		if (r.to <= lo || r.from >= hi) return [r];
		return [...(r.from < lo ? [{ ...r, to: lo }] : []), ...(r.to > hi ? [{ ...r, from: hi }] : [])];
	});
}

/** The differing region of an edit: `[at, oldEnd)` of `prev` became `[at, newEnd)` of `next`. */
export function textEditSpan(prev: string, next: string): { at: number; oldEnd: number; newEnd: number } {
	const limit = Math.min(prev.length, next.length);
	let at = 0;
	while (at < limit && prev.charCodeAt(at) === next.charCodeAt(at)) at++;
	let tail = 0;
	while (
		tail < limit - at &&
		prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
	)
		tail++;
	return { at, oldEnd: prev.length - tail, newEnd: next.length - tail };
}

/**
 * `runs` of `prev` carried over an edit to `next`. Text typed inside or right after a run takes its style, as in a
 * word processor; at the very start of the text it takes the style of what follows; text replacing a selection takes
 * the style of the first character it replaces; a run whose letters are all gone goes with them.
 */
export function remapTextRuns(prev: string, next: string, runs: readonly TextRun[] | undefined): TextRun[] {
	if (!runs?.length) return [];
	if (prev === next) return runs.map((r) => ({ ...r }));
	const { at, oldEnd, newEnd } = textEditSpan(prev, next);
	const added = newEnd - at;
	const removed = oldEnd - at;
	// Offset with the removed text taken out: positions inside it fall to its start.
	const gone = (x: number) => (x <= at ? x : x >= oldEnd ? x - removed : at);
	const out: TextRun[] = [];
	for (const r of runs) {
		let from = gone(r.from);
		let to = gone(r.to);
		const replaces = removed > 0 && r.from <= at && r.to > at;
		const typedInto = removed === 0 && r.from < at && r.to >= at;
		const atStart = removed === 0 && at === 0 && r.from === 0;
		if (replaces || typedInto || atStart) to += added;
		else {
			if (from >= at) from += added;
			if (to > at) to += added;
		}
		if (to > from) out.push({ ...r, from, to });
	}
	return out;
}

const LINE_BREAK = /\r\n|[\n\r\u2029]/g;
const breaks = (s: string) => s.match(LINE_BREAK)?.length ?? 0;

/** Paragraph overrides carried over an edit: paragraphs after it follow their text, ones it removed go. */
export function remapParagraphs(
	prev: string,
	next: string,
	paragraphs: readonly ParagraphOverride[] | undefined,
): ParagraphOverride[] {
	if (!paragraphs?.length) return [];
	if (prev === next) return paragraphs.map((p) => ({ ...p }));
	const { at, oldEnd, newEnd } = textEditSpan(prev, next);
	const first = breaks(prev.slice(0, at));
	const removed = breaks(prev.slice(at, oldEnd));
	const added = breaks(next.slice(at, newEnd));
	return paragraphs.flatMap((p) => {
		if (p.index <= first) return [p];
		if (p.index <= first + removed) return [];
		return [{ ...p, index: p.index + added - removed }];
	});
}
