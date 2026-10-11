// three-d (docs/wp-notes/three-d.md): the 3D Camera Tracker's commands — apply it to a video clip, settings, commit a
// solve from the engine, delete track points, set the ground plane and origin, create the camera (and a text or solid
// layer on a target), remove it. The solve math is in three-d/camtrack.ts; the analysis is the engine's `camtrack` job.
import type { Draft } from 'immer';
import { contentTimeAt } from '../../derive/index.ts';
import { EASE_PRESETS, evaluate } from '../../keyframes.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import { clipMediaFrames, mediaFrameAt, rotoFrameCount, rotoRateOf } from '../../roto/index.ts';
import type { Keyframe, Vec2, Vec3 } from '../../schema/common.ts';
import type { CameraClip, Clip, VideoClip } from '../../schema/sequence.ts';
import type { CameraSolvePoint, ClipCameraTracker } from '../../schema/three-d.ts';
import {
	cameraTrackerInputs,
	cameraTrackerSettingsOf,
	dirToWorld,
	groundOf,
	layerOrientationFor,
	type SolvedCamera,
	solvedCameraAt,
	solveFrameCount,
	solveMapping,
	targetOf,
	toWorld,
	worldCameraOf,
} from '../../three-d/camtrack.ts';
import { dot3, sub3 } from '../../three-d/math.ts';
import { newLayer3D } from '../../three-d/model.ts';
import type { Rational } from '../../time.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn, trackClips } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { clipCoreHandlers } from './clip-core.ts';
import { threeDHandlers } from './three-d.ts';
import type { HandlerMap } from './util.ts';

type DTracker = Draft<ClipCameraTracker>;

function videoClip(doc: DDoc, h: HandlerContext, clipId: string): { seq: DSeq; clip: Draft<VideoClip> } {
	const { seq, clip } = h.clip(doc, clipId);
	if (clip.kind !== 'video')
		h.fail('E_INVALID_PARAM', `The 3D Camera Tracker works on video clips, not ${clip.kind} clips`, {
			path: [clip.id],
		});
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	return { seq, clip: clip as Draft<VideoClip> };
}

function trackerOf(doc: DDoc, h: HandlerContext, clipId: string) {
	const r = videoClip(doc, h, clipId);
	const t = (r.clip as { cameraTracker?: DTracker }).cameraTracker;
	if (!t) h.fail('E_INVALID_PARAM', `Clip ${clipId} has no 3D Camera Tracker`, { path: [clipId] });
	return { ...r, tracker: t };
}

function checkSpan(span: readonly [number, number], n: number | null, h: HandlerContext): [number, number] {
	const [a, b] = span;
	if (b < a + 1) h.fail('E_INVALID_PARAM', 'The analysed span must hold at least two frames');
	if (n !== null && b > n - 1)
		h.fail('E_INVALID_PARAM', `The span ends after the media's last frame (${n - 1})`);
	return [a, b];
}

type SettingsInput = Omit<CommandOf<'cameraTracker.settings'>, 'type' | 'clipId' | 'span'>;
function applySettings(t: DTracker, o: SettingsInput): void {
	const keys = [
		'shot',
		'hfov',
		'method',
		'detailed',
		'lensDistortion',
		'showPoints',
		'pointSize',
		'targetSize',
	] as const;
	for (const k of keys) if (o[k] !== undefined) (t.settings as Record<string, unknown>)[k] = o[k];
}

function pointsById(t: DTracker, ids: readonly number[], h: HandlerContext): CameraSolvePoint[] {
	const solve = t.solve;
	if (!solve) return h.fail('E_INVALID_PARAM', 'The camera is not solved yet');
	const gone = new Set(t.deleted);
	const out: CameraSolvePoint[] = [];
	for (const id of new Set(ids)) {
		const p = solve.points.find((q) => q.id === id);
		if (!p || gone.has(id)) h.fail('E_INVALID_PARAM', `No track point ${id}`);
		out.push(p as CameraSolvePoint);
	}
	return out;
}

/** The solved camera that sees points best: at `frame`, else the first frame all of them were tracked on. */
function cameraFor(
	t: DTracker,
	pts: CameraSolvePoint[],
	frame: number | undefined,
	h: HandlerContext,
): SolvedCamera {
	const solve = t.solve!;
	const f = frame ?? Math.max(solve.span[0], ...pts.map((p) => p.first));
	const cam = solvedCameraAt(solve, f);
	if (!cam) return h.fail('E_INVALID_PARAM', 'The solve has no camera at that frame');
	return cam;
}

/**
 * Sequence px per media px of the tracked clip's picture. The picture must be drawn centred, unrotated and not
 * animated: the created camera's principal point is the frame centre and its zoom the solved focal length scaled.
 */
function pictureScale(doc: DDoc, seq: DSeq, clip: Draft<VideoClip>, h: HandlerContext): number {
	const tr = clip.transform;
	const animated = [tr.position, tr.anchor, tr.scale, tr.scaleWidth, tr.rotation].some(
		(a) => a.keyframes.length > 0 || a.expression,
	);
	if (animated)
		h.fail(
			'E_INVALID_PARAM',
			'The tracked clip has animated Motion: the solved camera only lines up with a still picture placement',
		);
	const t = clip.sourceIn;
	const rot = evaluate(tr.rotation as never, t) as number;
	const scale = evaluate(tr.scale as never, t) as number;
	const scaleW = tr.uniformScale ? scale : (evaluate(tr.scaleWidth as never, t) as number);
	if (Math.abs(rot) > 1e-6 || tr.flipH || tr.flipV || Math.abs(scale - scaleW) > 1e-6)
		h.fail(
			'E_INVALID_PARAM',
			'The tracked clip is rotated, flipped or scaled unevenly: the solved camera needs the picture drawn as is',
		);
	const box = intrinsicBoxOf({ doc: doc as never, seq: seq as never, clip: clip as never });
	const pos = evaluate(tr.position as never, t) as Vec2;
	const anchor = evaluate(tr.anchor as never, t) as Vec2;
	const k = scale / 100;
	const cx = pos[0] + k * (box.width / 2 - anchor[0]);
	const cy = pos[1] + k * (box.height / 2 - anchor[1]);
	if (Math.abs(cx - seq.settings.width / 2) > 0.5 || Math.abs(cy - seq.settings.height / 2) > 0.5)
		h.fail(
			'E_INVALID_PARAM',
			'The tracked clip is not centred in the frame: the solved camera looks at the centre of the picture',
		);
	return k;
}

function linearKeys(h: HandlerContext, keys: { time: number; value: unknown }[]): Keyframe<unknown>[] {
	return keys.map((k) => ({
		id: h.ids.next('kf'),
		time: k.time,
		value: k.value,
		interpolation: 'linear',
		easeIn: { ...EASE_PRESETS.linear },
		easeOut: { ...EASE_PRESETS.linear },
	}));
}

const round = (v: number, d = 1e4) => {
	const r = Math.round(v * d) / d;
	return Object.is(r, -0) ? 0 : r;
};
const roundV = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/** The lowest video track above `trackId` free over [at, at + duration), else a new top track. */
function freeTrackAbove(seq: DSeq, trackId: string, at: number, duration: number): string {
	const i = seq.videoTracks.findIndex((t) => t.id === trackId);
	for (let k = i + 1; k < seq.videoTracks.length; k++) {
		const t = seq.videoTracks[k]!;
		if (t.locked) continue;
		if (!trackClips(seq, t.id).some((c) => c.start < at + duration && c.start + c.duration > at)) return t.id;
	}
	return `V${seq.videoTracks.length + 1}`;
}

export const cameraTrackerHandlers = {
	'cameraTracker.add': (doc, cmd: CommandOf<'cameraTracker.add'>, h: HandlerContext) => {
		const { seq, clip } = videoClip(doc, h, cmd.clipId);
		const c = clip as { cameraTracker?: DTracker };
		if (c.cameraTracker) h.fail('E_INVALID_PARAM', `Clip "${clip.name}" already has a 3D Camera Tracker`);
		const asset = doc.media[clip.mediaId];
		if (asset?.kind !== 'video') h.fail('E_INVALID_PARAM', 'The 3D Camera Tracker needs a video');
		const rate = rotoRateOf(asset, seq.settings.frameRate as Rational);
		const n = rotoFrameCount(asset, rate);
		const span = checkSpan(
			cmd.span ?? clipMediaFrames(clip, seq.settings.frameRate as Rational, rate, n),
			n,
			h,
		);
		const id = h.ids.next('ctk');
		const t: ClipCameraTracker = {
			id,
			mediaId: clip.mediaId,
			rate: { num: rate.num, den: rate.den },
			span,
			settings: {},
			deleted: [],
			solve: null,
		};
		c.cameraTracker = t as DTracker;
		const { type: _t, clipId: _c, span: _s, ...rest } = cmd;
		applySettings(c.cameraTracker, rest);
		return { trackerId: id, clipId: clip.id, span, inputs: cameraTrackerInputs(c.cameraTracker) };
	},
	'cameraTracker.settings': (doc, cmd: CommandOf<'cameraTracker.settings'>, h: HandlerContext) => {
		const { tracker } = trackerOf(doc, h, cmd.clipId);
		if (cmd.span) {
			const asset = doc.media[tracker.mediaId];
			const span = checkSpan(cmd.span, rotoFrameCount(asset, tracker.rate as Rational), h);
			if (span[0] !== tracker.span[0] || span[1] !== tracker.span[1]) {
				// Another span is another analysis: the solve and its ground plane go.
				tracker.span = span;
				tracker.solve = null;
				delete tracker.ground;
			}
		}
		const { type: _t, clipId: _c, span: _s, ...rest } = cmd;
		applySettings(tracker, rest);
		return { inputs: cameraTrackerInputs(tracker), settings: cameraTrackerSettingsOf(tracker.settings) };
	},
	'cameraTracker.setResult': (doc, cmd: CommandOf<'cameraTracker.setResult'>, h: HandlerContext) => {
		const { tracker } = trackerOf(doc, h, cmd.clipId);
		const s = cmd.solve;
		if (s.span[0] !== tracker.span[0] || s.span[1] !== tracker.span[1])
			h.fail('E_INVALID_PARAM', 'The solve is of another span than the tracker analyses: solve again');
		if (s.frames.length !== (s.span[1] - s.span[0] + 1) * 8)
			h.fail('E_INVALID_PARAM', 'solve.frames must hold 8 numbers per frame of the span');
		if (s.points.some((p) => p.first < s.span[0] || p.last > s.span[1] || p.last < p.first))
			h.fail('E_INVALID_PARAM', 'A track point lies outside the span');
		tracker.solve = { ...s, inputs: cameraTrackerInputs(tracker) } as never;
		// A new solve has a new canonical space: the old ground plane no longer applies.
		delete tracker.ground;
		return { points: s.points.length, averageError: s.averageError, methodUsed: s.methodUsed };
	},
	'cameraTracker.deletePoints': (doc, cmd: CommandOf<'cameraTracker.deletePoints'>, h: HandlerContext) => {
		const { tracker } = trackerOf(doc, h, cmd.clipId);
		const set = new Set(tracker.deleted);
		for (const id of cmd.pointIds) set.add(id);
		tracker.deleted = [...set].sort((a, b) => a - b);
		return { deleted: tracker.deleted.length, inputs: cameraTrackerInputs(tracker) };
	},
	'cameraTracker.setGround': (doc, cmd: CommandOf<'cameraTracker.setGround'>, h: HandlerContext) => {
		const { tracker } = trackerOf(doc, h, cmd.clipId);
		if (cmd.pointIds.length === 0) {
			delete tracker.ground;
			return { ground: null };
		}
		if (cmd.pointIds.length < 3)
			h.fail('E_INVALID_PARAM', 'Select three or more track points to define the ground plane');
		const pts = pointsById(tracker, cmd.pointIds, h);
		const cam = cameraFor(tracker, pts, cmd.frame, h);
		const g = groundOf(
			pts.map((p) => p.pos as Vec3),
			cam,
		);
		if (!g) return h.fail('E_INVALID_PARAM', 'The points do not define a plane');
		tracker.ground = { origin: roundV(g.origin), normal: g.normal, xAxis: g.xAxis } as never;
		return { ground: tracker.ground };
	},
	'cameraTracker.create': (doc, cmd: CommandOf<'cameraTracker.create'>, h: HandlerContext) => {
		const { seq, clip, tracker } = trackerOf(doc, h, cmd.clipId);
		const solve = tracker.solve;
		if (!solve || solveFrameCount(solve) === 0)
			return h.fail('E_INVALID_PARAM', 'Analyze and solve the camera first');
		const rate = seq.settings.frameRate as Rational;
		const frame = { width: seq.settings.width, height: seq.settings.height };
		const mapping = solveMapping(tracker as ClipCameraTracker, frame, pictureScale(doc, seq, clip, h));
		if (!mapping) return h.fail('E_INVALID_PARAM', 'The solve has no solved frame');
		const layerKind = cmd.layer ?? 'none';
		if (layerKind !== 'none' && !cmd.pointIds?.length)
			h.fail('E_INVALID_PARAM', 'Select track points: the layer goes on their target');
		const mediaAt = (f: number) => mediaFrameAt(contentTimeAt(clip, f, rate), tracker.rate as Rational);

		// The layer first (on a free track above the footage), then the camera (on top).
		let layerId: string | undefined;
		if (layerKind !== 'none') {
			const pts = pointsById(tracker, cmd.pointIds!, h);
			const cam = cameraFor(tracker, pts, cmd.frame, h);
			const target = targetOf(
				pts.map((p) => p.pos as Vec3),
				cam,
			)!;
			const centre = toWorld(mapping, target.c);
			const wc = worldCameraOf(mapping, cam);
			const fwd: Vec3 = [wc.rotation[0][2], wc.rotation[1][2], wc.rotation[2][2]];
			const right: Vec3 = [wc.rotation[0][0], wc.rotation[1][0], wc.rotation[2][0]];
			const depth = Math.max(1, dot3(sub3(centre, wc.eye), fwd));
			const settings = cameraTrackerSettingsOf(tracker.settings);
			const worldWidth = (0.25 * frame.width * depth * settings.targetSize) / (100 * wc.zoom);
			const track = freeTrackAbove(seq, clip.trackId, clip.start, clip.duration);
			const place = { sequenceId: seq.id, at: clip.start, duration: clip.duration, track };
			const res =
				layerKind === 'text'
					? (
							clipCoreHandlers['clip.addText'] as never as (
								d: DDoc,
								c: unknown,
								h: HandlerContext,
							) => { clipId: string }
						)(
							doc,
							{
								type: 'clip.addText',
								...place,
								content: { text: cmd.text ?? 'Text' },
								...(cmd.layerRef ? { ref: cmd.layerRef } : {}),
							},
							h,
						)
					: (
							clipCoreHandlers['clip.addSolid'] as never as (
								d: DDoc,
								c: unknown,
								h: HandlerContext,
							) => { clipId: string }
						)(
							doc,
							{
								type: 'clip.addSolid',
								...place,
								color: cmd.color ?? [0.8, 0.2, 0.2, 1],
								name: 'Tracked Solid',
								...(cmd.layerRef ? { ref: cmd.layerRef } : {}),
							},
							h,
						);
			layerId = res.clipId;
			const layer = seq.clips[layerId] as Draft<Clip> & {
				transform: Draft<VideoClip['transform']>;
				threeD?: Draft<NonNullable<VideoClip['threeD']>>;
			};
			const box = intrinsicBoxOf({ doc: doc as never, seq: seq as never, clip: layer as never });
			const l3 = newLayer3D(true, layer.kind);
			layer.threeD = l3 as never;
			layer.transform.position.value = [round(centre[0]), round(centre[1])] as never;
			l3.positionZ.value = round(centre[2]);
			l3.orientation.value = roundV(layerOrientationFor(dirToWorld(mapping, target.n), right)) as never;
			const pct = round((100 * worldWidth) / Math.max(1, box.width), 1e3);
			layer.transform.scale.value = pct;
			layer.transform.scaleWidth.value = pct;
		}

		let cameraId = cmd.replaceCamera ? tracker.createdCameraId : undefined;
		let camClip = cameraId ? (seq.clips[cameraId] as Draft<CameraClip> | undefined) : undefined;
		if (camClip?.kind !== 'camera') {
			const r = (
				threeDHandlers['clip.addCamera'] as never as (
					d: DDoc,
					c: unknown,
					h: HandlerContext,
				) => {
					clipId: string;
				}
			)(
				doc,
				{
					type: 'clip.addCamera',
					sequenceId: seq.id,
					at: clip.start,
					duration: clip.duration,
					cameraType: 'one-node',
					name: cmd.name ?? '3D Tracker Camera',
					...(cmd.cameraRef ? { ref: cmd.cameraRef } : {}),
				},
				h,
			);
			cameraId = r.clipId;
			camClip = seq.clips[cameraId] as Draft<CameraClip>;
		}
		const camData = camClip.camera;
		camData.transform.autoOrient = 'off';
		camData.depthOfField = false;
		const pos: { time: number; value: unknown }[] = [];
		const ori: { time: number; value: unknown }[] = [];
		const zoom: { time: number; value: unknown }[] = [];
		const zooms: number[] = [];
		for (
			let f = Math.max(clip.start, camClip.start);
			f < Math.min(clip.start + clip.duration, camClip.start + camClip.duration);
			f++
		) {
			const cam = solvedCameraAt(solve, mediaAt(f));
			if (!cam) continue;
			const wc = worldCameraOf(mapping, cam);
			const time = contentTimeAt(camClip, f, rate);
			pos.push({ time, value: roundV(wc.eye) });
			ori.push({ time, value: roundV(wc.orientation) });
			zoom.push({ time, value: round(wc.zoom) });
			zooms.push(wc.zoom);
		}
		if (pos.length === 0) h.fail('E_INVALID_PARAM', 'The clip shows no frame of the solved span');
		camData.transform.position = { value: pos[0]!.value, keyframes: linearKeys(h, pos) } as never;
		camData.transform.orientation = { value: ori[0]!.value, keyframes: linearKeys(h, ori) } as never;
		for (const k of ['rotationX', 'rotationY', 'rotationZ'] as const)
			camData.transform[k] = { value: 0, keyframes: [] } as never;
		const sorted = [...zooms].sort((a, b) => a - b);
		camData.zoom =
			solve.shot === 'variable'
				? ({ value: zoom[0]!.value, keyframes: linearKeys(h, zoom) } as never)
				: ({ value: round(sorted[sorted.length >> 1]!), keyframes: [] } as never);
		camData.focusDistance = { value: round(sorted[sorted.length >> 1]!), keyframes: [] } as never;
		tracker.createdCameraId = cameraId;
		return { cameraClipId: cameraId, ...(layerId ? { layerClipId: layerId } : {}), keys: pos.length };
	},
	'cameraTracker.remove': (doc, cmd: CommandOf<'cameraTracker.remove'>, h: HandlerContext) => {
		const { clip } = trackerOf(doc, h, cmd.clipId);
		delete (clip as { cameraTracker?: DTracker }).cameraTracker;
		return { clipId: clip.id };
	},
} satisfies HandlerMap;
