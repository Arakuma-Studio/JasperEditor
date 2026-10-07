// Mask tracking (wp masks; Premiere's Track Selected Mask Backward / Backward One Frame / Forward One Frame /
// Forward): plans the engine `track` job of kind `mask` from the document and turns its result (one homography per
// source frame, reference → frame, media px) into Mask Path keys (`mask.setPathKeys`). Shared by the UI and the MCP
// tools so both build identical requests.
import { evaluate } from '../keyframes.ts';
import { type BezierPath, flattenPath, mapPath, type PathPoint } from '../path/model.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import type { Animatable } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Mask, MaskTrackMethod } from '../schema/mask.ts';
import type { Clip, EffectInstance } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { mediaFrameRate } from '../tracking/request.ts';
import { stepOfRate } from '../tracking/samples.ts';
import { MASK_DEFAULT_TRACK_METHOD } from './model.ts';

export type MaskTrackMode = 'forward' | 'backward' | 'step-forward' | 'step-back';

export type MaskTrackPlan = {
	maskId: string;
	clipId: string;
	sequenceId: string;
	mediaId: string;
	mediaRate: Rational;
	/** Flicks per source frame. */
	step: number;
	/** Layer box (media display px). */
	box: { width: number; height: number };
	/** The mask path at the reference frame (normalised layer coordinates). */
	path: BezierPath;
	/** Engine request body (without the media key). */
	request: {
		kind: 'mask';
		reference: { frame: number; polygon: [number, number][] };
		range: { startFrame: number; endFrame: number };
		direction: 'forward' | 'backward';
		quality: 'balanced';
		options: { maskMethod: MaskTrackMethod };
		trackerId: string;
	};
};

/** The mask and its clip anywhere in the document. */
export function findMask(
	doc: ProjectDocument,
	maskId: string,
): { sequenceId: string; clip: Clip; mask: Mask; effect: EffectInstance | null } | null {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips)) {
			const c = clip as { masks?: Mask[]; effects?: EffectInstance[] };
			const m = c.masks?.find((x) => x.id === maskId);
			if (m) return { sequenceId: seq.id, clip, mask: m, effect: null };
			for (const fx of c.effects ?? []) {
				const e = fx.masks?.find((x) => x.id === maskId);
				if (e) return { sequenceId: seq.id, clip, mask: e, effect: fx };
			}
		}
	return null;
}

/**
 * The engine request for a mask tracking action from content time `at` (the playhead): the path there is the
 * reference; forward / backward run to the end / start of the clip's content (or `frames` frames), the steps one
 * frame.
 */
export function planMaskTrack(
	doc: ProjectDocument,
	maskId: string,
	opts: { mode: MaskTrackMode; at: number; method?: MaskTrackMethod; frames?: number },
): MaskTrackPlan {
	const loc = findMask(doc, maskId);
	if (!loc) throw new Error(`Mask not found: ${maskId}`);
	const { clip, mask, sequenceId } = loc;
	if (clip.kind !== 'video')
		throw new Error('Masks can be tracked on video clips only (the picture must move)');
	const seq = doc.sequences[sequenceId]!;
	const asset = doc.media[clip.mediaId];
	const rate = mediaFrameRate(asset);
	if (!rate) throw new Error('The clip has no video stream');
	const step = stepOfRate(rate);
	const box = intrinsicBoxOf({ clip, doc, seq });
	// The clip's content span in source frames.
	const span = clip.duration * flicksPerFrame(seq.settings.frameRate) * clip.speed.rate;
	const first = Math.max(0, Math.floor(clip.sourceIn / step + 1e-6));
	let end = Math.max(first + 1, Math.ceil((clip.sourceIn + span) / step - 1e-6));
	const dur = asset?.probe.durationFlicks;
	if (dur && dur > 0) end = Math.max(first + 1, Math.min(end, Math.round(dur / step)));
	const frame = Math.min(end - 1, Math.max(first, Math.round(opts.at / step)));
	const n = opts.frames;
	let range: { startFrame: number; endFrame: number };
	let direction: 'forward' | 'backward';
	switch (opts.mode) {
		case 'forward':
			range = { startFrame: frame, endFrame: n ? Math.min(end, frame + n + 1) : end };
			direction = 'forward';
			break;
		case 'backward':
			range = { startFrame: n ? Math.max(first, frame - n) : first, endFrame: frame + 1 };
			direction = 'backward';
			break;
		case 'step-forward':
			range = { startFrame: frame, endFrame: Math.min(end, frame + 2) };
			direction = 'forward';
			break;
		case 'step-back':
			range = { startFrame: Math.max(first, frame - 1), endFrame: frame + 1 };
			direction = 'backward';
			break;
	}
	if (range.endFrame - range.startFrame < 2)
		throw new Error(
			direction === 'forward'
				? 'Already at the last frame of the clip'
				: 'Already at the first frame of the clip',
		);
	const path = evaluate(mask.path as Animatable<BezierPath>, frame * step);
	const toPx = (q: PathPoint): PathPoint => [q[0] * box.width, q[1] * box.height];
	const polygon = flattenPath({ closed: true, vertices: mapPath(path, toPx).vertices }, 0.5).pts.map(
		(p) => [p[0], p[1]] as [number, number],
	);
	if (polygon.length < 3) throw new Error('The mask needs a closed outline to be tracked');
	return {
		maskId,
		clipId: clip.id,
		sequenceId,
		mediaId: clip.mediaId,
		mediaRate: rate,
		step,
		box,
		path,
		request: {
			kind: 'mask',
			reference: { frame, polygon },
			range,
			direction,
			quality: 'balanced',
			options: { maskMethod: opts.method ?? mask.trackMethod ?? MASK_DEFAULT_TRACK_METHOD },
			trackerId: maskId,
		},
	};
}

/**
 * Mask Path keys from a `track` result (`stride` 9: row-major homographies reference → frame in media px). Keys
 * stop at the first lost frame in the tracking direction (as Premiere stops); `lost` reports it.
 */
export function maskKeysFromTrack(
	plan: MaskTrackPlan,
	result: {
		startFrame: number;
		stride: number;
		data: readonly number[];
		confidence: readonly number[];
		lost: readonly number[];
	},
): { keys: { at: { flicks: number }; path: BezierPath }[]; lostAt: number | null } {
	if (result.stride !== 9) throw new Error('Not a mask tracking result');
	const n = result.confidence.length;
	const ref = plan.request.reference.frame;
	const lost = new Set(result.lost);
	const { width: W, height: H } = plan.box;
	const keyOf = (f: number) => {
		const i = f - result.startFrame;
		const h = result.data.slice(i * 9, i * 9 + 9);
		const map = (q: PathPoint): PathPoint => {
			const x = q[0] * W;
			const y = q[1] * H;
			const w = h[6]! * x + h[7]! * y + h[8]!;
			return [(h[0]! * x + h[1]! * y + h[2]!) / w / W, (h[3]! * x + h[4]! * y + h[5]!) / w / H];
		};
		return { at: { flicks: Math.round(f * plan.step) }, path: mapPath(plan.path, map) };
	};
	const keys: { at: { flicks: number }; path: BezierPath }[] = [];
	let lostAt: number | null = null;
	const fwd = plan.request.direction === 'forward';
	for (let k = 0; k < n; k++) {
		const f = fwd ? ref + k : ref - k;
		const i = f - result.startFrame;
		if (i < 0 || i >= n) break;
		if (f !== ref && lost.has(f)) {
			lostAt = f;
			break;
		}
		keys.push(keyOf(f));
	}
	if (!fwd) keys.reverse();
	return { keys, lostAt };
}
