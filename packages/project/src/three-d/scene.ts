// three-d: evaluation of a sequence's 3D scene at a frame — the active camera, the lights, every 3D layer's world
// matrix and material, and the 3D runs of the layer stack. Pure (preview, export, overlays, agents and the GL /
// CPU renderers all use it). Ported from EffectCraft `render/three_d/{camera,light}.rs` (MIT OR Apache-2.0).
import { bezierProgress, evaluate, incomingEase, isHoldOnlyValue, outgoingEase } from '../keyframes.ts';
import type { Mat3 } from '../render/homography.ts';
import { clipContentTime } from '../render/scene.ts';
import type {
	RenderCameraClip,
	RenderLightClip,
	RenderScene3D,
	RenderSnapshot,
	RenderVisualClip,
} from '../render/snapshot.ts';
import type { Animatable, RGBA, Vec2, Vec3 } from '../schema/common.ts';
import type { LightType, MaterialOptions, RigTransform } from '../schema/three-d.ts';
import { FLICKS_PER_SECOND, type Rational } from '../time.ts';
import {
	mat4Apply,
	mat4ApplyVec,
	basisRotation,
	basisView,
	cross3,
	dot3,
	finiteOr,
	MAT4_IDENTITY,
	mat4Invert,
	layerMatrix3D,
	len3,
	type Matrix4,
	mat4FromQuat,
	mat4Mul,
	mat4MulAll,
	norm3,
	mat4Orientation,
	planeToMat3,
	quatFromMat4,
	mat4RotateX,
	mat4RotateY,
	mat4RotateZ,
	scale3,
	slerp,
	sub3,
	mat4Translate,
} from './math.ts';
import { defaultAperture, defaultCameraZoom, irisSides, MATERIAL_DEFAULTS, NEAR_PLANE } from './model.ts';

// ---------------------------------------------------------------- cameras

export type Iris = {
	/** Polygon sides (0 = Fast Rectangle). */
	sides: number;
	/** Degrees. */
	rotation: number;
	/** 0…1. */
	roundness: number;
	aspect: number;
	/** 0…1 (Diffraction Fringe / 100). */
	fringe: number;
};
export type Highlight = { gain: number; threshold: number; saturation: number };

/** Depth of field of a camera (distances in pixels). */
export type Dof = { focus: number; aperture: number; blurLevel: number; iris: Iris; highlight: Highlight };

/** An evaluated camera. */
export type CameraState = {
	/** World → camera space (rigid; camera x right, y down, z forward). */
	view: Matrix4;
	eye: Vec3;
	/** Perspective: eye → image plane distance (pixels). Orthographic: pixels per world unit. */
	zoom: number;
	ortho: boolean;
	dof: Dof | null;
	/** The camera clip (null = the default camera or a view camera). */
	clipId: string | null;
};

/** Circle-of-confusion diameter (frame pixels) of a point at camera depth `z`. */
export function circleOfConfusion(dof: Dof, z: number): number {
	if (z <= NEAR_PLANE || dof.focus <= 0) return 0;
	return ((dof.aperture * Math.abs(z - dof.focus)) / z) * dof.blurLevel;
}

/** World → frame pixels (homogeneous; divide by w for perspective cameras). */
export function cameraProjection(cam: CameraState, w: number, h: number): Matrix4 {
	const z = cam.zoom;
	const proj: Matrix4 = cam.ortho
		? [z, 0, 0, w / 2, 0, z, 0, h / 2, 0, 0, 1, 0, 0, 0, 0, 1]
		: [z, 0, w / 2, 0, 0, z, h / 2, 0, 0, 0, 1, 0, 0, 0, 1, 0];
	return mat4Mul(proj, cam.view);
}

/** Camera-space depth of a world point. */
export function cameraDepth(cam: CameraState, p: Vec3): number {
	return mat4Apply(cam.view, p)[2];
}

export const cameraRight = (c: CameraState): Vec3 => [c.view[0]!, c.view[1]!, c.view[2]!];
export const cameraDown = (c: CameraState): Vec3 => [c.view[4]!, c.view[5]!, c.view[6]!];
export const cameraForward = (c: CameraState): Vec3 => [c.view[8]!, c.view[9]!, c.view[10]!];

/** Frame pixels of a world point; null behind a perspective camera. */
export function projectPoint(cam: CameraState, w: number, h: number, p: Vec3): Vec2 | null {
	const c = mat4Apply(cam.view, p);
	if (cam.ortho) return [cam.zoom * c[0] + w / 2, cam.zoom * c[1] + h / 2];
	if (c[2] < NEAR_PLANE) return null;
	return [(cam.zoom * c[0]) / c[2] + w / 2, (cam.zoom * c[1]) / c[2] + h / 2];
}

/** The world ray through a frame pixel: origin and unit direction. */
export function pixelRay(cam: CameraState, w: number, h: number, x: number, y: number): { o: Vec3; d: Vec3 } {
	const f = cameraForward(cam);
	const r = cameraRight(cam);
	const dn = cameraDown(cam);
	if (cam.ortho) {
		const k = 1 / Math.max(1e-9, cam.zoom);
		const o: Vec3 = [
			cam.eye[0] + (r[0] * (x - w / 2) + dn[0] * (y - h / 2)) * k,
			cam.eye[1] + (r[1] * (x - w / 2) + dn[1] * (y - h / 2)) * k,
			cam.eye[2] + (r[2] * (x - w / 2) + dn[2] * (y - h / 2)) * k,
		];
		return { o, d: f };
	}
	const d = norm3([
		f[0] * cam.zoom + r[0] * (x - w / 2) + dn[0] * (y - h / 2),
		f[1] * cam.zoom + r[1] * (x - w / 2) + dn[1] * (y - h / 2),
		f[2] * cam.zoom + r[2] * (x - w / 2) + dn[2] * (y - h / 2),
	]);
	return { o: cam.eye, d };
}

/** Direction from a shaded point towards the viewer. */
export function toViewer(cam: CameraState, p: Vec3): Vec3 {
	return cam.ortho ? scale3(cameraForward(cam), -1) : norm3(sub3(cam.eye, p));
}

/**
 * The camera used when no camera is on: the 50 mm preset at (w/2, h/2, −zoom) looking at the frame centre, which
 * shows the z = 0 plane at 100 % (so 3D layers left at their defaults are where their 2D Motion puts them).
 */
export function defaultCamera(w: number, h: number): CameraState {
	const zoom = defaultCameraZoom(w);
	const eye: Vec3 = [w / 2, h / 2, -zoom];
	return { view: basisView(eye, [0, 0, 1], [0, 1, 0]), eye, zoom, ortho: false, dof: null, clipId: null };
}

/** A view camera from an eye, a point of interest and a zoom (Program monitor 3D views, camera tools). */
export function lookAtCamera(
	eye: Vec3,
	poi: Vec3,
	zoom: number,
	ortho = false,
	down: Vec3 = [0, 1, 0],
): CameraState {
	return { view: basisView(eye, sub3(poi, eye), down), eye, zoom, ortho, dof: null, clipId: null };
}

const vec3Of = (v: unknown, fallback: Vec3): Vec3 =>
	Array.isArray(v) && v.length >= 3
		? [finiteOr(v[0], fallback[0]), finiteOr(v[1], fallback[1]), finiteOr(v[2], fallback[2])]
		: fallback;
const num = (a: Animatable<number> | undefined, t: number, fallback: number): number =>
	a ? finiteOr(evaluate(a, t), fallback) : fallback;

/**
 * The rotation matrix of an Orientation property at content time `t`: between keyframes it turns along the
 * shortest rotation (After Effects interpolates Orientation spherically), with the keys' temporal eases.
 */
export function orientationMatrixAt(o: Animatable<Vec3>, t: number): Matrix4 {
	const kfs = o.keyframes;
	const bound = (o as unknown as Record<symbol, unknown>)[Symbol.for('jasper.expressionBinding')];
	if (kfs.length < 2 || bound) return mat4Orientation(vec3Of(evaluate(o, t), [0, 0, 0]));
	if (t <= kfs[0]!.time) return mat4Orientation(vec3Of(kfs[0]!.value, [0, 0, 0]));
	const last = kfs[kfs.length - 1]!;
	if (t >= last.time) return mat4Orientation(vec3Of(last.value, [0, 0, 0]));
	let i = 0;
	while (i < kfs.length - 2 && kfs[i + 1]!.time <= t) i++;
	const a = kfs[i]!;
	const b = kfs[i + 1]!;
	if (a.interpolation === 'hold' || isHoldOnlyValue(a.value))
		return mat4Orientation(vec3Of(a.value, [0, 0, 0]));
	const u = (t - a.time) / Math.max(1, b.time - a.time);
	const p =
		a.interpolation === 'linear' ? u : bezierProgress(u, outgoingEase(kfs, i), incomingEase(kfs, i + 1));
	const qa = quatFromMat4(mat4Orientation(vec3Of(a.value, [0, 0, 0])));
	const qb = quatFromMat4(mat4Orientation(vec3Of(b.value, [0, 0, 0])));
	return mat4FromQuat(slerp(qa, qb, Math.min(1, Math.max(0, p))));
}

/** The local rotation of a camera / light: aimed at its Point of Interest (two-node), then Orientation and X/Y/Z. */
function rigRotation(r: RigTransform, t: number, pos: Vec3): Matrix4 {
	const rot = mat4MulAll(
		orientationMatrixAt(r.orientation, t),
		mat4RotateZ(num(r.rotationZ, t, 0)),
		mat4RotateY(num(r.rotationY, t, 0)),
		mat4RotateX(num(r.rotationX, t, 0)),
	);
	if (r.autoOrient !== 'poi') return rot;
	const poi = vec3Of(evaluate(r.pointOfInterest, t), [0, 0, 0]);
	const d = sub3(poi, pos);
	if (len3(d) < 1e-9) return rot;
	return mat4Mul(basisRotation(d, [0, 1, 0]), rot);
}

/** World eye, forward and down of a camera / light at content time `t`. */
export function rigFrameAt(
	r: RigTransform,
	t: number,
): { eye: Vec3; fwd: Vec3; down: Vec3; rotation: Matrix4 } {
	const eye = vec3Of(evaluate(r.position, t), [0, 0, -1000]);
	const rotation = rigRotation(r, t, eye);
	return {
		eye,
		fwd: norm3(mat4ApplyVec(rotation, [0, 0, 1])),
		down: norm3(mat4ApplyVec(rotation, [0, 1, 0])),
		rotation,
	};
}

const rigTime = (c: RenderCameraClip | RenderLightClip, frame: number, fps: Rational) =>
	clipContentTime(c, frame, fps);

/** An evaluated camera clip at a sequence frame. */
export function cameraStateOf(
	c: RenderCameraClip,
	frame: number,
	fps: Rational,
	frameWidth: number,
): CameraState {
	const t = rigTime(c, frame, fps);
	const cam = c.camera;
	const { eye, fwd, down } = rigFrameAt(cam.transform, t);
	const zoom = Math.max(1e-3, num(cam.zoom, t, defaultCameraZoom(frameWidth)));
	const dof: Dof | null = cam.depthOfField
		? {
				focus: num(cam.focusDistance, t, zoom),
				aperture: Math.max(0, num(cam.aperture, t, defaultAperture(frameWidth))),
				blurLevel: Math.max(0, num(cam.blurLevel, t, 100)) / 100,
				iris: {
					sides: irisSides(cam.irisShape),
					rotation: num(cam.irisRotation, t, 0),
					roundness: Math.min(1, Math.max(0, num(cam.irisRoundness, t, 0) / 100)),
					aspect: Math.min(100, Math.max(0.01, num(cam.irisAspectRatio, t, 1))),
					fringe: Math.max(0, num(cam.irisDiffractionFringe, t, 0)) / 100,
				},
				highlight: {
					gain: Math.min(100, Math.max(0, num(cam.highlightGain, t, 0))) / 100,
					threshold: Math.min(255, Math.max(0, num(cam.highlightThreshold, t, 255))) / 255,
					saturation: Math.min(100, Math.max(0, num(cam.highlightSaturation, t, 0))) / 100,
				},
			}
		: null;
	return { view: basisView(eye, fwd, down), eye, zoom, ortho: false, dof, clipId: c.clipId };
}

const drawnAt = (c: { start: number; duration: number }, f: number) =>
	f >= c.start && f < c.start + c.duration;

/** The camera clip that is active at a frame: the topmost (highest track) camera that is on. */
export function activeCameraClipAt(scene: RenderScene3D | undefined, frame: number): RenderCameraClip | null {
	let best: RenderCameraClip | null = null;
	for (const c of scene?.cameras ?? [])
		if (drawnAt(c, frame) && (!best || c.trackIndex > best.trackIndex)) best = c;
	return best;
}

/** The active camera of a snapshot at a frame (the default camera when no camera is on). */
export function activeCameraAt(
	snap: Pick<RenderSnapshot, 'settings' | 'scene3d'>,
	frame: number,
): CameraState {
	const { width, height, fps } = snap.settings;
	const c = activeCameraClipAt(snap.scene3d, frame);
	return c ? cameraStateOf(c, frame, fps, width) : defaultCamera(width, height);
}

// ---------------------------------------------------------------- lights

export type LightState = {
	clipId: string;
	type: LightType;
	pos: Vec3;
	/** Unit direction the light travels (parallel / spot). */
	dir: Vec3;
	/** Linear colour × intensity (1 = 100 %). */
	color: Vec3;
	/** Spot: cone half-angle (radians) and feather (0…1). */
	coneHalf: number;
	feather: number;
	falloff: 0 | 1 | 2;
	radius: number;
	falloffDistance: number;
	castsShadows: boolean;
	/** 0…1. */
	shadowDarkness: number;
	/** Pixels. */
	shadowDiffusion: number;
	/** Environment lights: the media and rotation (radians). */
	environment?: { mediaId: string | null; rotation: number; background: boolean };
};

const FALLOFF = { none: 0, smooth: 1, 'inverse-square': 2 } as const;

export function lightStateOf(c: RenderLightClip, frame: number, fps: Rational): LightState {
	const t = rigTime(c, frame, fps);
	const l = c.light;
	const intensity = num(l.intensity, t, 100) / 100;
	const col = evaluate(l.color, t) as RGBA;
	const color: Vec3 = [
		finiteOr(col?.[0], 1) * intensity,
		finiteOr(col?.[1], 1) * intensity,
		finiteOr(col?.[2], 1) * intensity,
	];
	const { eye, fwd } = rigFrameAt(l.transform, t);
	return {
		clipId: c.clipId,
		type: l.type,
		pos: eye,
		dir: fwd,
		color,
		coneHalf: ((Math.min(180, Math.max(0, num(l.coneAngle, t, 90))) / 2) * Math.PI) / 180,
		feather: Math.min(100, Math.max(0, num(l.coneFeather, t, 50))) / 100,
		falloff: FALLOFF[l.falloff] ?? 0,
		radius: Math.max(0, num(l.radius, t, 500)),
		falloffDistance: Math.max(0, num(l.falloffDistance, t, 500)),
		castsShadows: l.castsShadows && l.type !== 'ambient' && l.type !== 'environment',
		shadowDarkness: Math.min(100, Math.max(0, num(l.shadowDarkness, t, 100))) / 100,
		shadowDiffusion: Math.max(0, num(l.shadowDiffusion, t, 0)),
		...(l.type === 'environment'
			? {
					environment: {
						mediaId: l.environmentMediaId ?? null,
						rotation: (num(l.environmentRotation, t, 0) * Math.PI) / 180,
						background: !!l.environmentBackground,
					},
				}
			: {}),
	};
}

/** Every light that is on at a frame (environment lights only light Advanced 3D). */
export function lightsAt(
	scene: RenderScene3D | undefined,
	frame: number,
	fps: Rational,
	opts: { environment?: boolean } = {},
): LightState[] {
	if (!scene) return [];
	return scene.lights
		.filter((c) => drawnAt(c, frame) && (opts.environment || c.light.type !== 'environment'))
		.sort((a, b) => a.trackIndex - b.trackIndex || a.start - b.start)
		.map((c) => lightStateOf(c, frame, fps));
}

/** Unit vector from `p` towards the light and the distance (∞ for parallel lights). */
export function toLight(l: LightState, p: Vec3): { v: Vec3; dist: number } {
	if (l.type === 'parallel') return { v: scale3(l.dir, -1), dist: Number.POSITIVE_INFINITY };
	const d = sub3(l.pos, p);
	const len = len3(d);
	return len < 1e-9 ? { v: [0, 0, -1], dist: 0 } : { v: scale3(d, 1 / len), dist: len };
}

const smoothFall = (t: number) => 1 - t * t * (3 - 2 * t);

/** Distance falloff × spot cone factor at `p` (0…1). */
export function lightAttenuation(l: LightState, p: Vec3): number {
	const { v, dist } = toLight(l, p);
	let k = 1;
	if (l.falloff === 1 && Number.isFinite(dist)) {
		if (dist <= l.radius) k = 1;
		else if (l.falloffDistance <= 0) k = 0;
		else k = smoothFall(Math.min(1, Math.max(0, (dist - l.radius) / l.falloffDistance)));
	} else if (l.falloff === 2 && Number.isFinite(dist)) {
		if (dist <= l.radius || (l.radius <= 0 && dist <= 1)) k = 1;
		else k = (Math.max(l.radius, 1) / dist) ** 2;
	}
	if (l.type === 'spot') {
		const cosA = Math.min(1, Math.max(-1, -dot3(v, l.dir)));
		const a = Math.acos(cosA);
		const outer = l.coneHalf;
		const inner = outer * (1 - l.feather);
		if (a >= outer) k = 0;
		else if (a > inner) k *= smoothFall((a - inner) / Math.max(1e-9, outer - inner));
	}
	return k;
}

// ---------------------------------------------------------------- materials

/** Evaluated Material Options (fractions). */
export type MaterialState = {
	castsShadows: 0 | 1 | 2;
	lightTransmission: number;
	acceptsShadows: 0 | 1 | 2;
	acceptsLights: boolean;
	ambient: number;
	diffuse: number;
	specular: number;
	/** 0…1. */
	shininess: number;
	/** 0…1. */
	metal: number;
	reflection: number;
	reflectionSharpness: number;
};

const SHADOW = { off: 0, on: 1, only: 2 } as const;

export function materialAt(m: MaterialOptions | undefined, t: number): MaterialState {
	const d = MATERIAL_DEFAULTS;
	const pct = (a: Animatable<number> | undefined, def: number) => num(a, t, def) / 100;
	return {
		castsShadows: SHADOW[m?.castsShadows ?? d.castsShadows] ?? 0,
		lightTransmission: Math.min(1, Math.max(0, pct(m?.lightTransmission, d.lightTransmission))),
		acceptsShadows: SHADOW[m?.acceptsShadows ?? d.acceptsShadows] ?? 1,
		acceptsLights: m?.acceptsLights ?? d.acceptsLights,
		ambient: Math.max(0, pct(m?.ambient, d.ambient)),
		diffuse: Math.max(0, pct(m?.diffuse, d.diffuse)),
		specular: Math.max(0, pct(m?.specularIntensity, d.specularIntensity)),
		shininess: Math.min(1, Math.max(0, pct(m?.specularShininess, d.specularShininess))),
		metal: Math.min(1, Math.max(0, pct(m?.metal, d.metal))),
		reflection: Math.min(1, Math.max(0, pct(m?.reflectionIntensity, d.reflectionIntensity))),
		reflectionSharpness: Math.min(1, Math.max(0, pct(m?.reflectionSharpness, d.reflectionSharpness))),
	};
}

/** Blinn-Phong exponent of Specular Shininess (0 % → 1, 100 % → 256). */
export function shininessExponent(m: Pick<MaterialState, 'shininess'>): number {
	return Math.max(1, 256 ** m.shininess);
}

// ---------------------------------------------------------------- 3D layers

const PATH_DT = Math.round(0.005 * FLICKS_PER_SECOND);

/** Position (x, y, z) of a 3D layer at content time `t`. */
export function layerPosition3D(clip: Pick<RenderVisualClip, 'transform' | 'threeD'>, t: number): Vec3 {
	const p = clip.transform ? (evaluate(clip.transform.position, t) as Vec2) : ([0, 0] as Vec2);
	return [finiteOr(p?.[0], 0), finiteOr(p?.[1], 0), num(clip.threeD?.positionZ, t, 0)];
}

export type Layer3DContext = {
	/** The active camera's eye (Auto-Orient towards Camera). */
	cameraEye?: Vec3;
};

/**
 * World matrix (layer pixels → world) of a 3D layer at content time `t`: its 2D Motion (position, anchor, scale,
 * rotation as Z rotation, flips) extended with Z position / anchor / scale, Orientation and X/Y rotation, and
 * Auto-Orient. For a 2D clip (no `threeD`), the 2D Motion embedded in the z = 0 plane.
 */
export function layerWorldMatrix(
	clip: Pick<RenderVisualClip, 'transform' | 'threeD'>,
	t: number,
	ctx: Layer3DContext = {},
): Matrix4 {
	const tr = clip.transform;
	const td = clip.threeD;
	if (!tr) return MAT4_IDENTITY;
	const anchor = evaluate(tr.anchor, t) as Vec2;
	const scale = num(tr.scale, t, 100);
	const scaleWidth = num(tr.scaleWidth, t, 100);
	const sx = ((tr.uniformScale ? scale : scaleWidth) / 100) * (tr.flipH ? -1 : 1);
	const sy = (scale / 100) * (tr.flipV ? -1 : 1);
	const position = layerPosition3D(clip, t);
	const rz = num(tr.rotation, t, 0);
	const a: Vec3 = [finiteOr(anchor?.[0], 0), finiteOr(anchor?.[1], 0), num(td?.anchorZ, t, 0)];
	const sz = num(td?.scaleZ, t, 100) / 100;
	let orient: Matrix4 = td ? orientationMatrixAt(td.orientation, t) : MAT4_IDENTITY;
	const auto = td?.autoOrient ?? 'off';
	if (auto === 'path') {
		const pa = layerPosition3D(clip, t - PATH_DT);
		const pb = layerPosition3D(clip, t + PATH_DT);
		const d = sub3(pb, pa);
		if (len3(d) > 1e-9) {
			const x = norm3(d);
			// x = tangent, y ≈ down, z = x × y.
			let y = sub3([0, 1, 0], scale3(x, x[1]));
			if (len3(y) < 1e-9) y = sub3([0, 0, 1], scale3(x, x[2]));
			y = norm3(y);
			const z = cross3(x, y);
			orient = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1];
		}
	} else if (auto === 'camera' && ctx.cameraEye) {
		const d = sub3(position, ctx.cameraEye);
		if (len3(d) > 1e-9) orient = basisRotation(d, [0, 1, 0]);
	}
	return mat4MulAll(
		mat4Translate(position),
		orient,
		mat4RotateZ(rz),
		mat4RotateY(num(td?.rotationY, t, 0)),
		mat4RotateX(num(td?.rotationX, t, 0)),
		[sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1],
		mat4Translate([-a[0], -a[1], -a[2]]),
	);
}

export { layerMatrix3D };

/**
 * The projective map (layer pixels → frame pixels) of a plane at `world` seen through `cam`, or null when the
 * plane is seen edge-on (a line) — for overlays, picking and the 2D fallback.
 */
export function planeHomography(cam: CameraState, w: number, h: number, world: Matrix4): Mat3 | null {
	const m = planeToMat3(mat4Mul(cameraProjection(cam, w, h), world));
	const col = (j: number) => Math.hypot(m[j]!, m[3 + j]!, m[6 + j]!);
	const det =
		m[0] * (m[4] * m[8] - m[5] * m[7]) -
		m[1] * (m[3] * m[8] - m[5] * m[6]) +
		m[2] * (m[3] * m[7] - m[4] * m[6]);
	if (!(Math.abs(det) > 1e-10 * col(0) * col(1) * col(2))) return null;
	return m;
}

/** Unit world normal of a plane (its +z side: the side facing away from a default-placed viewer). */
export function planeNormal(world: Matrix4): Vec3 {
	return norm3(cross3(mat4ApplyVec(world, [1, 0, 0]), mat4ApplyVec(world, [0, 1, 0])));
}

/** World → layer of a plane (identity when singular). */
export function invertWorld(world: Matrix4): Matrix4 {
	return mat4Invert(world) ?? MAT4_IDENTITY;
}

// ---------------------------------------------------------------- 3D runs

/** One drawn item of a track at a frame, in drawing order (the inputs of `runs3dAt`). */
export type StackItem = { key: string; trackIndex: number; is3d: boolean };

/**
 * The 3D runs of a layer stack (bottom → top): maximal sequences of consecutive 3D layers. A 2D layer (adjustment
 * layers, transition stages and mattes included) breaks a run, as in After Effects. Each run is drawn by the
 * 3D renderer of its top layer's track.
 */
export function runs3d(stack: readonly StackItem[]): { members: string[]; topTrack: number }[] {
	const out: { members: string[]; topTrack: number }[] = [];
	let cur: StackItem[] = [];
	const flush = () => {
		if (cur.length) out.push({ members: cur.map((x) => x.key), topTrack: cur[cur.length - 1]!.trackIndex });
		cur = [];
	};
	for (const it of stack) {
		if (it.is3d) cur.push(it);
		else flush();
	}
	flush();
	return out;
}

/** Whether a render clip is drawn at a sequence frame (handles included). */
export function clipDrawnAt(
	c: Pick<RenderVisualClip, 'start' | 'duration' | 'headHandle' | 'tailHandle'>,
	f: number,
): boolean {
	return f >= c.start - (c.headHandle ?? 0) && f < c.start + c.duration + (c.tailHandle ?? 0);
}

/**
 * The layer stack of a snapshot's video tracks at a frame (bottom → top: per track its transition mattes, its
 * clips, its transition stages; layer bakes count as their clip) — what `runs3d` splits. Tracks of the stack that
 * are hidden mattes are not drawn and not included.
 */
export function stackAt(
	tracks: RenderSnapshot['videoTracks'],
	frame: number,
	opts: { layerFilter?: readonly string[] } = {},
): StackItem[] {
	const out: StackItem[] = [];
	tracks.forEach((t, trackIndex) => {
		if (!opts.layerFilter)
			for (const m of t.mattes ?? [])
				if (frame >= m.start && frame < m.start + m.duration)
					out.push({ key: `matte:${m.id}`, trackIndex, is3d: false });
		for (const c of t.clips) {
			if (opts.layerFilter && !opts.layerFilter.includes(c.clipId)) continue;
			if (!clipDrawnAt(c, frame)) continue;
			out.push({ key: c.clipId, trackIndex, is3d: !!c.threeD && c.kind !== 'adjustment' });
		}
		if (!opts.layerFilter)
			for (const st of t.transitions ?? [])
				if (frame >= st.start && frame < st.start + st.duration)
					out.push({ key: `transition:${st.id}`, trackIndex, is3d: false });
	});
	return out;
}

/** World-space centre of a layer's box (anchor-independent): for sorting, pick and camera tools. */
export function layerCentre3D(world: Matrix4, box: { width: number; height: number }): Vec3 {
	return mat4Apply(world, [box.width / 2, box.height / 2, 0]);
}
