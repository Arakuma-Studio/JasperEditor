// An export uses valid preview files and renders only the remaining segments (through its normal
// path, to frame-exact ProRes intermediates), then encodes the concatenation once with the export's encoder and the
// export mix. Like Premiere, the preview frames go through one more encode (generation loss of the preview codec:
// I-frame-only H.264 at ≈ 0.6 bit/pixel is visually transparent; say "Use Previews" only when that is acceptable).
import { BT709_FRAME_TAGS, SWS_FLAGS } from './native.ts';

/** A preview file covering sequence frames [start, start + frames). */
export type PreviewPiece = { start: number; frames: number; file: string };

/** What the export reads: preview files, and the stretches it renders itself. */
export type ExportRun =
	| { kind: 'preview'; start: number; end: number; file: string }
	/** `engine: 'remotion'`: a stretch whose layers could not be baked (`fallbackRuns`), rendered on the Remotion path. */
	| { kind: 'render'; start: number; end: number; engine?: 'remotion' };

/**
 * The runs of `range`: every preview piece fully inside the range is used as is; a piece crossing the range edge is
 * not used (its file starts at the segment's first frame, which the export does not show).
 */
export function exportRuns(
	range: { start: number; end: number },
	pieces: readonly PreviewPiece[],
): ExportRun[] {
	const used = pieces
		.filter((p) => p.frames > 0 && p.start >= range.start && p.start + p.frames <= range.end)
		.sort((a, b) => a.start - b.start);
	const out: ExportRun[] = [];
	let at = range.start;
	for (const p of used) {
		if (p.start < at) continue; // overlapping pieces cannot happen (segments are disjoint); be safe
		if (p.start > at) out.push({ kind: 'render', start: at, end: p.start });
		out.push({ kind: 'preview', start: p.start, end: p.start + p.frames, file: p.file });
		at = p.start + p.frames;
	}
	if (at < range.end) out.push({ kind: 'render', start: at, end: range.end });
	return out;
}

/**
 * The runs of `range` when the layers drawn on `spans` could not be baked (a `LayerBakeError`): those frames, merged
 * when fewer than `mergeFrames` apart, render on the Remotion path and the rest on the export's own path. Null when the
 * Remotion stretches would cover the whole range, or be more than `maxStretches` (the whole range on the Remotion
 * path is then the smaller cost).
 */
export function fallbackRuns(
	range: { start: number; end: number },
	spans: readonly { start: number; end: number }[],
	o: { mergeFrames: number; maxStretches: number },
): ExportRun[] | null {
	const sorted = spans
		.map((s) => ({ start: Math.max(range.start, s.start), end: Math.min(range.end, s.end) }))
		.filter((s) => s.end > s.start)
		.sort((a, b) => a.start - b.start);
	if (sorted.length === 0) return null;
	const merged: { start: number; end: number }[] = [];
	for (const s of sorted) {
		const last = merged.at(-1);
		if (last && s.start - last.end < o.mergeFrames) last.end = Math.max(last.end, s.end);
		else merged.push({ ...s });
	}
	if (merged.length > o.maxStretches) return null;
	// (a native stretch shorter than the merge distance at an edge: drawn by the Remotion stretch next to it)
	if (merged[0]!.start - range.start < o.mergeFrames) merged[0]!.start = range.start;
	if (range.end - merged.at(-1)!.end < o.mergeFrames) merged.at(-1)!.end = range.end;
	const out: ExportRun[] = [];
	let at = range.start;
	for (const s of merged) {
		if (s.start > at) out.push({ kind: 'render', start: at, end: s.start });
		out.push({ kind: 'render', start: s.start, end: s.end, engine: 'remotion' });
		at = s.end;
	}
	if (at < range.end) out.push({ kind: 'render', start: at, end: range.end });
	return out.length > 1 ? out : null;
}

/**
 * The filter graph concatenating `inputs` (each `frames[i]` frames at the sequence rate, any size) into one stream at
 * `size`, then converting it like the native composite's output (rate, fit/fill/stretch, BT.709 TV range).
 */
export function concatFilter(o: {
	frames: readonly number[];
	size: { width: number; height: number };
	fps: { num: number; den: number };
	output: {
		width: number;
		height: number;
		fps: { num: number; den: number };
		scaling: 'fit' | 'fill' | 'stretch';
	};
	encoderFilters: readonly string[];
	/** Pixel format the pieces are joined in (default 8-bit 4:4:4: previews; deeper intermediates keep their depth). */
	pixFmt?: string;
}): string {
	const rate = (r: { num: number; den: number }) => `${r.num}/${r.den}`;
	const { width: W, height: H } = o.size;
	const chains: string[] = [];
	o.frames.forEach((n, i) => {
		// Every piece as exactly `n` CFR frames at the sequence size (half-size previews are never used).
		chains.push(
			`[${i}:v]setpts=N/(${rate(o.fps)})/TB,scale=${W}:${H}:${SWS_FLAGS},setsar=1,format=${o.pixFmt ?? 'yuv444p'},trim=end_frame=${n}[p${i}]`,
		);
	});
	const vout: string[] = [];
	const out = o.output;
	if (out.fps.num * o.fps.den !== o.fps.num * out.fps.den) vout.push(`fps=${rate(out.fps)}`);
	if (out.width !== W || out.height !== H) {
		if (out.scaling === 'stretch') vout.push(`scale=${out.width}:${out.height}`);
		else if (out.scaling === 'fill')
			vout.push(
				`scale=${out.width}:${out.height}:force_original_aspect_ratio=increase`,
				`crop=${out.width}:${out.height}`,
			);
		else
			vout.push(
				`scale=${out.width}:${out.height}:force_original_aspect_ratio=decrease`,
				`pad=${out.width}:${out.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
			);
	}
	vout.push(
		`scale=out_color_matrix=bt709:out_range=tv:${SWS_FLAGS}`,
		'setsar=1',
		BT709_FRAME_TAGS,
		...o.encoderFilters,
	);
	chains.push(`${o.frames.map((_, i) => `[p${i}]`).join('')}concat=n=${o.frames.length}:v=1:a=0[cat]`);
	chains.push(`[cat]${vout.join(',')}[vout]`);
	return chains.join(';\n');
}
