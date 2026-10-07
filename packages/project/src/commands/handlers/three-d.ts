// three-d (docs/wp-notes/three-d.md): handlers of the 3D Layer switch, new cameras and lights, Camera / Light
// Settings, the camera tools and the sequence 3D renderer. Property values go through param.set (stopwatch
// semantics: animated properties get a key at `at`).
import type { Draft } from 'immer';
import { clipEnd } from '../../derive/index.ts';
import { anim } from '../../factories.ts';
import { evaluate } from '../../keyframes.ts';
import type { Vec3 } from '../../schema/common.ts';
import type { CameraClip, Clip, LightClip } from '../../schema/sequence.ts';
import type { CameraData, LightData } from '../../schema/three-d.ts';
import { finiteOr, orientationFor, sub3 } from '../../three-d/math.ts';
import {
	aperturePxFromMm,
	CAMERA_PRESETS,
	canBe3d,
	DEFAULT_FILM_SIZE,
	DIRECTIONAL_LIGHTS,
	defaultGeometryOptions,
	focalLengthForZoom,
	newCameraData,
	newLayer3D,
	newLightData,
	zoomForAngleOfView,
	zoomForFocalLength,
} from '../../three-d/model.ts';
import { dollyRig, orbitRig, panRig, type Rig } from '../../three-d/tools.ts';
import { type Rational, secondsToFrames } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, ensureTrackAt, findTrackIn, trackClips } from '../placement.ts';
import type { CommandOf, ParamAt } from '../schemas/index.ts';
import { commonFields, newGeneratorClip } from './clip-core.ts';
import { paramHandlers } from './param.ts';
import { type HandlerMap, idList } from './util.ts';

export const THREE_D_OWNER = 'three-d' as const;

/** Transitions whose side is the clip. */
function transitionsOf(seq: DSeq, clipId: string): string[] {
	return Object.values(seq.transitions)
		.filter((t) => t.outgoingClipId === clipId || t.incomingClipId === clipId)
		.map((t) => t.id);
}

function setParam(
	doc: DDoc,
	h: HandlerContext,
	clipId: string,
	key: string,
	value: unknown,
	at?: ParamAt,
): void {
	(paramHandlers['param.set'] as (d: DDoc, c: CommandOf<'param.set'>, h: HandlerContext) => unknown)(
		doc,
		{ type: 'param.set', target: ['clip', clipId, ...key.split('.')], value, ...(at ? { at } : {}) },
		h,
	);
}

/** The video track a new camera / light goes on: `track`, else the top track when free over the range, else a new top track. */
function rigTrack(seq: DSeq, h: HandlerContext, at: number, duration: number, track?: string): string {
	if (track) return track;
	const top = seq.videoTracks[seq.videoTracks.length - 1];
	const free =
		top && !top.locked && !trackClips(seq, top.id).some((c) => c.start < at + duration && clipEnd(c) > at);
	if (free) return top.id;
	return ensureTrackAt(seq, 'video', seq.videoTracks.length, h).id;
}

function rigDuration(
	seq: DSeq,
	h: HandlerContext,
	at: number,
	input?: CommandOf<'clip.addCamera'>['duration'],
): number {
	if (input !== undefined) return h.durationFrames(seq, input);
	const rate = seq.settings.frameRate as Rational;
	const end = Object.values(seq.clips).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
	return Math.max(secondsToFrames(5, rate, 'round'), end - at);
}

type LensInput = Pick<
	CommandOf<'camera.settings'>,
	'zoom' | 'focalLength' | 'preset' | 'angleOfView' | 'filmSize' | 'measureFilmSize'
>;

/** Zoom (pixels) asked by a lens input, or undefined. */
function zoomOf(
	o: LensInput,
	frame: { width: number; height: number },
	filmSize: number,
	measure: CameraData['measureFilmSize'],
	h: HandlerContext,
): number | undefined {
	if (o.zoom !== undefined) return o.zoom;
	if (o.preset !== undefined) {
		const key = o.preset.toLowerCase().replace(/\s+/g, '');
		const p =
			CAMERA_PRESETS.find((x) => x.name.toLowerCase() === key) ??
			CAMERA_PRESETS.find((x) => `${x.focalLength}` === key);
		if (!p)
			h.fail(
				'E_INVALID_PARAM',
				`Unknown camera preset ${o.preset} (${CAMERA_PRESETS.map((x) => x.name).join(', ')})`,
			);
		return zoomForFocalLength(p.focalLength, frame, DEFAULT_FILM_SIZE, 'horizontal');
	}
	if (o.focalLength !== undefined) return zoomForFocalLength(o.focalLength, frame, filmSize, measure);
	if (o.angleOfView !== undefined) return zoomForAngleOfView(o.angleOfView, frame, measure);
	return undefined;
}

const frameOf = (seq: DSeq) => ({ width: seq.settings.width, height: seq.settings.height });

function clipOfKind<K extends 'camera' | 'light'>(
	doc: DDoc,
	h: HandlerContext,
	clipId: string,
	kind: K,
): { seq: DSeq; clip: Draft<K extends 'camera' ? CameraClip : LightClip> } {
	const { seq, clip } = h.clip(doc, clipId);
	if (clip.kind !== kind) h.fail('E_INVALID_PARAM', `Clip ${clipId} is not a ${kind}`);
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	return { seq, clip: clip as never };
}

/** Content time of a param `at` on a clip (for reading current values). */
function timeAt(h: HandlerContext, seq: DSeq, clip: DClip, at?: ParamAt): number {
	return h.clipContentTime(seq, clip, at);
}

const v3 = (v: unknown, d: Vec3): Vec3 =>
	Array.isArray(v) && v.length === 3 ? [finiteOr(v[0], d[0]), finiteOr(v[1], d[1]), finiteOr(v[2], d[2])] : d;

/** Applies camera settings (shared by clip.addCamera and camera.settings). */
function applyCameraSettings(
	doc: DDoc,
	h: HandlerContext,
	seq: DSeq,
	clip: Draft<CameraClip>,
	o: Omit<CommandOf<'camera.settings'>, 'type' | 'clipId'>,
): void {
	const cam = clip.camera;
	const frame = frameOf(seq);
	const at = o.at;
	if (o.filmSize !== undefined) cam.filmSize = o.filmSize;
	if (o.measureFilmSize !== undefined) cam.measureFilmSize = o.measureFilmSize;
	if (o.cameraType !== undefined) {
		const next = o.cameraType === 'two-node' ? 'poi' : 'off';
		if (
			next !== cam.transform.autoOrient &&
			next === 'off' &&
			cam.transform.orientation.keyframes.length === 0
		) {
			// One-node from two-node: keep the view by turning the Orientation towards the old Point of Interest.
			const t = timeAt(h, seq, clip, at);
			const eye = v3(evaluate(cam.transform.position as never, t), [0, 0, -1000]);
			const poi = v3(evaluate(cam.transform.pointOfInterest as never, t), [0, 0, 0]);
			const rx = finiteOr(evaluate(cam.transform.rotationX as never, t), 0);
			const ry = finiteOr(evaluate(cam.transform.rotationY as never, t), 0);
			if (rx === 0 && ry === 0) cam.transform.orientation.value = orientationFor(sub3(poi, eye)) as never;
		}
		cam.transform.autoOrient = next;
	}
	const zoom = zoomOf(o, frame, cam.filmSize, cam.measureFilmSize, h);
	if (zoom !== undefined) setParam(doc, h, clip.id, 'camera.zoom', zoom, at);
	if (o.depthOfField !== undefined) cam.depthOfField = o.depthOfField;
	if (o.irisShape !== undefined) cam.irisShape = o.irisShape;
	if (o.focusDistance !== undefined) setParam(doc, h, clip.id, 'camera.focusDistance', o.focusDistance, at);
	else if (o.lockToZoom && zoom !== undefined) setParam(doc, h, clip.id, 'camera.focusDistance', zoom, at);
	if (o.aperture !== undefined) setParam(doc, h, clip.id, 'camera.aperture', o.aperture, at);
	else if (o.fStop !== undefined) {
		const t = timeAt(h, seq, clip, at);
		const z = zoom ?? finiteOr(evaluate(cam.zoom as never, t), 1);
		const focal = focalLengthForZoom(z, frame, cam.filmSize, cam.measureFilmSize);
		setParam(doc, h, clip.id, 'camera.aperture', aperturePxFromMm(focal / o.fStop, frame.width), at);
	}
	if (o.blurLevel !== undefined) setParam(doc, h, clip.id, 'camera.blurLevel', o.blurLevel, at);
	if (o.name !== undefined) clip.name = o.name;
}

type LightInput = Omit<CommandOf<'light.settings'>, 'clipId' | 'type'>;

function applyLightSettings(doc: DDoc, h: HandlerContext, clip: Draft<LightClip>, o: LightInput): void {
	const l = clip.light;
	const at = o.at;
	if (o.lightType !== undefined && o.lightType !== l.type) {
		l.type = o.lightType;
		l.transform.autoOrient = DIRECTIONAL_LIGHTS.has(o.lightType) ? 'poi' : 'off';
		if (o.lightType === 'environment') {
			l.environmentMediaId ??= null;
			l.environmentRotation ??= anim(0) as never;
			l.environmentBackground ??= false;
		}
	}
	if (o.environmentMediaId !== undefined) {
		if (l.type !== 'environment')
			h.fail('E_INVALID_PARAM', 'Only environment lights take an environment image');
		if (o.environmentMediaId !== null) {
			const m = doc.media[o.environmentMediaId];
			if (!m || (m.kind !== 'image' && m.kind !== 'video'))
				h.fail('E_INVALID_PARAM', `Media ${o.environmentMediaId} is not an image or video`);
		}
		l.environmentMediaId = o.environmentMediaId;
	}
	if (o.environmentBackground !== undefined) {
		if (l.type !== 'environment') h.fail('E_INVALID_PARAM', 'Only environment lights draw a background');
		l.environmentBackground = o.environmentBackground;
	}
	if (o.falloff !== undefined) l.falloff = o.falloff;
	if (o.castsShadows !== undefined) l.castsShadows = o.castsShadows;
	const nums: [keyof LightInput, string][] = [
		['intensity', 'light.intensity'],
		['color', 'light.color'],
		['coneAngle', 'light.coneAngle'],
		['coneFeather', 'light.coneFeather'],
		['radius', 'light.radius'],
		['falloffDistance', 'light.falloffDistance'],
		['shadowDarkness', 'light.shadowDarkness'],
		['shadowDiffusion', 'light.shadowDiffusion'],
	];
	for (const [k, key] of nums) if (o[k] !== undefined) setParam(doc, h, clip.id, key, o[k], at);
	if (o.name !== undefined) clip.name = o.name;
}

function placeRig(
	doc: DDoc,
	cmd: CommandOf<'clip.addCamera'> | CommandOf<'clip.addLight'>,
	h: HandlerContext,
	kind: 'camera' | 'light',
): { seq: DSeq; id: string } {
	const seq = h.sequence(doc, cmd.sequenceId);
	const at = h.frame(seq, cmd.at);
	if (at < 0) h.fail('E_INVALID_PARAM', 'Clip start must be >= 0');
	const duration = rigDuration(seq, h, at, cmd.duration);
	const track = rigTrack(seq, h, at, duration, cmd.track);
	// newGeneratorClip checks the track (video, unlocked), allocates the id and clears the range.
	const g = newGeneratorClip(doc, { ...cmd, at, duration, track, sequenceId: seq.id }, h, kind as never);
	const n = Object.values(seq.clips).filter((c) => c.kind === kind).length + 1;
	const name = cmd.name ?? (kind === 'camera' ? `Camera ${n}` : `Light ${n}`);
	const common = commonFields(g.id, g.track.id, g.at, g.duration, 0, name, 'rose');
	if (kind === 'camera') {
		const c = cmd as CommandOf<'clip.addCamera'>;
		const frame = frameOf(seq);
		const filmSize = c.filmSize ?? DEFAULT_FILM_SIZE;
		const measure = c.measureFilmSize ?? 'horizontal';
		const zoom = zoomOf(c, frame, filmSize, measure, h);
		const data = newCameraData(frame, {
			type: c.cameraType ?? 'two-node',
			...(zoom !== undefined ? { zoom } : {}),
			filmSize,
			measureFilmSize: measure,
		});
		if (c.position) data.transform.position = anim(c.position);
		if (c.pointOfInterest) data.transform.pointOfInterest = anim(c.pointOfInterest);
		if (c.cameraType === 'one-node' && (c.position || c.pointOfInterest)) {
			data.transform.orientation = anim(
				orientationFor(
					sub3(
						v3(data.transform.pointOfInterest.value, [0, 0, 0]),
						v3(data.transform.position.value, [0, 0, -1]),
					),
				),
			);
		}
		seq.clips[g.id] = { ...common, kind: 'camera', camera: data } as DClip;
		applyCameraSettings(doc, h, seq, seq.clips[g.id] as Draft<CameraClip>, {
			...(c.depthOfField !== undefined ? { depthOfField: c.depthOfField } : {}),
			...(c.focusDistance !== undefined ? { focusDistance: c.focusDistance } : {}),
			...(c.lockToZoom !== undefined ? { lockToZoom: c.lockToZoom } : {}),
			...(c.aperture !== undefined ? { aperture: c.aperture } : {}),
			...(c.fStop !== undefined ? { fStop: c.fStop } : {}),
			...(c.blurLevel !== undefined ? { blurLevel: c.blurLevel } : {}),
			...(c.irisShape !== undefined ? { irisShape: c.irisShape } : {}),
			...(zoom !== undefined && c.lockToZoom !== false && c.focusDistance === undefined
				? { focusDistance: zoom }
				: {}),
		});
	} else {
		const c = cmd as CommandOf<'clip.addLight'>;
		const data: LightData = newLightData(c.lightType, frameOf(seq));
		if (c.position) data.transform.position = anim(c.position);
		if (c.pointOfInterest) data.transform.pointOfInterest = anim(c.pointOfInterest);
		seq.clips[g.id] = { ...common, kind: 'light', light: data } as DClip;
		const {
			lightType: _t,
			sequenceId: _s,
			at: _a,
			duration: _d,
			track: _k,
			ref: _r,
			position: _p,
			pointOfInterest: _q,
			type: _ty,
			...rest
		} = c;
		applyLightSettings(doc, h, seq.clips[g.id] as Draft<LightClip>, rest);
	}
	cleanupSequence(seq, h);
	h.defineRef(cmd.ref, g.id);
	return { seq, id: g.id };
}

function cameraTool(
	doc: DDoc,
	h: HandlerContext,
	clipId: string,
	at: ParamAt | undefined,
	op: (r: Rig) => Rig,
): { position: Vec3; pointOfInterest: Vec3 } {
	const { seq, clip } = clipOfKind(doc, h, clipId, 'camera');
	const tr = clip.camera.transform;
	const t = timeAt(h, seq, clip, at);
	const eye = v3(evaluate(tr.position as never, t), [0, 0, -1000]);
	const poi = v3(evaluate(tr.pointOfInterest as never, t), [0, 0, 0]);
	const zoom = finiteOr(evaluate(clip.camera.zoom as never, t), 1000);
	const r = op({ eye, poi, zoom, ortho: false });
	const moved = (a: Vec3, b: Vec3) => a.some((x, i) => Math.abs(x - b[i]!) > 1e-9);
	if (moved(r.eye, eye)) setParam(doc, h, clip.id, 'camera.position', r.eye, at);
	if (moved(r.poi, poi)) setParam(doc, h, clip.id, 'camera.pointOfInterest', r.poi, at);
	// A one-node camera turns to keep looking at its point of interest (its Orientation, when not animated).
	if (tr.autoOrient === 'off' && tr.orientation.keyframes.length === 0)
		tr.orientation.value = orientationFor(sub3(r.poi, r.eye)) as never;
	return { position: r.eye, pointOfInterest: r.poi };
}

export const threeDHandlers: HandlerMap = {
	'clip.set3d': (doc, cmd: CommandOf<'clip.set3d'>, h: HandlerContext) => {
		const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
		const changed: string[] = [];
		for (const c of clips) {
			if (!canBe3d(c.kind))
				h.fail('E_INVALID_PARAM', `A ${c.kind} clip cannot be a 3D layer`, { blocking: [c.id] });
			assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
			if (!cmd.enabled && c.kind === 'model')
				h.fail('E_INVALID_PARAM', `"${c.name}" is a 3D model: model layers are always 3D`, {
					blocking: [c.id],
				});
			const v = c as Draft<Clip> & {
				threeD?: Draft<NonNullable<Extract<Clip, { kind: 'video' }>['threeD']>>;
			};
			if (cmd.enabled) {
				const tr = transitionsOf(seq, c.id);
				if (tr.length)
					h.fail(
						'E_INVALID_PARAM',
						`Clip "${c.name}" has transitions (${tr.join(', ')}); 3D layers take no transitions: remove them first`,
						{ blocking: tr },
					);
			}
			if (!v.threeD) {
				if (!cmd.enabled) continue;
				v.threeD = newLayer3D(true, c.kind) as never;
			} else {
				if (v.threeD.enabled === cmd.enabled) continue;
				v.threeD.enabled = cmd.enabled;
				if ((c.kind === 'text' || c.kind === 'shape') && !v.threeD.geometry)
					v.threeD.geometry = defaultGeometryOptions() as never;
			}
			changed.push(c.id);
		}
		return { clipIds: changed };
	},
	'clip.addCamera': (doc, cmd: CommandOf<'clip.addCamera'>, h: HandlerContext) => {
		const { id } = placeRig(doc, cmd, h, 'camera');
		return { clipId: id };
	},
	'clip.addLight': (doc, cmd: CommandOf<'clip.addLight'>, h: HandlerContext) => {
		const { id } = placeRig(doc, cmd, h, 'light');
		return { clipId: id };
	},
	'camera.settings': (doc, cmd: CommandOf<'camera.settings'>, h: HandlerContext) => {
		const { seq, clip } = clipOfKind(doc, h, cmd.clipId, 'camera');
		const { clipId: _c, type: _t, ...rest } = cmd;
		applyCameraSettings(doc, h, seq, clip, rest);
		return { clipId: clip.id };
	},
	'light.settings': (doc, cmd: CommandOf<'light.settings'>, h: HandlerContext) => {
		const { clip } = clipOfKind(doc, h, cmd.clipId, 'light');
		const { clipId: _c, type: _t, ...rest } = cmd;
		applyLightSettings(doc, h, clip, rest);
		return { clipId: clip.id };
	},
	'camera.orbit': (doc, cmd: CommandOf<'camera.orbit'>, h: HandlerContext) =>
		cameraTool(doc, h, cmd.clipId, cmd.at, (r) => orbitRig(r, cmd.yaw, cmd.pitch)),
	'camera.pan': (doc, cmd: CommandOf<'camera.pan'>, h: HandlerContext) =>
		cameraTool(doc, h, cmd.clipId, cmd.at, (r) => panRig(r, cmd.dx, cmd.dy)),
	'camera.dolly': (doc, cmd: CommandOf<'camera.dolly'>, h: HandlerContext) =>
		cameraTool(doc, h, cmd.clipId, cmd.at, (r) => dollyRig(r, cmd.amount, cmd.withPoi ?? false)),
	'sequence.set3dRenderer': (doc, cmd: CommandOf<'sequence.set3dRenderer'>, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const cur = seq.threeD ?? { renderer: 'classic' as const };
		const next = {
			...cur,
			...(cmd.renderer ? { renderer: cmd.renderer } : {}),
			...(cmd.draft !== undefined ? { draft: cmd.draft } : {}),
			...(cmd.shadowMapSize !== undefined ? { shadowMapSize: cmd.shadowMapSize } : {}),
			...(cmd.supersampling !== undefined ? { supersampling: cmd.supersampling } : {}),
		};
		seq.threeD = next as never;
		return { threeD: next };
	},
};
