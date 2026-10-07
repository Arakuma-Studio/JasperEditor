// Time Remapping, Time Interpolation, frame holds and Scene Edit Detection results (workstream `time`,
// docs/wp-notes/time.md). The curve math lives in time-remap/; these handlers apply it to clips: the out point moves
// with the content after an edit (Premiere: slowing a segment lengthens the clip, speeding it up shortens it), a
// longer clip stops at the next clip unless `ripple` (Premiere: "it will not overwrite an adjacent clip … pushes
// remaining frames into the tail"), and frames beyond the media are never shown.
import type { Draft } from 'immer';
import { contentTimeAt } from '../../derive/index.ts';
import { contentDurationFlicks } from '../../registry/kinds.ts';
import type {
	Clip,
	ClipMarker,
	NestVideoClip,
	RemapKeyframe,
	TimeRemap,
	VideoClip,
} from '../../schema/sequence.ts';
import { contentSpanFlicks, FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../time.ts';
import { remapFitDuration, remapFramesInMedia } from '../../time-remap/bounds.ts';
import { clipMediaTimeFn, REMAPPABLE_KINDS } from '../../time-remap/model.ts';
import {
	addKeyframe,
	clampRamps,
	insertHold,
	insertReverse,
	moveKeyframe,
	newRemap,
	type RemapEdit,
	RemapEditError,
	removeKeyframes,
	setRamp,
	setSegmentSpeed,
} from '../../time-remap/ops.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import {
	assertUnlocked,
	cleanupSequence,
	end,
	findTrackIn,
	relinkSplits,
	type SplitRecord,
	splitClipAt,
} from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { nextStart, rippleAfterEnd } from './clip-edit.ts';
import { insertItem } from './project.ts';
import { type HandlerMap, idList } from './util.ts';

type DVideo = Draft<VideoClip | NestVideoClip>;

function rateOf(seq: DSeq): Rational {
	return seq.settings.frameRate as Rational;
}

function stepOf(seq: DSeq, c: { speed: { rate: number } }): number {
	return flicksPerFrame(rateOf(seq)) * c.speed.rate;
}

/** A video clip on an unlocked track that may carry a remap. */
function remappable(seq: DSeq, clip: DClip, h: HandlerContext): DVideo {
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	if (!REMAPPABLE_KINDS.has(clip.kind))
		h.fail(
			'E_INVALID_PARAM',
			`Time Remapping applies to video and nested sequence clips; ${clip.id} is a ${clip.kind} clip`,
			{
				blocking: [clip.id],
			},
		);
	if (clip.speed.reverse)
		h.fail(
			'E_INVALID_PARAM',
			`Clip ${clip.id} plays in reverse (Speed/Duration ▸ Reverse Speed); turn that off and use a reverse segment instead`,
			{ blocking: [clip.id] },
		);
	if (!(clip as DVideo).timeRemap?.enabled && ((clip as { trackers?: unknown[] }).trackers?.length ?? 0) > 0)
		h.fail(
			'E_INVALID_PARAM',
			`Clip ${clip.id} has trackers, whose samples follow its content time: nest the clip to time-remap it`,
			{ blocking: [clip.id] },
		);
	return clip as DVideo;
}

/** The clip's remap, created (identity) when absent or disabled. */
function remapOf(clip: DVideo): TimeRemap {
	const r = clip.timeRemap;
	return r?.enabled ? (r as TimeRemap) : newRemap();
}

function mediaDurationOf(doc: DDoc, clip: DClip): number | null {
	return contentDurationFlicks(doc, clip as Clip);
}

function failEdit(e: unknown, h: HandlerContext): never {
	if (e instanceof RemapEditError) h.fail('E_INVALID_PARAM', e.message);
	throw e;
}

/**
 * Stores an edited remap on a clip and moves its out point with the content (`edit.shift`), fitted to the media and
 * — unless `ripple` — to the next clip on the track.
 */
function commitEdit(
	doc: DDoc,
	seq: DSeq,
	clip: DVideo,
	edit: RemapEdit,
	h: HandlerContext,
	opts: { ripple?: boolean; edited?: Set<string>; rippled?: Set<string> } = {},
): { duration: number } {
	const rate = rateOf(seq);
	const step = stepOf(seq, clip);
	const c0 = clip.sourceIn;
	const c1 = c0 + clip.duration * step;
	clampRamps(edit.remap);
	clip.timeRemap = edit.remap as DVideo['timeRemap'];
	const dur = mediaDurationOf(doc, clip);
	let want = Math.max(1, Math.round((edit.shift(c1) - c0) / step));
	const plain = clip as unknown as VideoClip;
	if (!remapFramesInMedia(plain, clip.start, clip.start, rate, dur))
		h.fail('E_OUT_OF_MEDIA', `Clip ${clip.id} would show frames outside its media`, { blocking: [clip.id] });
	const fit = remapFitDuration(plain, want, rate, dur);
	if (fit < want) {
		h.warn(
			'W_DURATION_CLAMPED',
			`Clip ${clip.id} ends where its media ends (${want - fit} frame(s) would show no media)`,
		);
		want = fit;
	}
	const oldEnd = end(clip);
	if (!opts.ripple && want > clip.duration) {
		const n = nextStart(seq, clip.trackId, oldEnd, new Set([clip.id]));
		if (clip.start + want > n) {
			h.warn(
				'W_DURATION_CLAMPED',
				`Clip ${clip.id} stops at the next clip; the remaining frames are in its tail (trim its out point to reveal them)`,
			);
			want = Math.max(1, n - clip.start);
		}
	}
	clip.duration = want;
	if (opts.ripple)
		rippleAfterEnd(
			seq,
			h,
			clip as DClip,
			oldEnd,
			end(clip) - oldEnd,
			opts.edited ?? new Set([clip.trackId]),
			opts.rippled ?? new Set(),
		);
	return { duration: want };
}

/** Content time of a sequence frame inside a clip (frames outside are refused). */
function contentAt(seq: DSeq, clip: DClip, at: number, h: HandlerContext, inclusiveEnd = false): number {
	if (at < clip.start || at > end(clip) - (inclusiveEnd ? 0 : 1))
		h.fail('E_INVALID_PARAM', `Frame ${at} is not inside clip ${clip.id}`, { blocking: [clip.id] });
	return contentTimeAt(clip, at, rateOf(seq));
}

function linkedAudioOf(seq: DSeq, clip: DClip): DClip[] {
	if (!clip.linkId || !seq.links[clip.linkId]) return [];
	return seq.links[clip.linkId]!.members.map((id) => seq.clips[id]).filter(
		(c): c is DClip => !!c && c.id !== clip.id && c.kind === 'audio',
	);
}

const newKeyId = (h: HandlerContext) => () => h.ids.next('kf');

// ---------------------------------------------------------------- enable / disable

function enableHandler(doc: DDoc, cmd: CommandOf<'timeRemap.enable'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const out: { clipId: string; enabled: boolean; duration: number }[] = [];
	for (const c of clips) {
		if (cmd.enabled) {
			const v = remappable(seq, c, h);
			if (!v.timeRemap?.enabled) v.timeRemap = newRemap() as DVideo['timeRemap'];
			const audio = linkedAudioOf(seq, c);
			const policy = cmd.linkedAudio ?? 'keep';
			if (audio.length > 0) {
				if (policy === 'keep')
					h.warn(
						'W_AUDIO_NOT_REMAPPED',
						`The linked audio of ${c.id} keeps playing at 100 % and is not time-remapped (Premiere): it will not stay in sync with a remapped picture`,
					);
				else if (policy === 'mute') for (const a of audio) a.enabled = false;
				else {
					const id = c.linkId!;
					for (const m of seq.links[id]?.members ?? []) if (seq.clips[m]) seq.clips[m]!.linkId = null;
					delete seq.links[id];
				}
			}
			out.push({ clipId: c.id, enabled: true, duration: c.duration });
		} else {
			if (!REMAPPABLE_KINDS.has(c.kind)) continue;
			assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
			const v = c as DVideo;
			if (!v.timeRemap) {
				out.push({ clipId: c.id, enabled: false, duration: c.duration });
				continue;
			}
			delete v.timeRemap;
			// Back to linear playback: the clip may now run past its media (it was slowed down) — trim it there.
			const dur = mediaDurationOf(doc, c);
			if (dur !== null) {
				const step = stepOf(seq, c);
				const max = Math.max(1, Math.floor((dur - c.sourceIn) / step + 1e-3));
				if (c.duration > max) {
					h.warn('W_DURATION_CLAMPED', `Clip ${c.id} trimmed to the end of its media`);
					c.duration = max;
				}
			}
			out.push({ clipId: c.id, enabled: false, duration: c.duration });
		}
	}
	cleanupSequence(seq, h);
	return { clips: out };
}

// ---------------------------------------------------------------- keyframes and segments

function addKeyframeHandler(doc: DDoc, cmd: CommandOf<'timeRemap.addKeyframe'>, h: HandlerContext): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const v = remappable(seq, clip, h);
	const c = contentAt(seq, clip, h.frame(seq, cmd.at), h, true);
	try {
		const e = addKeyframe(remapOf(v), c, newKeyId(h));
		commitEdit(doc, seq, v, e, h);
		return { keyframeId: e.keyId };
	} catch (err) {
		failEdit(err, h);
	}
}

function keyOf(clip: DVideo, id: string, h: HandlerContext): RemapKeyframe {
	const k = clip.timeRemap?.enabled ? clip.timeRemap.keyframes.find((x) => x.id === id) : undefined;
	if (!k) return h.fail('E_NOT_FOUND', `Speed keyframe not found on clip ${clip.id}: ${id}`);
	return k as RemapKeyframe;
}

function removeKeyframesHandler(
	doc: DDoc,
	cmd: CommandOf<'timeRemap.removeKeyframes'>,
	h: HandlerContext,
): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const v = remappable(seq, clip, h);
	for (const id of cmd.keyframeIds) keyOf(v, id, h);
	commitEdit(doc, seq, v, removeKeyframes(remapOf(v), cmd.keyframeIds), h);
	return { removed: cmd.keyframeIds };
}

function setSpeedHandler(doc: DDoc, cmd: CommandOf<'timeRemap.setSpeed'>, h: HandlerContext): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const v = remappable(seq, clip, h);
	const c = contentAt(seq, clip, h.frame(seq, cmd.at), h);
	const step = stepOf(seq, v);
	const slope = cmd.speedPercent / 100 / v.speed.rate;
	try {
		const e = setSegmentSpeed(
			remapOf(v),
			c,
			slope,
			{ c0: v.sourceIn, c1: v.sourceIn + v.duration * step },
			newKeyId(h),
		);
		const r = commitEdit(doc, seq, v, e, h, { ripple: cmd.ripple ?? false });
		cleanupSequence(seq, h);
		return { duration: r.duration, created: e.created };
	} catch (err) {
		failEdit(err, h);
	}
}

function moveKeyframeHandler(
	doc: DDoc,
	cmd: CommandOf<'timeRemap.moveKeyframe'>,
	h: HandlerContext,
): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const v = remappable(seq, clip, h);
	keyOf(v, cmd.keyframeId, h);
	const c = contentTimeAt(v, h.frame(seq, cmd.to), rateOf(seq));
	try {
		const e = moveKeyframe(remapOf(v), cmd.keyframeId, c);
		const r = commitEdit(doc, seq, v, e, h, { ripple: cmd.ripple ?? false });
		cleanupSequence(seq, h);
		const k = (v.timeRemap as TimeRemap).keyframes.find((x) => x.id === cmd.keyframeId)!;
		if (Math.abs(k.time - c) > 1)
			h.warn('W_VALUE_CLAMPED', 'The keyframe stopped where a segment would turn around');
		return { duration: r.duration };
	} catch (err) {
		failEdit(err, h);
	}
}

function setTransitionHandler(
	doc: DDoc,
	cmd: CommandOf<'timeRemap.setTransition'>,
	h: HandlerContext,
): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const v = remappable(seq, clip, h);
	keyOf(v, cmd.keyframeId, h);
	const half = (cmd.frames / 2) * stepOf(seq, v);
	const e = setRamp(remapOf(v), cmd.keyframeId, half, cmd.ease);
	commitEdit(doc, seq, v, e, h);
	const k = (v.timeRemap as TimeRemap).keyframes.find((x) => x.id === cmd.keyframeId)!;
	const got = ((k.ramp ?? 0) * 2) / stepOf(seq, v);
	if (got + 1e-6 < cmd.frames)
		h.warn(
			'W_VALUE_CLAMPED',
			`Speed transition limited to ${Math.round(got * 100) / 100} frames by its neighbours`,
		);
	return { frames: got };
}

function addFreezeHandler(doc: DDoc, cmd: CommandOf<'timeRemap.addFreeze'>, h: HandlerContext): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const v = remappable(seq, clip, h);
	const c = contentAt(seq, clip, h.frame(seq, cmd.at), h);
	const frames = h.durationFrames(seq, cmd.duration);
	if (frames < 1) h.fail('E_INVALID_PARAM', 'A freeze frame lasts at least 1 frame');
	try {
		const e = insertHold(remapOf(v), c, frames * stepOf(seq, v), newKeyId(h));
		const r = commitEdit(doc, seq, v, e, h, { ripple: cmd.ripple ?? false });
		cleanupSequence(seq, h);
		return { keyframeIds: e.created, duration: r.duration };
	} catch (err) {
		failEdit(err, h);
	}
}

function addReverseHandler(doc: DDoc, cmd: CommandOf<'timeRemap.addReverse'>, h: HandlerContext): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const v = remappable(seq, clip, h);
	const c = contentAt(seq, clip, h.frame(seq, cmd.at), h);
	const frames = h.durationFrames(seq, cmd.duration);
	if (frames < 1) h.fail('E_INVALID_PARAM', 'A reverse segment lasts at least 1 frame');
	const slope = (cmd.speedPercent ?? 100) / 100 / v.speed.rate;
	try {
		const e = insertReverse(remapOf(v), c, frames * stepOf(seq, v), slope, newKeyId(h));
		const r = commitEdit(doc, seq, v, e, h, { ripple: cmd.ripple ?? false });
		cleanupSequence(seq, h);
		return { keyframeIds: e.created, duration: r.duration };
	} catch (err) {
		failEdit(err, h);
	}
}

// ---------------------------------------------------------------- time interpolation

function setTimeInterpolationHandler(
	doc: DDoc,
	cmd: CommandOf<'clip.setTimeInterpolation'>,
	h: HandlerContext,
): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const changed: string[] = [];
	for (const c of clips) {
		if (c.kind !== 'video') {
			h.warn(
				'W_VALUE_CLAMPED',
				`Time Interpolation applies to video clips (nested sequences use Frame Sampling); ${c.id} is a ${c.kind} clip`,
			);
			continue;
		}
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		const v = c as DVideo;
		if (cmd.mode === 'frame-sampling') delete v.timeInterpolation;
		else v.timeInterpolation = cmd.mode;
		changed.push(c.id);
	}
	return { clipIds: changed };
}

// ---------------------------------------------------------------- scene edit detection results

function applySceneEditsHandler(
	doc: DDoc,
	cmd: CommandOf<'clip.applySceneEdits'>,
	h: HandlerContext,
): unknown {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	if (!cmd.applyCuts && !cmd.createSubclips && !cmd.createMarkers)
		h.fail('E_INVALID_PARAM', 'Choose at least one of applyCuts, createSubclips, createMarkers');
	const mediaId = (clip as { mediaId?: string }).mediaId;
	if (!mediaId || clip.kind !== 'video')
		h.fail(
			'E_INVALID_PARAM',
			`Scene Edit Detection applies to video clips; ${clip.id} is a ${clip.kind} clip`,
		);
	const rate = rateOf(seq);
	const cuts = [...new Set(cmd.cuts)].sort((a, b) => a - b);
	const mediaAt = clipMediaTimeFn(clip as unknown as VideoClip, rate);
	const shotOf = (m: number) => {
		let k = 0;
		for (const c of cuts) if (c <= m + 1) k++;
		return k;
	};
	// Sequence frames where the shot changes (the first frame of a new shot).
	const edits: number[] = [];
	let prev = shotOf(mediaAt(clip.start));
	for (let f = clip.start + 1; f < end(clip); f++) {
		const s = shotOf(mediaAt(f));
		if (s !== prev) edits.push(f);
		prev = s;
	}
	const result: { cuts: number[]; subclips: string[]; markers: number; binId?: string } = {
		cuts: [],
		subclips: [],
		markers: 0,
	};
	const step = stepOf(seq, clip);
	if (cmd.createMarkers) {
		// Clip markers live in content time: the cut's first frame on this clip.
		for (const f of edits) {
			const flicks = Math.max(0, Math.round(contentTimeAt(clip, f, rate)));
			if (clip.markers.some((m) => Math.abs(m.flicks - flicks) < step / 2)) continue;
			const marker: ClipMarker = {
				id: h.ids.next('mrk'),
				flicks,
				duration: 0,
				name: 'Scene Edit',
				comment: '',
				color: 'green',
				type: 'comment',
				author: h.agentAuthor(),
			};
			clip.markers.push(marker as Draft<ClipMarker>);
			result.markers++;
		}
		clip.markers.sort((a, b) => a.flicks - b.flicks);
	}
	if (cmd.createSubclips) {
		// One media item per shot the clip shows, marked to the shot's media range, in a new bin.
		const asset = doc.media[mediaId!];
		const item = Object.values(doc.items).find((it) => it.kind === 'media' && it.mediaId === mediaId);
		const base = item?.name ?? asset?.originalName ?? clip.name;
		const binId = h.ids.next('bin');
		doc.items[binId] = {
			id: binId,
			kind: 'bin',
			name: cmd.binName ?? `${base} Scenes`,
			children: [],
			label: 'mango',
		};
		insertItem(doc, binId, null);
		result.binId = binId;
		const lo = Math.min(mediaAt(clip.start), mediaAt(end(clip) - 1));
		const hiFrame = Math.max(mediaAt(clip.start), mediaAt(end(clip) - 1));
		const hi = hiFrame + Math.abs(step);
		const bounds = [lo, ...cuts.filter((c) => c > lo + 1 && c < hi - 1), hi];
		for (let i = 0; i + 1 < bounds.length; i++) {
			const id = h.ids.next('itm');
			doc.items[id] = {
				id,
				kind: 'media',
				name: `${base} Scene ${String(i + 1).padStart(2, '0')}`,
				mediaId: mediaId!,
				label: item?.label ?? 'iris',
				marks: { in: { flicks: Math.round(bounds[i]!) }, out: { flicks: Math.round(bounds[i + 1]!) } },
			};
			insertItem(doc, id, binId);
			result.subclips.push(id);
		}
	}
	if (cmd.applyCuts && edits.length > 0) {
		assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
		// Latest cut first: the left piece keeps the clip's id for the earlier cuts. Linked clips are cut too (Premiere).
		for (const f of [...edits].reverse()) {
			const self = seq.clips[cmd.clipId]!;
			const parts = new Map<string, DClip>([[self.id, self]]);
			for (const id of self.linkId ? (seq.links[self.linkId]?.members ?? []) : []) {
				const p = seq.clips[id];
				if (p && p.start < f && f < end(p) && !findTrackIn(seq, p.trackId)?.track.locked) parts.set(p.id, p);
			}
			const splits: SplitRecord[] = [];
			for (const c of parts.values())
				if (c.start < f && f < end(c))
					splits.push({ originalLinkId: c.linkId, rightId: splitClipAt(seq, c, f, h).id });
			relinkSplits(seq, splits, h);
			result.cuts.push(f);
		}
		result.cuts.reverse();
	}
	cleanupSequence(seq, h);
	return { ...result, edits, seconds: cuts.map((c) => c / FLICKS_PER_SECOND) };
}

export const timeHandlers: HandlerMap = {
	'timeRemap.enable': enableHandler,
	'timeRemap.addKeyframe': addKeyframeHandler,
	'timeRemap.removeKeyframes': removeKeyframesHandler,
	'timeRemap.setSpeed': setSpeedHandler,
	'timeRemap.moveKeyframe': moveKeyframeHandler,
	'timeRemap.setTransition': setTransitionHandler,
	'timeRemap.addFreeze': addFreezeHandler,
	'timeRemap.addReverse': addReverseHandler,
	'clip.setTimeInterpolation': setTimeInterpolationHandler,
	'clip.applySceneEdits': applySceneEditsHandler,
};

/** Content span (flicks) a clip covers — exported for tests of the frame-hold math. */
export function clipContentSpan(seq: DSeq, c: DClip): number {
	return contentSpanFlicks(c.duration, rateOf(seq), c.speed.rate);
}
