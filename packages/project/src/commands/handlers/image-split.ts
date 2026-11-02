// Spec 19 TL-115: `clip.splitImage`. Each part is a copy of the clip (timing, effects, opacity, blend, animation) showing
// its piece of the picture, on the same track for the first and on free tracks above for the rest, grouped, so the logo
// still moves as one until someone ungroups it.
//
// Registration: a part's layer map is the clip's translated by the box, so the parts sit exactly where the picture was.
// When Motion has no keyframes each part gets its own anchor at its centre, which is what logo animation wants (scale or
// spin a letter about itself); with keyframes the anchor is moved instead of the position, so the keys stay valid and
// every part follows the same path as the whole.
import type { Draft } from 'immer';
import { layerMatrix, applyMatrix } from '../../render/transform.ts';
import { evaluate } from '../../keyframes.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import type { Clip, Transform } from '../../schema/sequence.ts';
import { createTrack } from '../../factories.ts';
import type { DClip, DSeq, DTrack, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, findTrackIn, reidentifyClipChildren } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { MAX_SPLIT_CLIPS } from '../schemas/image-split.ts';
import { clone, type HandlerMap } from './util.ts';

const isFree = (seq: DSeq, trackId: string, start: number, end: number, except: string) =>
	!Object.values(seq.clips).some(
		(c) => c.id !== except && c.trackId === trackId && c.start < end && c.start + c.duration > start,
	);

/** A free unlocked video track above `from`, or a new one on top. */
function trackAbove(seq: DSeq, from: number, start: number, end: number, except: string, h: HandlerContext): DTrack {
	for (let i = from + 1; i < seq.videoTracks.length; i++) {
		const t = seq.videoTracks[i]!;
		if (!t.locked && isFree(seq, t.id, start, end, except)) return t;
	}
	const t = createTrack(h.ids, 'video') as DTrack;
	seq.videoTracks.push(t);
	return t;
}

function animated(t: Transform): boolean {
	return (
		t.position.keyframes.length > 0 ||
		t.anchor.keyframes.length > 0 ||
		t.scale.keyframes.length > 0 ||
		t.scaleWidth.keyframes.length > 0 ||
		t.rotation.keyframes.length > 0
	);
}

export const imageSplitHandlers = {
	'clip.splitImage': (doc, cmd: CommandOf<'clip.splitImage'>, h: HandlerContext) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		if (clip.kind !== 'still') return h.fail('E_INVALID_PARAM', 'Only a still image can be split into parts');
		if (cmd.parts.length > MAX_SPLIT_CLIPS)
			h.fail('E_LIMIT', `A split makes at most ${MAX_SPLIT_CLIPS} parts; this one has ${cmd.parts.length}`);
		const src = clip as Draft<Extract<Clip, { kind: 'still' }>>;
		const found = findTrackIn(seq, src.trackId);
		if (!found) return h.fail('E_NOT_FOUND', `Track not found: ${src.trackId}`);
		assertUnlocked(found.track, h);
		// A mask or a tracker is drawn in the whole picture's coordinates: each part would need its own, so ask first.
		if ((src as { masks?: unknown[] }).masks?.length)
			h.fail('E_INVALID_PARAM', 'Remove the masks of this clip before splitting it: they are shaped to the whole picture');
		if ((src as { trackers?: unknown[] }).trackers?.length)
			h.fail('E_INVALID_PARAM', 'Remove the trackers of this clip before splitting it');
		const box = intrinsicBoxOf({ doc: doc as never, seq: seq as never, clip: src as Clip });
		for (const p of cmd.parts) {
			if (!doc.media[p.mediaId]) h.fail('E_NOT_FOUND', `Media not found: ${p.mediaId}`);
			if (doc.media[p.mediaId]!.kind !== 'image') h.fail('E_INVALID_PARAM', `${p.mediaId} is not an image`);
			if (p.box.x + p.box.w > box.width || p.box.y + p.box.h > box.height)
				h.fail('E_INVALID_PARAM', `Part box ${p.box.x},${p.box.y} ${p.box.w}×${p.box.h} is outside the picture`);
		}
		const original = clone(src) as unknown as Extract<Clip, { kind: 'still' }>;
		const end = src.start + src.duration;
		const moves = !animated(original.transform);
		const values = {
			position: evaluate(original.transform.position, 0),
			anchor: evaluate(original.transform.anchor, 0),
			scale: evaluate(original.transform.scale, 0),
			scaleWidth: evaluate(original.transform.scaleWidth, 0),
			uniformScale: original.transform.uniformScale,
			rotation: evaluate(original.transform.rotation, 0),
			flipH: original.transform.flipH,
			flipV: original.transform.flipV,
		};
		const matrix = layerMatrix(values);
		delete seq.clips[src.id];
		const ids: string[] = [];
		let index = found.index;
		cmd.parts.forEach((part, i) => {
			const t: DTrack = i === 0 ? found.track : trackAbove(seq, index, original.start, end, src.id, h);
			index = seq.videoTracks.findIndex((x) => x.id === t.id);
			const id = i === 0 ? original.id : h.ids.next('clp');
			const copy = clone(original) as Extract<Clip, { kind: 'still' }>;
			copy.id = id;
			copy.trackId = t.id;
			copy.mediaId = part.mediaId;
			copy.name = part.name ?? `${original.name} ${i + 1}`;
			copy.groupId = null;
			copy.linkId = null;
			if (i > 0) reidentifyClipChildren(copy as Clip, h, { clipId: original.id });
			const tr = copy.transform;
			if (moves) {
				const centre: [number, number] = [part.box.x + part.box.w / 2, part.box.y + part.box.h / 2];
				tr.position.value = applyMatrix(matrix, centre) as typeof tr.position.value;
				tr.anchor.value = [part.box.w / 2, part.box.h / 2];
			} else {
				const a = tr.anchor;
				a.value = [a.value[0] - part.box.x, a.value[1] - part.box.y];
				a.keyframes = a.keyframes.map((k) => ({ ...k, value: [k.value[0] - part.box.x, k.value[1] - part.box.y] }));
			}
			seq.clips[id] = copy as unknown as DClip;
			ids.push(id);
		});
		const group = h.ids.next('grp');
		seq.groups[group] = { id: group, members: ids };
		for (const id of ids) seq.clips[id]!.groupId = group;
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, group);
		return { clipIds: ids, groupId: group };
	},
} satisfies HandlerMap;
