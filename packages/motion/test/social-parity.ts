// The render-parity policy of the social-comment card tests (social-comment-render and social-review-render e2e), in
// one place so they cannot drift. A frame rendered by `renderStill` (painted alone) and by `renderFrames` (painted after
// other frames) must be:
// - byte-identical AT REST: from the end of the entrance and every extra (words popping, the like count ticking, the
//   stars filling, the thump) to the start of the exit;
// - while the card ANIMATES (entrance, extras, exit), within the project's parity standard for Chrome-painted layers:
//   ≥ 99 % of the pixels within 3/255 (as the layer-bake and determinism tests). Chrome may anti-alias an edge a little
//   differently depending on the frames it painted before (docs/wp-notes/social-comments.md "Paint determinism").
import {
	animeTemplateTiming,
	isSocialVariant,
	socialComment,
	socialCommentParamsSchema,
	socialCommentSchedule,
	socialCommentSegments,
	socialDefaults,
	socialLikesTick,
} from '@jasper/mg-templates';

/** Share of the pixels that must lie within `PARITY_TOLERANCE` while the card animates. */
export const PARITY_MIN_SHARE = 0.99;
/** Largest channel difference (of 255) a pixel may have to count as matching while the card animates. */
export const PARITY_TOLERANCE = 3;

/**
 * Content ms of a clip's rest (the same schedule the implementation builds): `[from, to)` = from the end of the
 * entrance and every extra to the start of the exit. The test clips are 150 frames at 30 fps.
 */
export function restWindow(
	params: Record<string, unknown>,
	o: { fps?: number; durationFrames?: number } = {},
): { from: number; to: number } {
	const variant = isSocialVariant(params.variant) ? params.variant : 'tiktok-reply';
	const p = socialCommentParamsSchema.parse({ ...socialDefaults(variant), ...params });
	const t = animeTemplateTiming(socialComment, {
		fps: o.fps ?? 30,
		localFrame: 0,
		durationFrames: o.durationFrames ?? 150,
	});
	const s = socialCommentSchedule({
		...t,
		entrance: p.entrance,
		units: p.wordReveal ? socialCommentSegments(p.text, p.variant).units : 0,
		tick: socialLikesTick(p),
	});
	let end = s.entranceEnd;
	for (const tr of s.tracks)
		for (const tw of tr.tweens) if (tw.start < s.exitStart) end = Math.max(end, tw.start + tw.dur);
	if (s.tick) end = Math.max(end, s.tick.start + s.tick.dur);
	return { from: end, to: s.exitStart };
}

/** One frame where the still and the sequential render differ. */
export type ParityRow = {
	case: string;
	frame: number;
	/** Pixels that differ at all. */
	pixels: number;
	/** Largest channel difference. */
	max: number;
	/** Share of the pixels within `PARITY_TOLERANCE`. */
	within: number;
	atRest: boolean;
};

/** Compares two RGBA buffers of frame `frame` of a clip with rest window `rest` (content ms; `fps` default 30). */
export function parityRow(
	name: string,
	frame: number,
	still: Uint8Array,
	sequential: Uint8Array,
	rest: { from: number; to: number },
	fps = 30,
): ParityRow {
	let pixels = 0;
	let over = 0;
	let max = 0;
	const n = Math.min(still.length, sequential.length);
	for (let i = 0; i < n; i += 4) {
		let d = 0;
		for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(still[i + k]! - sequential[i + k]!));
		if (d > 0) pixels++;
		if (d > PARITY_TOLERANCE) over++;
		max = Math.max(max, d);
	}
	const ms = (frame * 1000) / fps;
	return {
		case: name,
		frame,
		pixels,
		max,
		within: still.length === sequential.length ? 1 - over / (n / 4) : 0,
		atRest: ms >= rest.from && ms < rest.to,
	};
}

/** The policy's verdict on a differing frame: null when allowed, else what failed. */
export function parityIssue(row: ParityRow): string | null {
	if (row.atRest)
		return `${row.case} frame ${row.frame}: ${row.pixels} px differ at rest, max ${row.max}/255`;
	if (row.within < PARITY_MIN_SHARE)
		return `${row.case} frame ${row.frame}: ${row.pixels} px differ, ${((1 - row.within) * 100).toFixed(2)} % beyond ${PARITY_TOLERANCE}/255`;
	return null;
}
