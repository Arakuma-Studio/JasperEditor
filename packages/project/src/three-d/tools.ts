// three-d: the camera tools (orbit, pan, dolly) and the Program monitor's 3D views — the math shared by the
// commands, the Program monitor and the agents. Port of EffectCraft `render/three_d/camera.rs` (Rig, View3D;
// MIT OR Apache-2.0).
import type { Vec3 } from '../schema/common.ts';
import {
	add3,
	basisView,
	len3,
	mat4ApplyVec,
	mat4RotateX,
	mat4RotateY,
	norm3,
	scale3,
	sub3,
} from './math.ts';
import { defaultCameraZoom } from './model.ts';
import { type CameraState, lookAtCamera } from './scene.ts';

/** A camera as the tools edit it: eye, point of interest, zoom. */
export type Rig = { eye: Vec3; poi: Vec3; zoom: number; ortho: boolean };

function frame(r: Rig): { fwd: Vec3; right: Vec3; down: Vec3 } {
	const v = basisView(r.eye, sub3(r.poi, r.eye), [0, 1, 0]);
	return { right: [v[0]!, v[1]!, v[2]!], down: [v[4]!, v[5]!, v[6]!], fwd: [v[8]!, v[9]!, v[10]!] };
}

/** Orbit the eye about the point of interest: `yaw` about world Y, `pitch` about the camera's right axis (°). */
export function orbitRig(r: Rig, yaw: number, pitch: number): Rig {
	if (r.ortho) return r;
	const off = sub3(r.eye, r.poi);
	const dist = Math.max(1e-6, len3(off));
	const curPitch = (Math.asin(Math.min(1, Math.max(-1, off[1] / dist))) * 180) / Math.PI;
	const newPitch = Math.min(89, Math.max(-89, curPitch + pitch));
	const hl = Math.hypot(off[0], off[2]);
	const az = (hl > 1e-9 ? (Math.atan2(off[0], -off[2]) * 180) / Math.PI : 0) + yaw;
	const sp = Math.sin((newPitch * Math.PI) / 180);
	const cp = Math.cos((newPitch * Math.PI) / 180);
	const sa = Math.sin((az * Math.PI) / 180);
	const ca = Math.cos((az * Math.PI) / 180);
	return { ...r, eye: add3(r.poi, scale3([sa * cp, sp, -ca * cp], dist)) };
}

/** Pan in the image plane by (dx, dy) frame pixels as seen at the point of interest. */
export function panRig(r: Rig, dx: number, dy: number): Rig {
	const { right, down } = frame(r);
	const k = r.ortho ? 1 / Math.max(1e-9, r.zoom) : len3(sub3(r.poi, r.eye)) / Math.max(1e-9, r.zoom);
	const delta = add3(scale3(right, -dx * k), scale3(down, -dy * k));
	return { ...r, eye: add3(r.eye, delta), poi: add3(r.poi, delta) };
}

/**
 * Dolly along the view by `amount` pixels (positive = towards the point of interest). `withPoi`: the point of
 * interest travels too (Track Z); else the eye stops 1 px short of it. Orthographic views scale instead.
 */
export function dollyRig(r: Rig, amount: number, withPoi: boolean): Rig {
	if (r.ortho) return { ...r, zoom: Math.min(100, Math.max(0.01, r.zoom * Math.exp(amount / 500))) };
	const { fwd } = frame(r);
	if (withPoi) return { ...r, eye: add3(r.eye, scale3(fwd, amount)), poi: add3(r.poi, scale3(fwd, amount)) };
	const dist = len3(sub3(r.poi, r.eye));
	return { ...r, eye: add3(r.eye, scale3(fwd, Math.min(amount, dist - 1))) };
}

// ---------------------------------------------------------------- 3D views

/** The Program monitor's 3D views (AE View ▸ Switch 3D View). */
export const VIEWS_3D = [
	'activeCamera',
	'default',
	'front',
	'left',
	'top',
	'back',
	'right',
	'bottom',
	'custom1',
	'custom2',
	'custom3',
] as const;
export type View3D = (typeof VIEWS_3D)[number];
export const VIEW_3D_LABELS: Record<View3D, string> = {
	activeCamera: 'Active Camera',
	default: 'Default',
	front: 'Front',
	left: 'Left',
	top: 'Top',
	back: 'Back',
	right: 'Right',
	bottom: 'Bottom',
	custom1: 'Custom View 1',
	custom2: 'Custom View 2',
	custom3: 'Custom View 3',
};
export const isOrthoView = (v: View3D) =>
	v === 'front' || v === 'left' || v === 'top' || v === 'back' || v === 'right' || v === 'bottom';

/** A view camera (eye, point of interest, down hint, zoom / ortho scale). */
export type ViewCam = { eye: Vec3; poi: Vec3; down: Vec3; zoom: number; ortho: boolean };

/** The default camera of a view for a w×h frame. */
export function defaultViewCam(v: View3D, w: number, h: number): ViewCam {
	const c: Vec3 = [w / 2, h / 2, 0];
	const zoom = defaultCameraZoom(w);
	const far = 10_000;
	const ortho = (fwd: Vec3, down: Vec3): ViewCam => ({
		eye: sub3(c, scale3(fwd, far)),
		poi: c,
		down,
		zoom: 0.5,
		ortho: true,
	});
	const custom = (yaw: number, pitch: number): ViewCam => {
		const off = mat4ApplyVec(mat4RotateY(yaw), mat4ApplyVec(mat4RotateX(pitch), [0, 0, -zoom * 1.6]));
		return { eye: add3(c, off), poi: c, down: [0, 1, 0], zoom, ortho: false };
	};
	switch (v) {
		case 'activeCamera':
		case 'front':
			return ortho([0, 0, 1], [0, 1, 0]);
		case 'back':
			return ortho([0, 0, -1], [0, 1, 0]);
		case 'left':
			return ortho([1, 0, 0], [0, 1, 0]);
		case 'right':
			return ortho([-1, 0, 0], [0, 1, 0]);
		case 'top':
			return ortho([0, 1, 0], [0, 0, -1]);
		case 'bottom':
			return ortho([0, -1, 0], [0, 0, 1]);
		case 'custom1':
			return custom(30, -20);
		case 'custom2':
			return custom(0, -35);
		case 'custom3':
			return custom(-30, -20);
		default:
			return { eye: [w / 2, h / 2, -zoom], poi: c, down: [0, 1, 0], zoom, ortho: false };
	}
}

/** The camera of a view camera. */
export function viewCamState(v: ViewCam): CameraState {
	return lookAtCamera(v.eye, v.poi, v.zoom, v.ortho, v.down);
}

/** A rig from a view camera, and back. */
export const rigOfView = (v: ViewCam): Rig => ({ eye: v.eye, poi: v.poi, zoom: v.zoom, ortho: v.ortho });
export const viewOfRig = (r: Rig, down: Vec3 = [0, 1, 0]): ViewCam => ({ ...r, down });

/** Unit view direction of a rig. */
export function rigForward(r: Rig): Vec3 {
	return norm3(sub3(r.poi, r.eye));
}
