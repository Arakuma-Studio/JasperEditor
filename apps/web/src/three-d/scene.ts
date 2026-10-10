// three-d in the Program monitor: the camera the monitor shows (the active camera, or the selected 3D view's), the
// resolved scene through it (overlays, picking, masks), and the screen-space move of a 3D layer (After Effects moves
// it in the plane facing the camera, so it follows the pointer exactly).
import type { RenderDoc } from '@jasper/compositions';
import {
	activeCameraAt,
	type CameraState,
	cameraDown,
	cameraRight,
	clipContentTime,
	evaluate,
	type LayerTransformValues,
	layerWorldMatrix,
	lookAtCamera,
	mat4Apply,
	type RenderVisualClip,
	type ResolvedLayer,
	resolveSceneAt,
	type Vec3,
} from '@jasper/project';
import { viewCamOf, viewsOf } from './view-store.ts';

/** The camera of the Program monitor at a frame: the selected 3D view's, else the sequence's active camera. */
export function programCamera(doc: RenderDoc, frame: number): CameraState {
	const v = viewsOf(doc.sequenceId).view;
	const cam = viewCamOf(doc.sequenceId, v, doc.settings.width, doc.settings.height);
	return cam ? lookAtCamera(cam.eye, cam.poi, cam.zoom, cam.ortho, cam.down) : activeCameraAt(doc, frame);
}

/** `resolveSceneAt` through the Program monitor's camera (3D layers projected as shown). */
export function resolveProgramScene(doc: RenderDoc, frame: number): ResolvedLayer[] {
	const has3d = doc.videoTracks.some((t) => t.clips.some((c) => c.threeD));
	return has3d
		? resolveSceneAt(doc, frame, { camera: programCamera(doc, frame) })
		: resolveSceneAt(doc, frame);
}

export const is3dLayer = (l: { clip: Pick<RenderVisualClip, 'threeD' | 'kind'> }) =>
	!!l.clip.threeD && l.clip.kind !== 'adjustment';

/** What a 3D move needs at its start: the anchor's world position and the camera's screen axes at its depth. */
export type Move3D = { p0: Vec3; right: Vec3; down: Vec3; k: number };

export function move3dStart(
	doc: RenderDoc,
	clip: RenderVisualClip,
	frame: number,
	v0: LayerTransformValues,
): Move3D {
	const cam = programCamera(doc, frame);
	const t = clipContentTime(clip, frame, doc.settings.fps);
	const z = Number(evaluate(clip.threeD!.positionZ, t)) || 0;
	const p0: Vec3 = [v0.position[0], v0.position[1], z];
	// The anchor sits at Position: its camera depth sets the pixels-per-world-unit there.
	const depth = mat4Apply(cam.view, p0)[2];
	const k = cam.ortho ? 1 / Math.max(1e-9, cam.zoom) : Math.max(1, depth) / Math.max(1e-9, cam.zoom);
	void layerWorldMatrix;
	return { p0, right: cameraRight(cam), down: cameraDown(cam), k };
}

/** New (x, y, z) Position after a screen move of (dx, dy) frame pixels. */
export function move3dPosition(m: Move3D, dx: number, dy: number): Vec3 {
	return [
		m.p0[0] + (m.right[0] * dx + m.down[0] * dy) * m.k,
		m.p0[1] + (m.right[1] * dx + m.down[1] * dy) * m.k,
		m.p0[2] + (m.right[2] * dx + m.down[2] * dy) * m.k,
	];
}
