// The 3D Camera Tracker in the project model (three-d, docs/wp-notes/three-d.md): reading a camera solve, the map
// from the solve's canonical space to the sequence's 3D world, the solved camera of a frame, track points for the
// overlay, ground planes and targets. The solve itself comes from the engine (`camtrack` jobs).
//
// World map. The solve is in a canonical space (the first solved camera at the origin looking along +z, x right,
// y down, median point depth 1). The tracked clip is drawn by its 2D Motion; for the picture to line up with 3D layers
// seen through the created camera, the camera's principal point must be the frame centre and its zoom the solved focal
// length times the clip's Motion scale (sequence px per media px). Without a ground plane the first solved camera
// becomes After Effects' default camera — at (w/2, h/2, −zoom) looking along +z — and one solve unit is `zoom` pixels,
// so the median depth of the points lands on the z = 0 plane at 100 %. With a ground plane, the plane becomes the
// world's horizontal plane (y = h/2 + 0, y down, its normal pointing down) through the target point at (w/2, h/2, 0).
import type { Vec3 } from '../schema/common.ts';
import type {
	CameraSolve,
	CameraTrackerGround,
	CameraTrackerSettings,
	ClipCameraTracker,
} from '../schema/three-d.ts';
import { cross3, dot3, len3, type Matrix4, norm3, orientationOfMat4, scale3, sub3 } from './math.ts';

/** 3×3 matrix as rows. */
export type M3 = [Vec3, Vec3, Vec3];

export type ResolvedCameraTrackerSettings = Required<CameraTrackerSettings>;

export function cameraTrackerSettingsOf(s: CameraTrackerSettings | undefined): ResolvedCameraTrackerSettings {
	return {
		shot: s?.shot ?? 'fixed',
		hfov: s?.hfov ?? 40,
		method: s?.method ?? 'auto',
		detailed: s?.detailed ?? false,
		lensDistortion: s?.lensDistortion ?? false,
		showPoints: s?.showPoints ?? '3d',
		pointSize: s?.pointSize ?? 100,
		targetSize: s?.targetSize ?? 100,
	};
}

/** Fingerprint of what a solve depends on (span, solve settings, deleted points): a solve with other inputs is stale. */
export function cameraTrackerInputs(
	t: Pick<ClipCameraTracker, 'span' | 'settings' | 'deleted' | 'mediaId'>,
): string {
	const s = cameraTrackerSettingsOf(t.settings);
	const key = JSON.stringify([
		t.mediaId,
		t.span,
		s.shot,
		s.shot === 'specify' ? s.hfov : 0,
		s.method,
		s.detailed,
		s.lensDistortion,
		[...t.deleted].sort((a, b) => a - b),
	]);
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
	return `ct1-${h.toString(16).padStart(8, '0')}`;
}

export const isSolveStale = (t: ClipCameraTracker) => !!t.solve && t.solve.inputs !== cameraTrackerInputs(t);

// ---------------------------------------------------------------- rotations

const mv = (m: M3, v: Vec3): Vec3 => [dot3(m[0], v), dot3(m[1], v), dot3(m[2], v)];
const transpose = (m: M3): M3 => [
	[m[0][0], m[1][0], m[2][0]],
	[m[0][1], m[1][1], m[2][1]],
	[m[0][2], m[1][2], m[2][2]],
];
function mm(a: M3, b: M3): M3 {
	const bt = transpose(b);
	return [0, 1, 2].map((i) => [dot3(a[i]!, bt[0]), dot3(a[i]!, bt[1]), dot3(a[i]!, bt[2])]) as M3;
}

/** Rotation matrix of an axis-angle vector (Rodrigues). */
export function rodrigues(w: Vec3): M3 {
	const th = len3(w);
	if (th < 1e-12)
		return [
			[1, -w[2], w[1]],
			[w[2], 1, -w[0]],
			[-w[1], w[0], 1],
		];
	const k = scale3(w, 1 / th);
	const c = Math.cos(th);
	const s = Math.sin(th);
	const v = 1 - c;
	return [
		[c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
		[k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
		[k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
	];
}

const mat4Of = (m: M3): Matrix4 => [...m[0], 0, ...m[1], 0, ...m[2], 0, 0, 0, 0, 1];

// ---------------------------------------------------------------- the solve

/** The solved camera of a media frame (canonical space): world → camera rotation rows, centre, focal (media px). */
export type SolvedCamera = { r: M3; c: Vec3; f: number; solved: boolean };

export const solveFrameCount = (s: Pick<CameraSolve, 'frames'>) => Math.floor(s.frames.length / 8);

/** The solved camera at a media frame (clamped to the span), or null without frames. */
export function solvedCameraAt(
	s: Pick<CameraSolve, 'frames' | 'span'>,
	mediaFrame: number,
): SolvedCamera | null {
	const n = solveFrameCount(s);
	if (n === 0) return null;
	const k = Math.min(n - 1, Math.max(0, Math.round(mediaFrame) - s.span[0]));
	const f = s.frames.slice(k * 8, k * 8 + 8);
	if (!f.every(Number.isFinite)) return null;
	return { r: rodrigues([f[0]!, f[1]!, f[2]!]), c: [f[3]!, f[4]!, f[5]!], f: f[6]!, solved: f[7] === 1 };
}

/** The first solved frame's camera (the canonical frame's reference). */
function referenceCamera(s: Pick<CameraSolve, 'frames' | 'span'>): SolvedCamera | null {
	const n = solveFrameCount(s);
	for (let k = 0; k < n; k++) if (s.frames[k * 8 + 7] === 1) return solvedCameraAt(s, s.span[0] + k);
	return n > 0 ? solvedCameraAt(s, s.span[0]) : null;
}

/** Ideal → distorted image point (media px from the principal point). */
export function distortPoint(d: CameraSolve['distortion'], p: [number, number]): [number, number] {
	if (!d || d.radius <= 0) return p;
	const r2 = (p[0] * p[0] + p[1] * p[1]) / (d.radius * d.radius);
	const k = 1 + d.k1 * r2 + d.k2 * r2 * r2;
	return [p[0] * k, p[1] * k];
}

/** A track point seen at a frame: media px, camera depth (solve units) and its error. */
export type ProjectedTrackPoint = { id: number; uv: [number, number]; depth: number; error: number };

/** The live (not deleted) track points of a solve tracked at a media frame, projected through the solved camera. */
export function trackPointsAt(
	t: Pick<ClipCameraTracker, 'solve' | 'deleted'>,
	mediaFrame: number,
): ProjectedTrackPoint[] {
	const s = t.solve;
	if (!s) return [];
	const cam = solvedCameraAt(s, mediaFrame);
	if (!cam) return [];
	const gone = new Set(t.deleted);
	const out: ProjectedTrackPoint[] = [];
	for (const p of s.points) {
		if (gone.has(p.id) || mediaFrame < p.first || mediaFrame > p.last) continue;
		const q = mv(cam.r, sub3(p.pos, cam.c));
		if (q[2] <= 1e-9) continue;
		const d = distortPoint(s.distortion, [(cam.f * q[0]) / q[2], (cam.f * q[1]) / q[2]]);
		out.push({ id: p.id, uv: [d[0] + s.size[0] / 2, d[1] + s.size[1] / 2], depth: q[2], error: p.error });
	}
	return out;
}

// ---------------------------------------------------------------- canonical → world

/** World = s · R · x + t (sequence px, z away from the viewer); `zoomScale` = sequence px per media px. */
export type SolveMapping = { s: number; r: M3; t: Vec3; zoomScale: number };

/**
 * The map of a solve into the sequence's world for a clip drawn at `zoomScale` sequence px per media px in a
 * `width × height` frame (see the module comment).
 */
export function solveMapping(
	t: Pick<ClipCameraTracker, 'solve' | 'ground'>,
	frame: { width: number; height: number },
	zoomScale: number,
): SolveMapping | null {
	const s = t.solve;
	if (!s) return null;
	const ref = referenceCamera(s);
	if (!ref) return null;
	const zoom0 = ref.f * zoomScale;
	const scale = s.methodUsed === 'tripod' ? zoom0 * 4 : zoom0;
	const g = t.ground;
	if (!g) {
		// The reference camera is canonical (identity at the origin): put it where AE's default camera is.
		const r = ref.r;
		const c = ref.c;
		// World = s · R0 · (x − C0) + eye0 makes the reference camera the default camera even if not exactly canonical.
		const eye: Vec3 = [frame.width / 2, frame.height / 2, -zoom0];
		const rc = mv(r, c);
		return { s: scale, r, t: sub3(eye, scale3(rc, scale)), zoomScale };
	}
	const x = norm3(g.xAxis);
	const y = norm3(g.normal);
	const z = norm3(cross3(x, y));
	const r: M3 = [x, y, z];
	const centre: Vec3 = [frame.width / 2, frame.height / 2, 0];
	return { s: scale, r, t: sub3(centre, scale3(mv(r, g.origin), scale)), zoomScale };
}

export const toWorld = (m: SolveMapping, x: Vec3): Vec3 => {
	const p = mv(m.r, x);
	return [m.s * p[0] + m.t[0], m.s * p[1] + m.t[1], m.s * p[2] + m.t[2]];
};

/** A camera in the world: eye, camera → world rotation (columns = right, down, forward), zoom (sequence px). */
export type WorldCamera = { eye: Vec3; rotation: M3; zoom: number; orientation: Vec3 };

export function worldCameraOf(m: SolveMapping, cam: SolvedCamera): WorldCamera {
	// x = Rmᵀ (X − t) / s; camera space = R (x − C) = R Rmᵀ (X − (s Rm C + t)) / s.
	const toCam = mm(cam.r, transpose(m.r));
	const rotation = transpose(toCam);
	return {
		eye: toWorld(m, cam.c),
		rotation,
		zoom: cam.f * m.zoomScale,
		orientation: orientationOfMat4(mat4Of(rotation)),
	};
}

// ---------------------------------------------------------------- planes from track points

/** Least-squares plane of points: centroid and unit normal (smallest covariance eigenvector), or null when < 3. */
export function fitPlane(p: readonly Vec3[]): { c: Vec3; n: Vec3 } | null {
	if (p.length < 3) return null;
	const c = scale3(
		p.reduce((a, q) => [a[0] + q[0], a[1] + q[1], a[2] + q[2]] as Vec3, [0, 0, 0] as Vec3),
		1 / p.length,
	);
	const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	for (const q of p) {
		const d = sub3(q, c);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i * 3 + j]! += d[i]! * d[j]!;
	}
	// Smallest eigenvector by inverse power iteration on the (regularised) covariance.
	const tr = a[0]! + a[4]! + a[8]!;
	if (!(tr > 0)) return null;
	const m: M3 = [
		[a[0]! + tr * 1e-9, a[1]!, a[2]!],
		[a[3]!, a[4]! + tr * 1e-9, a[5]!],
		[a[6]!, a[7]!, a[8]! + tr * 1e-9],
	];
	const inv = invert3(m);
	if (!inv) return null;
	let v: Vec3 = norm3([0.31, 0.57, 0.76]);
	for (let i = 0; i < 60; i++) v = norm3(mv(inv, v));
	return { c, n: v };
}

function invert3(m: M3): M3 | null {
	const [a, b, c] = m;
	const det =
		a[0] * (b[1] * c[2] - b[2] * c[1]) -
		a[1] * (b[0] * c[2] - b[2] * c[0]) +
		a[2] * (b[0] * c[1] - b[1] * c[0]);
	if (Math.abs(det) < 1e-300) return null;
	const k = 1 / det;
	return [
		[(b[1] * c[2] - b[2] * c[1]) * k, (a[2] * c[1] - a[1] * c[2]) * k, (a[1] * b[2] - a[2] * b[1]) * k],
		[(b[2] * c[0] - b[0] * c[2]) * k, (a[0] * c[2] - a[2] * c[0]) * k, (a[2] * b[0] - a[0] * b[2]) * k],
		[(b[0] * c[1] - b[1] * c[0]) * k, (a[1] * c[0] - a[0] * c[1]) * k, (a[0] * b[1] - a[1] * b[0]) * k],
	];
}

/**
 * The target of selected track points (canonical space): centre and unit normal pointing away from the camera that
 * sees it (a layer facing the camera). Three or more points define a plane; with one or two the target faces the
 * camera.
 */
export function targetOf(points: readonly Vec3[], cam: SolvedCamera): { c: Vec3; n: Vec3 } | null {
	if (points.length === 0) return null;
	const plane = fitPlane(points);
	const c =
		plane?.c ??
		scale3(
			points.reduce((a, q) => [a[0] + q[0], a[1] + q[1], a[2] + q[2]] as Vec3, [0, 0, 0] as Vec3),
			1 / points.length,
		);
	const fwd: Vec3 = cam.r[2];
	let n = plane?.n ?? fwd;
	if (dot3(n, sub3(c, cam.c)) < 0) n = scale3(n, -1);
	return { c, n };
}

/** A ground plane from track points: the plane, its normal pointing away from the camera, x along the camera's right. */
export function groundOf(points: readonly Vec3[], cam: SolvedCamera): CameraTrackerGround | null {
	const plane = fitPlane(points);
	if (!plane) return null;
	let n = plane.n;
	if (dot3(n, sub3(plane.c, cam.c)) < 0) n = scale3(n, -1);
	const right: Vec3 = cam.r[0];
	let x = sub3(right, scale3(n, dot3(right, n)));
	if (len3(x) < 1e-6) x = norm3(cross3(n, cam.r[2]));
	return { origin: plane.c, normal: n, xAxis: norm3(x) };
}

/** Orientation (degrees) of a layer lying in a world plane with normal `n` (facing away) and x along `right`. */
export function layerOrientationFor(n: Vec3, right: Vec3): Vec3 {
	const z = norm3(n);
	let x = sub3(right, scale3(z, dot3(right, z)));
	if (len3(x) < 1e-6) x = norm3(cross3([0, 1, 0], z));
	x = norm3(x);
	const y = cross3(z, x);
	const rot: M3 = [
		[x[0], y[0], z[0]],
		[x[1], y[1], z[1]],
		[x[2], y[2], z[2]],
	];
	return orientationOfMat4(mat4Of(rot));
}

/** World direction of a canonical direction (rotation only). */
export const dirToWorld = (m: SolveMapping, d: Vec3): Vec3 => norm3(mv(m.r, d));

// ---------------------------------------------------------------- engine requests

/** Where a clip's 3D Camera Tracker is, or null. */
export function findCameraTracker(
	doc: { sequences: Record<string, { id: string; clips: Record<string, unknown> }> },
	clipId: string,
): { sequenceId: string; tracker: ClipCameraTracker } | null {
	for (const seq of Object.values(doc.sequences)) {
		const c = seq.clips[clipId] as { cameraTracker?: ClipCameraTracker } | undefined;
		if (c?.cameraTracker) return { sequenceId: seq.id, tracker: c.cameraTracker };
	}
	return null;
}

/** The body of `POST /api/camtrack/solve` for a clip's tracker (the client adds `projectId`). Throws when impossible. */
export function cameraTrackerSolveBody(
	doc: {
		sequences: Record<string, { id: string; clips: Record<string, unknown> }>;
		media: Record<string, { locators: readonly { type: string; key?: string }[] } | undefined>;
	},
	clipId: string,
): {
	mediaKey: string;
	clipId: string;
	trackerId: string;
	span: [number, number];
	settings: {
		shot: 'fixed' | 'variable' | 'specify';
		hfov: number;
		method: 'auto' | 'typical' | 'flat' | 'tripod';
		detailed: boolean;
		lensDistortion: boolean;
	};
	deleted: number[];
	inputs: string;
} {
	const loc = findCameraTracker(doc, clipId);
	if (!loc) throw new Error('The clip has no 3D Camera Tracker');
	const t = loc.tracker;
	const asset = doc.media[t.mediaId];
	const store = asset?.locators.find((l) => l.type === 'engine-store');
	if (!store?.key) throw new Error('The clip’s media is not on the engine (import it first)');
	const s = cameraTrackerSettingsOf(t.settings);
	return {
		mediaKey: store.key,
		clipId,
		trackerId: t.id,
		span: [t.span[0], t.span[1]],
		settings: {
			shot: s.shot,
			hfov: s.hfov,
			method: s.method,
			detailed: s.detailed,
			lensDistortion: s.lensDistortion,
		},
		deleted: [...t.deleted],
		inputs: cameraTrackerInputs(t),
	};
}
