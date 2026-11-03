// Individual property writes use param.set so animated properties receive a key at the requested time.
import type { Draft } from 'immer';
import { clipEnd } from '../../derive/index.ts';
import { anim } from '../../factories.ts';
import { evaluate } from '../../keyframes.ts';
import type { Vec3 } from '../../schema/common.ts';
import type { CameraClip, Clip, LightClip } from '../../schema/sequence.ts';
import {
	type Backplate,
	type BevelBand,
	type CameraData,
	type Layer3D,
	type LightData,
	MAX_BACKPLATES,
	MAX_BEVEL_BANDS,
	type Sequence3D,
	type SurfaceMaterial,
} from '../../schema/three-d.ts';
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
import { ensureScene3dAnim, newGlint } from '../../three-d/scene-look.ts';
import {
	layerSurfaces,
	newSurface,
	SURFACE_COLORS,
	SURFACE_NUMBERS,
	SURFACE_PRESETS,
	type SurfaceValues,
} from '../../three-d/surfaces.ts';
import { newInflate } from '../../three-d/title-solid.ts';
import { dollyRig, orbitRig, panRig, type Rig } from '../../three-d/tools.ts';
import { type Rational, secondsToFrames } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, ensureTrackAt, findTrackIn, trackClips } from '../placement.ts';
import type { CommandOf, ParamAt } from '../schemas/index.ts';
import { commonFields, newGeneratorClip } from './clip-common.ts';
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

/** The video track a new camera / light / line goes on: `track`, else the top track when free over the range, else a new top track. */
export function rigTrack(seq: DSeq, h: HandlerContext, at: number, duration: number, track?: string): string {
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
			const t = h.clipContentTime(seq, clip, at);
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
		const t = h.clipContentTime(seq, clip, at);
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
			if (!m || (m.kind !== 'image' && m.kind !== 'video' && m.kind !== 'hdri'))
				h.fail('E_INVALID_PARAM', `Media ${o.environmentMediaId} is not an image, video or HDR`);
		}
		l.environmentMediaId = o.environmentMediaId;
	}
	if (o.environmentBackground !== undefined) {
		if (l.type !== 'environment') h.fail('E_INVALID_PARAM', 'Only environment lights draw a background');
		l.environmentBackground = o.environmentBackground;
	}
	if (o.environmentPreset !== undefined) {
		if (l.type !== 'environment')
			h.fail('E_INVALID_PARAM', 'Only environment lights take an environment preset');
		l.environmentPreset = o.environmentPreset;
	}
	if (o.environmentRotation !== undefined) {
		if (l.type !== 'environment') h.fail('E_INVALID_PARAM', 'Only environment lights rotate an environment');
		setParam(doc, h, clip.id, 'light.environmentRotation', o.environmentRotation, at);
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
	const g = newGeneratorClip(doc, { ...cmd, at, duration, track, sequenceId: seq.id }, h, kind);
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
	const t = h.clipContentTime(seq, clip, at);
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

type DLayer3D = Draft<Layer3D>;

/** The 3D block of a clip that can be edited, refusing locked tracks, clips that are not 3D, and clips without Geometry. */
function layer3dOf(
	doc: DDoc,
	h: HandlerContext,
	clipId: string,
	needsGeometry: boolean,
): { seq: DSeq; clip: DClip; td: DLayer3D } {
	const { seq, clip } = h.clip(doc, clipId);
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	const td = (clip as { threeD?: DLayer3D }).threeD;
	if (!td) h.fail('E_INVALID_PARAM', `Clip "${clip.name}" is not a 3D layer: turn its 3D switch on first`);
	if (needsGeometry && !td.geometry)
		h.fail(
			'E_INVALID_PARAM',
			`Clip "${clip.name}" has no Geometry Options: only text and shape layers extrude`,
		);
	return { seq, clip, td };
}

function presetValues(h: HandlerContext, preset: string | undefined): SurfaceValues {
	if (preset === undefined) return {};
	const p = SURFACE_PRESETS[preset];
	if (!p)
		return h.fail(
			'E_INVALID_PARAM',
			`Unknown material preset ${preset} (${Object.keys(SURFACE_PRESETS).join(', ')})`,
		);
	return p.values;
}

/** Writes values on an existing surface: numbers and colours through `param.set` (keys when animated). */
function writeSurface(
	doc: DDoc,
	h: HandlerContext,
	clipId: string,
	sid: string,
	s: Draft<SurfaceMaterial>,
	v: SurfaceValues,
	at?: ParamAt,
): void {
	const key = (f: string) => `threeD.surface.${sid.replace('.', '-')}.${f}`;
	if (v.base !== undefined) s.base = v.base;
	if (v.relief !== undefined) s.relief = v.relief;
	if (v.reliefSeed !== undefined) s.reliefSeed = v.reliefSeed;
	if (v.ramp === null) delete s.ramp;
	else if (v.ramp !== undefined) s.ramp = v.ramp as never;
	for (const n of SURFACE_NUMBERS)
		if (v[n.key] !== undefined) setParam(doc, h, clipId, key(n.key), v[n.key], at);
	for (const c of SURFACE_COLORS)
		if (v[c.key] !== undefined) setParam(doc, h, clipId, key(c.key), v[c.key], at);
}

/** Puts a surface where `path` (from `layerSurfaces`) says, in the 3D block of a clip. */
function placeSurface(
	td: DLayer3D,
	path: readonly (string | number)[],
	s: SurfaceMaterial | undefined,
): void {
	let cur = td as unknown as Record<string | number, unknown>;
	for (const k of path.slice(0, -1)) {
		cur[k] ??= {};
		cur = cur[k] as Record<string | number, unknown>;
	}
	const last = path[path.length - 1]!;
	if (s) cur[last] = s;
	else delete cur[last];
}

const clampIndex = (i: number | undefined, n: number) => Math.min(n, Math.max(0, i ?? n));

function reorder<T extends { id: string }>(list: T[], id: string, index: number): boolean {
	const from = list.findIndex((x) => x.id === id);
	if (from < 0) return false;
	const [x] = list.splice(from, 1);
	list.splice(Math.min(list.length, index), 0, x!);
	return true;
}

export const threeDHandlers = {
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
			...(cmd.toneMapping !== undefined ? { toneMapping: cmd.toneMapping } : {}),
		};
		seq.threeD = next as never;
		const param = (prop: string, value: unknown) =>
			(paramHandlers['param.set'] as (d: DDoc, c: CommandOf<'param.set'>, x: HandlerContext) => unknown)(
				doc,
				{ type: 'param.set', target: ['scene3d', seq.id, prop], value, ...(cmd.at ? { at: cmd.at } : {}) },
				h,
			);
		if (cmd.exposure !== undefined) param('exposure', cmd.exposure);
		if (cmd.glint) {
			const three = seq.threeD as unknown as Sequence3D;
			three.glint ??= newGlint();
			const g = cmd.glint;
			if (g.enabled !== undefined) three.glint!.enabled = g.enabled;
			if (g.rays !== undefined) three.glint!.rays = g.rays;
			const nums = [
				['threshold', 'glintThreshold'],
				['intensity', 'glintIntensity'],
				['radius', 'glintRadius'],
				['length', 'glintLength'],
				['angle', 'glintAngle'],
				['tint', 'glintTint'],
			] as const;
			for (const [k, prop] of nums) {
				if (g[k] === undefined) continue;
				ensureScene3dAnim(three as never, prop);
				param(prop, g[k]);
			}
		}
		return { threeD: seq.threeD };
	},
	'threeD.setSurface': (doc, cmd: CommandOf<'threeD.setSurface'>, h: HandlerContext) => {
		const ids = idList(cmd.clipIds);
		const sid = cmd.surface ?? 'base';
		const preset = presetValues(h, cmd.preset);
		for (const id of ids) {
			const { clip, td } = layer3dOf(doc, h, id, false);
			if (clip.kind === 'model')
				h.fail('E_INVALID_PARAM', `"${clip.name}" is a 3D model: its materials come from the file`);
			const slot = layerSurfaces(td as Layer3D).find((s) => s.id === sid);
			if (!slot) return h.fail('E_NOT_FOUND', `Clip "${clip.name}" has no surface ${sid}`);
			if (cmd.clear) {
				placeSurface(td, slot.path, undefined);
				continue;
			}
			if (cmd.preset !== undefined) {
				const values = { ...preset, ...(cmd.values ?? {}) } as SurfaceValues;
				placeSurface(td, slot.path, newSurface(values));
				continue;
			}
			if (!slot.surface) placeSurface(td, slot.path, newSurface({}));
			const live = layerSurfaces(td as Layer3D)
				.find((s) => s.id === sid)!
				.path.reduce<unknown>(
					(o, k) => (o as Record<string | number, unknown>)[k],
					td,
				) as Draft<SurfaceMaterial>;
			if (cmd.values) writeSurface(doc, h, clip.id, sid, live, cmd.values as SurfaceValues, cmd.at);
		}
		return { clipIds: ids };
	},
	'threeD.setGeometry': (doc, cmd: CommandOf<'threeD.setGeometry'>, h: HandlerContext) => {
		const ids = idList(cmd.clipIds);
		for (const id of ids) {
			const { clip, td } = layer3dOf(doc, h, id, true);
			const g = td.geometry!;
			if (cmd.mode !== undefined) g.mode = cmd.mode;
			if (cmd.bevelPosition !== undefined) g.bevelPosition = cmd.bevelPosition;
			if (cmd.extrusionDepth !== undefined)
				setParam(doc, h, clip.id, 'threeD.geometry.extrusionDepth', cmd.extrusionDepth, cmd.at);
			if (cmd.inflate) {
				g.inflate ??= newInflate() as never;
				const inf = g.inflate as Draft<NonNullable<Layer3D['geometry']>>['inflate'] & object;
				if (cmd.inflate.curve)
					(inf as { curve: unknown }).curve = [...cmd.inflate.curve].sort((a, b) => a.x - b.x);
				if (cmd.inflate.detail !== undefined) (inf as { detail: number }).detail = cmd.inflate.detail;
				const was = g.mode;
				g.mode = 'inflate';
				if (cmd.inflate.height !== undefined)
					setParam(doc, h, clip.id, 'threeD.geometry.inflate.height', cmd.inflate.height, cmd.at);
				if (cmd.inflate.smoothness !== undefined)
					setParam(doc, h, clip.id, 'threeD.geometry.inflate.smoothness', cmd.inflate.smoothness, cmd.at);
				if (was === undefined) delete g.mode;
				else g.mode = was;
			}
			if (g.mode === 'inflate') g.inflate ??= newInflate() as never;
		}
		return { clipIds: ids };
	},
	'threeD.addBand': (doc, cmd: CommandOf<'threeD.addBand'>, h: HandlerContext) => {
		const { td } = layer3dOf(doc, h, cmd.clipId, true);
		const g = td.geometry!;
		const bands = (g.bands ??= [] as never) as Draft<BevelBand>[];
		if (bands.length >= MAX_BEVEL_BANDS)
			return h.fail('E_LIMIT', `A solid has at most ${MAX_BEVEL_BANDS} bevel bands`);
		const id = h.ids.next('bnd');
		const material = cmd.preset !== undefined ? newSurface(presetValues(h, cmd.preset)) : undefined;
		const band: BevelBand = {
			id,
			width: anim(cmd.width ?? 6),
			depth: anim(cmd.depth ?? 6),
			profile: cmd.profile ?? 'round',
			curve: anim(cmd.curve ?? 0),
			segments: cmd.segments ?? 6,
			...(material ? { material } : {}),
		};
		bands.splice(clampIndex(cmd.index, bands.length), 0, band as never);
		h.defineRef(cmd.ref, id);
		return { bandId: id };
	},
	'threeD.removeBand': (doc, cmd: CommandOf<'threeD.removeBand'>, h: HandlerContext) => {
		const { td } = layer3dOf(doc, h, cmd.clipId, true);
		const bands = (td.geometry!.bands ?? []) as Draft<BevelBand>[];
		const i = bands.findIndex((b) => b.id === cmd.bandId);
		if (i < 0) return h.fail('E_NOT_FOUND', `Bevel band not found: ${cmd.bandId}`);
		bands.splice(i, 1);
		if (bands.length === 0) delete td.geometry!.bands;
		return { bandId: cmd.bandId };
	},
	'threeD.reorderBand': (doc, cmd: CommandOf<'threeD.reorderBand'>, h: HandlerContext) => {
		const { td } = layer3dOf(doc, h, cmd.clipId, true);
		if (!reorder((td.geometry!.bands ?? []) as Draft<BevelBand>[], cmd.bandId, cmd.index))
			return h.fail('E_NOT_FOUND', `Bevel band not found: ${cmd.bandId}`);
		return { bandId: cmd.bandId };
	},
	'threeD.addBackplate': (doc, cmd: CommandOf<'threeD.addBackplate'>, h: HandlerContext) => {
		const { td } = layer3dOf(doc, h, cmd.clipId, true);
		const g = td.geometry!;
		const plates = (g.backplates ??= [] as never) as Draft<Backplate>[];
		if (plates.length >= MAX_BACKPLATES)
			return h.fail('E_LIMIT', `A title has at most ${MAX_BACKPLATES} backplates`);
		const id = h.ids.next('plt');
		const values = cmd.preset !== undefined ? presetValues(h, cmd.preset) : null;
		const plate: Backplate = {
			id,
			enabled: true,
			shape: cmd.shape ?? 'contour',
			grow: anim(cmd.grow ?? 12),
			depth: anim(cmd.depth ?? 20),
			gap: anim(cmd.gap ?? 0),
			corner: anim(cmd.corner ?? 0),
			fillCounters: cmd.fillCounters ?? true,
			bevelWidth: anim(cmd.bevelWidth ?? 3),
			bevelDepth: anim(cmd.bevelDepth ?? 3),
			bevelProfile: cmd.bevelProfile ?? 'round',
			...(values ? { face: newSurface(values), side: newSurface(values) } : {}),
		};
		plates.splice(clampIndex(cmd.index, plates.length), 0, plate as never);
		h.defineRef(cmd.ref, id);
		return { plateId: id };
	},
	'threeD.removeBackplate': (doc, cmd: CommandOf<'threeD.removeBackplate'>, h: HandlerContext) => {
		const { td } = layer3dOf(doc, h, cmd.clipId, true);
		const plates = (td.geometry!.backplates ?? []) as Draft<Backplate>[];
		const i = plates.findIndex((p) => p.id === cmd.plateId);
		if (i < 0) return h.fail('E_NOT_FOUND', `Backplate not found: ${cmd.plateId}`);
		plates.splice(i, 1);
		if (plates.length === 0) delete td.geometry!.backplates;
		return { plateId: cmd.plateId };
	},
	'threeD.reorderBackplate': (doc, cmd: CommandOf<'threeD.reorderBackplate'>, h: HandlerContext) => {
		const { td } = layer3dOf(doc, h, cmd.clipId, true);
		if (!reorder((td.geometry!.backplates ?? []) as Draft<Backplate>[], cmd.plateId, cmd.index))
			return h.fail('E_NOT_FOUND', `Backplate not found: ${cmd.plateId}`);
		return { plateId: cmd.plateId };
	},
} satisfies HandlerMap;
