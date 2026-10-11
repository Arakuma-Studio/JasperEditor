import { anim, type Box, defaultSpeed } from '../../factories.ts';
import type { Animatable, LabelColor, Vec2 } from '../../schema/common.ts';
import type { Transform } from '../../schema/sequence.ts';
import type { DDoc, DSeq, DTrack, HandlerContext } from '../context.ts';
import {
	assertKindFits,
	assertUnlocked,
	clearRange,
	insertShift,
	relinkSplits,
	resolveOrCreateTrack,
	type SplitRecord,
	shiftMarkers,
	syncFollowerTracks,
} from '../placement.ts';
import type { TransformPatch } from '../schemas/clip.ts';
import type { CommandOf } from '../schemas/index.ts';

export const frameBox = (seq: DSeq): Box => ({ width: seq.settings.width, height: seq.settings.height });

export function commonFields(
	id: string,
	trackId: string,
	start: number,
	duration: number,
	sourceIn: number,
	name: string,
	label: LabelColor,
) {
	return {
		id,
		trackId,
		start,
		duration,
		sourceIn,
		speed: defaultSpeed(),
		name,
		label,
		enabled: true,
		linkId: null,
		groupId: null,
		markers: [],
	};
}

export function visualFields(transform: Transform) {
	return { transform, opacity: anim(100), blendMode: 'normal' as const, effects: [] };
}

export function applyTransformPatch(t: Transform, p: TransformPatch | undefined): Transform {
	if (!p) return t;
	const vec = (v: Vec2 | Animatable<Vec2>) => (Array.isArray(v) ? anim<Vec2>([v[0], v[1]]) : v);
	const num = (v: number | Animatable<number>) => (typeof v === 'number' ? anim(v) : v);
	return {
		...t,
		...(p.position !== undefined ? { position: vec(p.position) } : {}),
		...(p.anchor !== undefined ? { anchor: vec(p.anchor) } : {}),
		...(p.scale !== undefined ? { scale: num(p.scale) } : {}),
		...(p.scaleWidth !== undefined ? { scaleWidth: num(p.scaleWidth) } : {}),
		...(p.rotation !== undefined ? { rotation: num(p.rotation) } : {}),
		...(p.uniformScale !== undefined ? { uniformScale: p.uniformScale } : {}),
		...(p.flipH !== undefined ? { flipH: p.flipH } : {}),
		...(p.flipV !== undefined ? { flipV: p.flipV } : {}),
	};
}

/** Overwrite `[at, at+n)` on the destination tracks, or insert-shift them plus sync-locked tracks. */
export function makeRoom(
	seq: DSeq,
	h: HandlerContext,
	dest: readonly DTrack[],
	at: number,
	n: number,
	mode: 'overwrite' | 'insert',
	rippleMarkers = true,
): void {
	let splits: SplitRecord[] = [];
	if (mode === 'overwrite') {
		for (const t of dest) splits.push(...clearRange(seq, t.id, at, at + n, h));
	} else {
		const edited = new Set(dest.map((t) => t.id));
		const tracks = [...edited, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
		splits = insertShift(seq, tracks, at, n, h);
		if (rippleMarkers) shiftMarkers(seq, at, n);
	}
	relinkSplits(seq, splits, h);
}

export function prepareTrack(
	seq: DSeq,
	ref: string,
	kind: string,
	h: HandlerContext,
	create: boolean,
): DTrack {
	const t = resolveOrCreateTrack(seq, ref, h, create);
	assertUnlocked(t, h);
	assertKindFits(kind, t, h);
	return t;
}

export function newGeneratorClip(
	doc: DDoc,
	cmd: {
		sequenceId?: string;
		at: CommandOf<'clip.addText'>['at'];
		duration: CommandOf<'clip.addText'>['duration'];
		track: string;
		id?: string;
	},
	h: HandlerContext,
	kind: 'text' | 'solid' | 'motion-graphic' | 'shape' | 'adjustment' | 'camera' | 'light' | 'model',
): { seq: DSeq; track: DTrack; at: number; duration: number; id: string } {
	const seq = h.sequence(doc, cmd.sequenceId);
	const at = h.frame(seq, cmd.at);
	const duration = h.durationFrames(seq, cmd.duration);
	if (at < 0) h.fail('E_INVALID_PARAM', 'Clip start must be >= 0');
	if (duration < 1) h.fail('E_INVALID_PARAM', 'Clip duration must be >= 1 frame');
	const track = prepareTrack(seq, cmd.track, kind, h, true);
	const id = h.newId(doc, 'clp', cmd.id);
	makeRoom(seq, h, [track], at, duration, 'overwrite');
	return { seq, track, at, duration, id };
}
