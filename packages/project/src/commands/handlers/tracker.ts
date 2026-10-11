// Trackers live on the plate (video) clip in media pixels and content time; `apply` bakes them into ordinary
// keyframes of the target (a `jasper.corner-pin` effect or Motion), so manual correction = keyframe editing.
import type { Draft } from 'immer';
import type { SimplifyReport } from '../../animation/simplify-doc.ts';
import { EASE_PRESETS } from '../../keyframes.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import { isConvexQuad, type Quad } from '../../render/homography.ts';
import { CORNER_PIN_EFFECT_ID, CORNER_PIN_PARAMS } from '../../render/scene.ts';
import type { Animatable, Keyframe, Vec2 } from '../../schema/common.ts';
import type {
	Clip,
	ClipTracker,
	EffectInstance,
	TrackerSamples,
	Transform,
	VideoClip,
} from '../../schema/sequence.ts';
import type { Rational } from '../../time.ts';
import { isRemapped } from '../../time-remap/model.ts';
import { computeTrackingApply, type TransformKey, trackLayerOf } from '../../tracking/apply.ts';
import {
	mergeSamples,
	reanchorSamples,
	sampleCount,
	strideOf,
	trackerGeometryAt,
} from '../../tracking/samples.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { effectHandlers } from './effect.ts';
import { clipAnimatables } from './keyframe.ts';
import { simplifyLocations, trackedLocations } from './simplify.ts';
import type { HandlerMap } from './util.ts';

type DTracker = Draft<ClipTracker>;
type DAnim = Draft<Animatable<unknown>>;

function locate(
	doc: DDoc,
	trackerId: string,
	h: HandlerContext,
): { seq: DSeq; clip: DClip; tracker: DTracker } {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips)) {
			const tracker = (clip as { trackers?: DTracker[] }).trackers?.find((t) => t.id === trackerId);
			if (tracker) return { seq, clip, tracker };
		}
	return h.fail('E_NOT_FOUND', `Tracker not found: ${trackerId}`);
}

function assertClipUnlocked(seq: DSeq, clip: DClip, h: HandlerContext): void {
	const t = findTrackIn(seq, clip.trackId);
	if (t) assertUnlocked(t.track, h);
}

function checkQuad(corners: readonly Vec2[], h: HandlerContext): Vec2[] {
	const q = corners.map((p) => [p[0], p[1]] as Vec2);
	if (!isConvexQuad(q as Quad))
		h.fail('E_INVALID_PARAM', 'Tracker corners must form a convex quad in the order TL, TR, BR, BL');
	return q;
}

function defaultPatch(box: { width: number; height: number }): number {
	return Math.max(12, Math.round(Math.min(box.width, box.height) * 0.04));
}

/** Replaces the keyframes of `anim` whose time lies in `[t0, t1]` by `keys` (linear); keeps the others. */
function writeKeys(
	anim: DAnim,
	keys: { time: number; value: unknown }[],
	t0: number,
	t1: number,
	h: HandlerContext,
) {
	const kept = anim.keyframes.filter((k) => k.time < t0 || k.time > t1);
	const added = keys.map(
		(k) =>
			({
				id: h.ids.next('kf'),
				time: k.time,
				value: k.value,
				interpolation: 'linear',
				easeIn: { ...EASE_PRESETS.linear },
				easeOut: { ...EASE_PRESETS.linear },
			}) as Keyframe<unknown>,
	);
	anim.keyframes = [...kept, ...added].sort((a, b) => a.time - b.time) as never;
}

function round6(v: number): number {
	const r = Math.round(v * 1e6) / 1e6;
	return Object.is(r, -0) ? 0 : r;
}

function validateSamples(s: TrackerSamples, kind: ClipTracker['kind'], h: HandlerContext): void {
	if (s.stride !== strideOf(kind))
		h.fail(
			'E_INVALID_PARAM',
			`A ${kind} tracker takes samples with stride ${strideOf(kind)}, got ${s.stride}`,
		);
	const n = sampleCount(s);
	if (n === 0 || s.data.length !== n * s.stride)
		h.fail('E_INVALID_PARAM', 'samples.data must hold a whole number of samples (at least one)');
	if (s.confidence.length !== n)
		h.fail('E_INVALID_PARAM', 'samples.confidence must have one value per sample');
	if (!s.data.every(Number.isFinite)) h.fail('E_INVALID_PARAM', 'samples.data must be finite numbers');
}

export const trackerHandlers = {
	'tracker.add': (doc, cmd: CommandOf<'tracker.add'>, h) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		if (clip.kind !== 'video')
			h.fail('E_INVALID_PARAM', `Trackers go on video clips, not ${clip.kind} clips`, { path: [clip.id] });
		// Workstream `time`: tracker samples live in content time, which a time remap no longer maps to the picture.
		if (isRemapped(clip as Clip))
			h.fail(
				'E_INVALID_PARAM',
				`Clip ${clip.id} is time-remapped: track it before remapping (Remove Time Remapping, track, then remap)`,
				{ path: [clip.id] },
			);
		assertClipUnlocked(seq, clip, h);
		const box = intrinsicBoxOf({ doc, seq, clip });
		const time = h.clipContentTime(seq, clip, cmd.at);
		const v = clip as Draft<VideoClip>;
		v.trackers ??= [];
		const count = v.trackers.filter((t) => t.kind === cmd.kind).length;
		const patch = cmd.patch ?? (cmd.kind === 'point' ? defaultPatch(box) : undefined);
		const reference: DTracker['reference'] = { time };
		if (cmd.kind === 'planar') {
			if (cmd.point) h.fail('E_INVALID_PARAM', 'A planar tracker takes corners, not a point');
			const w = box.width;
			const hh = box.height;
			reference.corners = cmd.corners
				? checkQuad(cmd.corners, h)
				: [
						[w * 0.3, hh * 0.3],
						[w * 0.7, hh * 0.3],
						[w * 0.7, hh * 0.7],
						[w * 0.3, hh * 0.7],
					];
		} else {
			if (cmd.corners) h.fail('E_INVALID_PARAM', 'A point tracker takes a point, not corners');
			reference.point = cmd.point ? [cmd.point[0], cmd.point[1]] : [box.width / 2, box.height / 2];
			reference.patch = patch!;
			reference.search = cmd.search ?? Math.round(patch! * 3);
		}
		if (cmd.kind === 'planar' && cmd.search !== undefined) reference.search = cmd.search;
		if (cmd.kind === 'planar' && cmd.patch !== undefined) reference.patch = cmd.patch;
		const id = h.ids.next('tkr');
		const tracker: ClipTracker = {
			id,
			name: cmd.name ?? `${cmd.kind === 'planar' ? 'Planar' : 'Point'} Tracker ${count + 1}`,
			kind: cmd.kind,
			reference,
			samples: null,
			method: cmd.kind === 'planar' ? 'klt-homography@1' : 'template@1',
		};
		v.trackers.push(tracker as DTracker);
		h.defineRef(cmd.ref, id);
		return { trackerId: id, clipId: clip.id, reference: tracker.reference };
	},

	'tracker.update': (doc, cmd: CommandOf<'tracker.update'>, h) => {
		const { seq, clip, tracker } = locate(doc, cmd.trackerId, h);
		assertClipUnlocked(seq, clip, h);
		if (cmd.name !== undefined) tracker.name = cmd.name;
		if (cmd.smoothing !== undefined) tracker.smoothing = cmd.smoothing;
		if (cmd.patch !== undefined) tracker.reference.patch = cmd.patch;
		if (cmd.search !== undefined) tracker.reference.search = cmd.search;
		const moved = cmd.at !== undefined || cmd.corners !== undefined || cmd.point !== undefined;
		if (!moved) return { trackerId: tracker.id };
		if (tracker.kind === 'planar' && cmd.point) h.fail('E_INVALID_PARAM', 'A planar tracker takes corners');
		if (tracker.kind === 'point' && cmd.corners) h.fail('E_INVALID_PARAM', 'A point tracker takes a point');
		const time = cmd.at !== undefined ? h.clipContentTime(seq, clip, cmd.at) : tracker.reference.time;
		const corners = cmd.corners ? checkQuad(cmd.corners, h) : undefined;
		const point: Vec2 | undefined = cmd.point ? [cmd.point[0], cmd.point[1]] : undefined;
		// With samples, the correction re-anchors the whole track through the tracked plane motion (the corrected
		// geometry at `time` maps to every sample), so moving the reference never needs a re-track.
		if (tracker.samples && (corners || point)) {
			tracker.samples = reanchorSamples(tracker.samples as TrackerSamples, time, {
				...(corners ? { corners: corners as Quad } : {}),
				...(point ? { point } : {}),
			}) as never;
		}
		tracker.reference.time = time;
		if (corners) tracker.reference.corners = corners;
		if (point) tracker.reference.point = point;
		if (!corners && !point && tracker.samples) {
			// Only the time moved: the reference geometry becomes the track at that time.
			const g = trackerGeometryAt(tracker as ClipTracker, time, { smoothing: 0 });
			if (g.corners) tracker.reference.corners = g.corners;
			if (g.point) tracker.reference.point = g.point;
		}
		return { trackerId: tracker.id, reference: JSON.parse(JSON.stringify(tracker.reference)) };
	},

	'tracker.remove': (doc, cmd: CommandOf<'tracker.remove'>, h) => {
		const removed: string[] = [];
		for (const id of new Set(cmd.trackerIds)) {
			const { seq, clip } = locate(doc, id, h);
			assertClipUnlocked(seq, clip, h);
			const v = clip as Draft<VideoClip>;
			v.trackers = (v.trackers ?? []).filter((t) => t.id !== id);
			if (v.trackers.length === 0) delete v.trackers;
			removed.push(id);
		}
		// Targets keep their keyframes; only the (informational) link goes (S09:TRK-005).
		for (const seq of Object.values(doc.sequences))
			for (const c of Object.values(seq.clips)) {
				const tb = (c as { trackedBy?: { trackerId: string } }).trackedBy;
				if (tb && removed.includes(tb.trackerId)) delete (c as { trackedBy?: unknown }).trackedBy;
			}
		return { trackerIds: removed };
	},

	'tracker.unlink': (doc, cmd: CommandOf<'tracker.unlink'>, h) => {
		const unlinked: string[] = [];
		for (const id of new Set(cmd.clipIds)) {
			const { seq, clip } = h.clip(doc, id);
			assertClipUnlocked(seq, clip, h);
			const c = clip as { trackedBy?: unknown };
			if (c.trackedBy === undefined) continue;
			delete c.trackedBy;
			unlinked.push(id);
		}
		return { clipIds: unlinked };
	},

	'tracker.setSamples': (doc, cmd: CommandOf<'tracker.setSamples'>, h) => {
		const { seq, clip, tracker } = locate(doc, cmd.trackerId, h);
		assertClipUnlocked(seq, clip, h);
		const s = cmd.samples as TrackerSamples;
		validateSamples(s, tracker.kind, h);
		tracker.samples = mergeSamples(
			(tracker.samples as TrackerSamples | null) ?? null,
			s,
			cmd.merge ?? 'replace',
		) as never;
		tracker.method = cmd.method;
		const merged = tracker.samples as TrackerSamples;
		return { trackerId: tracker.id, start: merged.start, count: sampleCount(merged) };
	},

	'tracker.apply': (doc, cmd: CommandOf<'tracker.apply'>, h) => {
		const { seq: pseq, clip: plate, tracker } = locate(doc, cmd.trackerId, h);
		const { seq, clip: target } = h.clip(doc, cmd.targetClipId);
		if (seq.id !== pseq.id) h.fail('E_INVALID_PARAM', 'The target must be in the plate clip’s sequence');
		if (target.id === plate.id) h.fail('E_INVALID_PARAM', 'A clip cannot follow its own tracker');
		assertClipUnlocked(seq, target, h);
		const tl = trackLayerOf(doc, seq, target);
		if (!tl.transform) h.fail('E_INVALID_PARAM', `${target.kind} clips have no Motion to drive`);
		const fps = seq.settings.frameRate as Rational;
		const overlap = {
			start: Math.max(plate.start, target.start),
			end: Math.min(plate.start + plate.duration, target.start + target.duration),
		};
		const range = cmd.range
			? {
					start: Math.max(cmd.range.start, target.start),
					end: Math.min(cmd.range.end, target.start + target.duration),
				}
			: overlap;
		if (!(range.end > range.start))
			h.fail('E_INVALID_PARAM', 'The plate and the target do not overlap in the given range');
		const effects = (target as { effects?: Draft<EffectInstance>[] }).effects;
		const existingPin = effects?.find((e) => e.effectId === CORNER_PIN_EFFECT_ID);
		let result: ReturnType<typeof computeTrackingApply>;
		try {
			result = computeTrackingApply({
				fps,
				plate: trackLayerOf(doc, seq, plate),
				target: tl,
				tracker: tracker as ClipTracker,
				mode: cmd.mode,
				...(cmd.components ? { components: cmd.components } : {}),
				range,
			});
		} catch (e) {
			return h.fail('E_INVALID_PARAM', (e as Error).message);
		}
		for (const w of result.warnings) h.warn('W_TRACKING', w, [target.id]);
		const [t0, t1] = result.timeRange;
		let effectInstanceId: string | undefined;
		if (result.mode === 'corner-pin') {
			let pin = existingPin;
			if (!pin) {
				const r = effectHandlers['effect.add']!(
					doc,
					{ type: 'effect.add', effectId: CORNER_PIN_EFFECT_ID, target: { clipId: target.id }, index: 0 },
					h,
				) as { effectInstanceId: string };
				pin = (target as { effects: Draft<EffectInstance>[] }).effects.find(
					(e) => e.id === r.effectInstanceId,
				)!;
			}
			effectInstanceId = pin.id;
			CORNER_PIN_PARAMS.forEach((name, i) => {
				const anim = pin!.params[name] as DAnim;
				writeKeys(
					anim,
					result.keys.map((k) => ({
						time: k.time,
						value: [k.corners[i]![0], k.corners[i]![1]],
					})),
					t0,
					t1,
					h,
				);
			});
		} else {
			const tr = (target as unknown as { transform: Draft<Transform> }).transform;
			const tkeys = result.keys;
			const write = (anim: DAnim, pick: (k: TransformKey) => unknown) => {
				const keys = tkeys
					.map((k) => ({ time: k.time, value: pick(k) }))
					.filter((k) => k.value !== undefined);
				if (keys.length) writeKeys(anim, keys, t0, t1, h);
			};
			write(tr.position as DAnim, (k) =>
				k.position ? [round6(k.position[0]), round6(k.position[1])] : undefined,
			);
			write(tr.scale as DAnim, (k) => (k.scale !== undefined ? round6(k.scale) : undefined));
			if (!tr.uniformScale)
				write(tr.scaleWidth as DAnim, (k) => (k.scaleWidth !== undefined ? round6(k.scaleWidth) : undefined));
			write(tr.rotation as DAnim, (k) => (k.rotation !== undefined ? round6(k.rotation) : undefined));
		}
		(target as { trackedBy?: unknown }).trackedBy = {
			clipId: plate.id,
			trackerId: tracker.id,
			mode: cmd.mode,
			...(effectInstanceId ? { effectInstanceId } : {}),
			...(cmd.simplify ? { simplify: { tolerance: cmd.simplify.tolerance } } : {}),
		};
		// Simplification must not change keys outside the newly baked range.
		let simplified: SimplifyReport | undefined;
		if (cmd.simplify) {
			// Only the parameters this apply wrote (transform mode may drive a subset of Motion).
			const wrote = new Set<string>();
			if (result.mode === 'transform') {
				const k = result.keys;
				if (k.some((x) => x.position)) wrote.add('transform.position');
				if (k.some((x) => x.scale !== undefined)) wrote.add('transform.scale').add('transform.scaleWidth');
				if (k.some((x) => x.rotation !== undefined)) wrote.add('transform.rotation');
			}
			const written = trackedLocations(clipAnimatables(seq, target), target)
				.filter((loc) => result.mode === 'corner-pin' || wrote.has(loc.path.slice(2).join('.')))
				.map((loc) => ({
					loc,
					selected: new Set(loc.anim.keyframes.filter((k) => k.time >= t0 && k.time <= t1).map((k) => k.id)),
				}));
			simplified = simplifyLocations(doc, written, cmd.simplify.tolerance, h);
		}
		return {
			targetClipId: target.id,
			mode: cmd.mode,
			frames: result.keys.length,
			range,
			...(effectInstanceId ? { effectInstanceId } : {}),
			...(simplified
				? {
						simplified: {
							before: simplified.before,
							after: simplified.after,
							maxError: simplified.maxError,
							tolerance: simplified.tolerance,
						},
					}
				: {}),
		};
	},
} satisfies HandlerMap;
