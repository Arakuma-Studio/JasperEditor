// Synthetic cameras make solve-to-world projection checks exact up to rounding.
import { describe, expect, it } from 'vitest';
import {
	activeCameraAt,
	buildRenderSnapshot,
	type CameraClip,
	type Clip,
	type ClipCameraTracker,
	checkInvariants,
	createCounterIdSource,
	FLICKS_PER_SECOND,
	isSolveStale,
	layerWorldMatrix,
	type MediaHandle,
	projectPoint,
	repairDocument,
	rodrigues,
	solveMapping,
	toWorld,
	trackPointsAt,
	type Vec3,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type TClip = Clip & { cameraTracker?: ClipCameraTracker };

const media = (): MediaHandle => ({
	url: 'x',
	proxyUrl: null,
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: 4 * FLICKS_PER_SECOND,
	hasAudio: false,
	rotation: 0,
});

function setup() {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 4, audio: false });
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 3 } },
		},
	]);
	const clipId = h.clips('V1')[0]!.id;
	return { h, m, clipId, clip: () => h.seq.clips[clipId] as TClip };
}

const F = 1500;
/** Canonical camera of media frame `m` of span [30, 89]: a dolly right / forward with a slow pan. */
function cam(m: number): { w: Vec3; c: Vec3 } {
	const k = m - 30;
	return { w: [0, -0.002 * k, 0.0005 * k], c: [0.01 * k, -0.002 * k, 0.004 * k] };
}
const POINTS: { id: number; pos: Vec3 }[] = [];
for (let i = 0; i < 40; i++)
	POINTS.push({
		id: i * 3 + 1,
		pos: [-0.5 + ((i * 37) % 100) / 100, -0.3 + ((i * 53) % 60) / 100, 0.8 + ((i * 29) % 50) / 100],
	});
// Three coplanar ground points (y = 0.35) for targets / ground planes.
const GROUND = [
	{ id: 500, pos: [-0.2, 0.35, 1.0] as Vec3 },
	{ id: 501, pos: [0.3, 0.35, 1.1] as Vec3 },
	{ id: 502, pos: [0.0, 0.35, 1.4] as Vec3 },
];

function solve() {
	const frames: number[] = [];
	for (let m = 30; m <= 89; m++) {
		const c = cam(m);
		frames.push(...c.w, ...c.c, F, 1);
	}
	return {
		span: [30, 89] as [number, number],
		size: [1920, 1080] as [number, number],
		shot: 'fixed' as const,
		methodUsed: 'typical' as const,
		averageError: 0.2,
		frames,
		points: [...POINTS, ...GROUND].map((p) => ({ ...p, error: 0.1, first: 30, last: 89 })),
		distortion: null,
		method: 'camtrack@1',
	};
}

/** Pixel of a canonical point seen by the canonical camera of media frame m. */
function truthUv(m: number, p: Vec3): [number, number] {
	const c = cam(m);
	const r = rodrigues(c.w);
	const d: Vec3 = [p[0] - c.c[0], p[1] - c.c[1], p[2] - c.c[2]];
	const q = r.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]) as Vec3;
	return [(F * q[0]) / q[2] + 960, (F * q[1]) / q[2] + 540];
}

const snap = (h: Harness) =>
	buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: media, resolveFont: () => 'f.woff2' });

describe('cameraTracker commands', () => {
	it('applies to a video clip with the shown media frames as the span; refuses other clips and a second tracker', () => {
		const { h, clipId, clip } = setup();
		const r = h.ok([{ type: 'cameraTracker.add', clipId, shot: 'specify', hfov: 50 }]);
		expect(r.results[0]).toMatchObject({ span: [30, 89] });
		expect(clip().cameraTracker).toMatchObject({
			span: [30, 89],
			settings: { shot: 'specify', hfov: 50 },
			solve: null,
		});
		expect(h.tx([{ type: 'cameraTracker.add', clipId }]).ok).toBe(false);
		const solid = h.ok([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 1, 1, 1] }])
			.results[0] as {
			clipId: string;
		};
		const bad = h.tx([{ type: 'cameraTracker.add', clipId: solid.clipId }]);
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(h.tx([{ type: 'cameraTracker.add', clipId, span: [5, 5] }]).ok).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('commits a solve; deleting points or changing settings makes it stale; another span drops it', () => {
		const { h, clipId, clip } = setup();
		h.ok([{ type: 'cameraTracker.add', clipId }]);
		const before = h.doc;
		h.ok([{ type: 'cameraTracker.setResult', clipId, solve: solve() }]);
		expect((before.sequences[h.seqId]!.clips[clipId] as TClip).cameraTracker!.solve).toBeNull();
		expect(isSolveStale(clip().cameraTracker!)).toBe(false);
		const wrong = { ...solve(), frames: solve().frames.slice(8) };
		expect(h.tx([{ type: 'cameraTracker.setResult', clipId, solve: wrong }]).ok).toBe(false);
		h.ok([{ type: 'cameraTracker.deletePoints', clipId, pointIds: [1, 4] }]);
		expect(isSolveStale(clip().cameraTracker!)).toBe(true);
		expect(trackPointsAt(clip().cameraTracker!, 40).some((p) => p.id === 1 || p.id === 4)).toBe(false);
		h.ok([{ type: 'cameraTracker.settings', clipId, span: [30, 80] }]);
		expect(clip().cameraTracker!.solve).toBeNull();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('projects the track points of a frame through the solved camera', () => {
		const { h, clipId, clip } = setup();
		h.ok([
			{ type: 'cameraTracker.add', clipId },
			{ type: 'cameraTracker.setResult', clipId, solve: solve() },
		]);
		const pts = trackPointsAt(clip().cameraTracker!, 55);
		expect(pts.length).toBe(POINTS.length + GROUND.length);
		for (const p of pts.slice(0, 5)) {
			const src = [...POINTS, ...GROUND].find((q) => q.id === p.id)!;
			const uv = truthUv(55, src.pos);
			expect(p.uv[0]).toBeCloseTo(uv[0], 3);
			expect(p.uv[1]).toBeCloseTo(uv[1], 3);
		}
	});

	it('Create Camera: the camera sees every track point where the footage shows it', () => {
		const { h, clipId, clip } = setup();
		h.ok([
			{ type: 'cameraTracker.add', clipId },
			{ type: 'cameraTracker.setResult', clipId, solve: solve() },
		]);
		const r = h.ok([{ type: 'cameraTracker.create', clipId }]).results[0] as {
			cameraClipId: string;
			keys: number;
		};
		expect(r.keys).toBe(60);
		const camClip = h.seq.clips[r.cameraClipId] as CameraClip;
		expect(camClip.camera.transform.autoOrient).toBe('off');
		expect(camClip.camera.transform.position.keyframes.length).toBe(60);
		expect(clip().cameraTracker!.createdCameraId).toBe(r.cameraClipId);
		const s = snap(h);
		const map = solveMapping(clip().cameraTracker!, { width: 1920, height: 1080 }, 1)!;
		for (const f of [0, 17, 42, 59]) {
			const camera = activeCameraAt(s, f);
			const m = 30 + f;
			for (const p of POINTS.slice(0, 8)) {
				const seen = projectPoint(camera, 1920, 1080, toWorld(map, p.pos))!;
				const uv = truthUv(m, p.pos);
				expect(Math.abs(seen[0] - uv[0])).toBeLessThan(0.05);
				expect(Math.abs(seen[1] - uv[1])).toBeLessThan(0.05);
			}
		}
		expect(camClip.camera.transform.position.keyframes[0]!.value).toEqual([960, 540, -1500]);
		const again = h.ok([{ type: 'cameraTracker.create', clipId, replaceCamera: true }]).results[0] as {
			cameraClipId: string;
		};
		expect(again.cameraClipId).toBe(r.cameraClipId);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('Create Text and Camera puts a 3D text layer in the plane of the selected points', () => {
		const { h, clipId } = setup();
		h.ok([
			{ type: 'cameraTracker.add', clipId },
			{ type: 'cameraTracker.setResult', clipId, solve: solve() },
		]);
		const r = h.ok([
			{
				type: 'cameraTracker.create',
				clipId,
				layer: 'text',
				text: 'Hello',
				pointIds: GROUND.map((p) => p.id),
			},
		]).results[0] as { cameraClipId: string; layerClipId: string };
		const layer = h.seq.clips[r.layerClipId] as Clip & { threeD?: { enabled: boolean } };
		expect(layer.kind).toBe('text');
		expect(layer.threeD?.enabled).toBe(true);
		const map = solveMapping(
			(h.seq.clips[clipId] as TClip).cameraTracker!,
			{ width: 1920, height: 1080 },
			1,
		)!;
		const world = layerWorldMatrix(layer as never, 0, {});
		// Layer normal (world z axis column) ⟂ the plane through the points, centre on their centroid.
		const n: Vec3 = [world[2]!, world[6]!, world[10]!];
		const g = GROUND.map((p) => toWorld(map, p.pos));
		const d1: Vec3 = [g[1]![0] - g[0]![0], g[1]![1] - g[0]![1], g[1]![2] - g[0]![2]];
		const d2: Vec3 = [g[2]![0] - g[0]![0], g[2]![1] - g[0]![1], g[2]![2] - g[0]![2]];
		const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		const len = (a: Vec3) => Math.hypot(...a);
		expect(Math.abs(dot(n, d1)) / (len(n) * len(d1))).toBeLessThan(1e-3);
		expect(Math.abs(dot(n, d2)) / (len(n) * len(d2))).toBeLessThan(1e-3);
		const tracks = h.seq.videoTracks.map((t) => t.id);
		expect(tracks.indexOf(layer.trackId)).toBeGreaterThan(0);
		expect(tracks.indexOf(h.seq.clips[r.cameraClipId]!.trackId)).toBeGreaterThan(
			tracks.indexOf(layer.trackId),
		);
		expect(h.tx([{ type: 'cameraTracker.create', clipId, layer: 'solid' }]).ok).toBe(false);
	});

	it('Set Ground Plane and Origin: the points lie on the horizontal plane through the frame centre', () => {
		const { h, clipId, clip } = setup();
		h.ok([
			{ type: 'cameraTracker.add', clipId },
			{ type: 'cameraTracker.setResult', clipId, solve: solve() },
		]);
		expect(h.tx([{ type: 'cameraTracker.setGround', clipId, pointIds: [500, 501] }]).ok).toBe(false);
		h.ok([{ type: 'cameraTracker.setGround', clipId, pointIds: GROUND.map((p) => p.id) }]);
		const t = clip().cameraTracker!;
		const map = solveMapping(t, { width: 1920, height: 1080 }, 1)!;
		for (const p of GROUND) expect(toWorld(map, p.pos)[1]).toBeCloseTo(540, 2);
		const r = h.ok([{ type: 'cameraTracker.create', clipId }]).results[0] as { cameraClipId: string };
		const eye = (h.seq.clips[r.cameraClipId] as CameraClip).camera.transform.position.keyframes[0]!
			.value as Vec3;
		// The camera is above the ground (y down).
		expect(eye[1]).toBeLessThan(540);
		h.ok([{ type: 'cameraTracker.setGround', clipId, pointIds: [] }]);
		expect(clip().cameraTracker!.ground).toBeUndefined();
	});

	it('refuses a camera for footage that is rotated or off-centre', () => {
		const { h, clipId } = setup();
		h.ok([
			{ type: 'cameraTracker.add', clipId },
			{ type: 'cameraTracker.setResult', clipId, solve: solve() },
		]);
		h.ok([{ type: 'param.set', target: ['clip', clipId, 'transform', 'rotation'], value: 10 }]);
		const r = h.tx([{ type: 'cameraTracker.create', clipId }]);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.errors[0]!.code).toBe('E_INVALID_PARAM');
		h.ok([{ type: 'param.set', target: ['clip', clipId, 'transform', 'rotation'], value: 0 }]);
		h.ok([{ type: 'param.set', target: ['clip', clipId, 'transform', 'position'], value: [900, 540] }]);
		expect(h.tx([{ type: 'cameraTracker.create', clipId }]).ok).toBe(false);
	});

	it('invariants flag malformed solves; repair resets them and drops trackers without media', () => {
		const { h, clipId } = setup();
		h.ok([
			{ type: 'cameraTracker.add', clipId },
			{ type: 'cameraTracker.setResult', clipId, solve: solve() },
		]);
		const doc = structuredClone(h.doc);
		const t = (doc.sequences[h.seqId]!.clips[clipId] as TClip).cameraTracker!;
		(t.solve as { frames: number[] }).frames.pop();
		expect(checkInvariants(doc)).toContainEqual(
			expect.objectContaining({
				invariant: 'INV-012',
				path: ['sequences', h.seqId, 'clips', clipId, 'cameraTracker'],
			}),
		);
		const fixed = repairDocument(doc, createCounterIdSource(9));
		expect((fixed.document.sequences[h.seqId]!.clips[clipId] as TClip).cameraTracker!.solve).toBeNull();
		const gone = structuredClone(h.doc);
		(gone.sequences[h.seqId]!.clips[clipId] as TClip).cameraTracker!.mediaId = 'med_missing';
		const r2 = repairDocument(gone, createCounterIdSource(9));
		expect((r2.document.sequences[h.seqId]!.clips[clipId] as TClip).cameraTracker).toBeUndefined();
		h.ok([{ type: 'cameraTracker.remove', clipId }]);
		expect((h.seq.clips[clipId] as TClip).cameraTracker).toBeUndefined();
	});
});
