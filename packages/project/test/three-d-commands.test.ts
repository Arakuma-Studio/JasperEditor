import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	activeCameraAt,
	buildRenderSnapshot,
	type CameraClip,
	checkInvariants,
	createCounterIdSource,
	FLICKS_PER_SECOND,
	type LightClip,
	type MediaHandle,
	propertiesForClip,
	repairDocument,
	resolveVideoTransitions,
	runs3d,
	stackAt,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const media = (): MediaHandle => ({
	url: 'x',
	proxyUrl: null,
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: 10 * FLICKS_PER_SECOND,
	hasAudio: false,
	rotation: 0,
});
const snap = (h: Harness) =>
	buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: media, resolveFont: () => 'f.woff2' });
const clean = (h: Harness) => expect(checkInvariants(h.doc)).toEqual([]);

function solid(h: Harness, at = 0, track = 'V1'): string {
	const r = h.ok([{ type: 'clip.addSolid', at, duration: 60, track, color: [1, 0, 0, 1] }]);
	return (r.results[0] as { clipId: string }).clipId;
}

describe('clip.set3d', () => {
	it('turns the 3D Layer switch on with After Effects defaults, off keeps the values', () => {
		const h = new Harness();
		const id = solid(h);
		h.ok([{ type: 'clip.set3d', clipIds: [id], enabled: true }]);
		const c = h.seq.clips[id] as { threeD?: { enabled: boolean; positionZ: { value: number } } };
		expect(c.threeD?.enabled).toBe(true);
		h.ok([{ type: 'param.set', target: ['clip', id, 'threeD', 'positionZ'], value: 250 }]);
		h.ok([{ type: 'clip.set3d', clipIds: [id], enabled: false }]);
		const off = h.seq.clips[id] as typeof c;
		expect(off.threeD?.enabled).toBe(false);
		expect(off.threeD?.positionZ.value).toBe(250);
		expect(snap(h).videoTracks[0]!.clips[0]!.threeD).toBeUndefined();
		h.ok([{ type: 'clip.set3d', clipIds: [id], enabled: true }]);
		expect(snap(h).videoTracks[0]!.clips[0]!.threeD?.positionZ.value).toBe(250);
		expect(snap(h).videoTracks[0]!.clips[0]!.engine).toBe('remotion');
		clean(h);
	});

	it('refuses kinds without Motion and clips with transitions; transitions are refused on 3D layers', () => {
		const h = new Harness();
		const adj = h.ok([{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V2' }]).results[0] as {
			clipId: string;
		};
		const r = h.tx([{ type: 'clip.set3d', clipIds: [adj.clipId], enabled: true }]);
		expect(r.ok).toBe(false);
		const a = solid(h, 0);
		const b = solid(h, 60);
		h.ok([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 60,
				effectId: 'jasper.cross-dissolve',
				duration: 10,
				handles: 'freeze',
			},
		]);
		const refused = h.tx([{ type: 'clip.set3d', clipIds: [a], enabled: true }]);
		expect(refused.ok).toBe(false);
		expect(!refused.ok && refused.errors[0]!.message).toMatch(/transitions/);
		h.ok([{ type: 'transition.remove', transitionIds: Object.keys(h.seq.transitions) }]);
		h.ok([{ type: 'clip.set3d', clipIds: [a], enabled: true }]);
		const t = h.tx([
			{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		expect(t.ok).toBe(false);
		const d = h.ok([{ type: 'transition.applyDefault', clipIds: [a, b], edges: 'both' }]);
		expect(d.warnings.some((w) => w.code === 'W_TRANSITION_3D')).toBe(true);
		expect(
			Object.values(h.seq.transitions).some((x) => x.outgoingClipId === a || x.incomingClipId === a),
		).toBe(false);
	});

	it('locked tracks refuse', () => {
		const h = new Harness();
		const id = solid(h);
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		expect(h.tx([{ type: 'clip.set3d', clipIds: [id], enabled: true }]).ok).toBe(false);
	});

	it('3D properties are keyframable through param.set; registry rows appear only on 3D layers', () => {
		const h = new Harness();
		const id = solid(h);
		expect(propertiesForClip(h.seq.clips[id]!).some((s) => s.key === 'threeD.positionZ')).toBe(false);
		h.ok([{ type: 'clip.set3d', clipIds: [id], enabled: true }]);
		const keys = propertiesForClip(h.seq.clips[id]!).map((s) => s.key);
		expect(keys).toEqual(
			expect.arrayContaining([
				'threeD.positionZ',
				'threeD.orientation',
				'threeD.rotationX',
				'threeD.material.castsShadows',
			]),
		);
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'threeD', 'rotationY'],
				animated: true,
				at: { frames: 0 },
			},
			{ type: 'param.set', target: ['clip', id, 'threeD', 'rotationY'], value: 90, at: { frames: 30 } },
			{ type: 'param.set', target: ['clip', id, 'threeD', 'orientation'], value: [10, 20, 30] },
			{ type: 'param.set', target: ['clip', id, 'threeD', 'material', 'castsShadows'], value: 'on' },
			{ type: 'param.set', target: ['clip', id, 'threeD', 'material', 'specularShininess'], value: 250 },
		]);
		const c = h.seq.clips[id] as {
			threeD: {
				rotationY: { keyframes: unknown[] };
				material: { castsShadows: string; specularShininess: { value: number } };
			};
		};
		expect(c.threeD.rotationY.keyframes).toHaveLength(2);
		expect(c.threeD.material.castsShadows).toBe('on');
		expect(c.threeD.material.specularShininess.value).toBe(100); // clamped
		expect(
			h.tx([{ type: 'param.set', target: ['clip', id, 'threeD', 'orientation'], value: [1, 2] }]).ok,
		).toBe(false);
		expect(
			h.tx([
				{ type: 'param.set', target: ['clip', id, 'threeD', 'material', 'castsShadows'], value: 'maybe' },
			]).ok,
		).toBe(false);
		clean(h);
	});
});

describe('cameras', () => {
	it('clip.addCamera: a two-node 50 mm camera on top that frames the sequence like the default camera', () => {
		const h = new Harness();
		solid(h);
		const r = h.ok([{ type: 'clip.addCamera', at: 0 }]);
		const id = (r.results[0] as { clipId: string }).clipId;
		const c = h.seq.clips[id] as CameraClip;
		expect(c.kind).toBe('camera');
		expect(c.name).toBe('Camera 1');
		// The top track is free: the camera goes there (AE: new layers on top).
		expect(c.trackId).toBe(h.seq.videoTracks[h.seq.videoTracks.length - 1]!.id);
		expect(c.duration).toBeGreaterThanOrEqual(150);
		const s = snap(h);
		expect(s.scene3d?.cameras.map((x) => x.clipId)).toEqual([id]);
		const cam = activeCameraAt(s, 0);
		// 50 mm on a 36 mm sensor: zoom = 1920×50/36; eye is one zoom behind the frame centre.
		expect(cam.zoom).toBeCloseTo(8000 / 3, 9);
		expect(cam.eye).toEqual([960, 540, expect.closeTo(-8000 / 3, 9)]);
		expect(c.camera.transform.pointOfInterest.value).toEqual([960, 540, 0]);
		expect(c.camera.transform.autoOrient).toBe('poi');
		clean(h);
	});

	it('Camera Settings: preset, focal length, angle of view, f-stop, lock to zoom, one-node', () => {
		const h = new Harness();
		const id = (h.ok([{ type: 'clip.addCamera', at: 0, preset: '35mm' }]).results[0] as { clipId: string })
			.clipId;
		const zoom = () => (h.seq.clips[id] as CameraClip).camera.zoom.value;
		expect(zoom()).toBeCloseTo(5600 / 3, 6); // 1920×35mm/36mm
		h.ok([
			{
				type: 'camera.settings',
				clipId: id,
				focalLength: 80,
				lockToZoom: true,
				depthOfField: true,
				fStop: 2,
			},
		]);
		const cam = (h.seq.clips[id] as CameraClip).camera;
		expect(cam.zoom.value).toBeCloseTo(12800 / 3, 6); // 1920×80mm/36mm
		expect(cam.focusDistance.value).toBeCloseTo(cam.zoom.value, 6);
		expect(cam.depthOfField).toBe(true);
		expect(cam.aperture.value).toBeCloseTo(40, 6); // 80 mm / f2 = 40 mm at the 1920 px reference
		h.ok([{ type: 'camera.settings', clipId: id, angleOfView: 60 }]);
		expect(2 * Math.atan(960 / zoom()) * (180 / Math.PI)).toBeCloseTo(60, 6);
		expect(h.tx([{ type: 'camera.settings', clipId: id, preset: '13mm' }]).ok).toBe(false);
		// One-node keeps the view: orientation turns toward the old point of interest.
		h.ok([{ type: 'param.set', target: ['clip', id, 'camera', 'pointOfInterest'], value: [1400, 540, 0] }]);
		const before = activeCameraAt(snap(h), 0);
		h.ok([{ type: 'camera.settings', clipId: id, cameraType: 'one-node' }]);
		const after = activeCameraAt(snap(h), 0);
		for (let i = 8; i < 11; i++) expect(after.view[i]!).toBeCloseTo(before.view[i]!, 6);
		expect(h.tx([{ type: 'camera.settings', clipId: 'clp_nope000000000000', zoom: 10 }]).ok).toBe(false);
		clean(h);
	});

	it('camera tools: orbit keeps the distance to the point of interest; pan moves both; dolly approaches', () => {
		const h = new Harness();
		const id = (h.ok([{ type: 'clip.addCamera', at: 0 }]).results[0] as { clipId: string }).clipId;
		const tr = () => (h.seq.clips[id] as CameraClip).camera.transform;
		const dist = () => {
			const p = tr().position.value;
			const q = tr().pointOfInterest.value;
			return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
		};
		const d0 = dist();
		fc.assert(
			fc.property(
				fc.double({ min: -180, max: 180, noNaN: true }),
				fc.double({ min: -60, max: 60, noNaN: true }),
				(yaw, pitch) => {
					h.ok([{ type: 'camera.orbit', clipId: id, yaw, pitch }]);
					expect(dist()).toBeCloseTo(d0, 6);
				},
			),
			{ numRuns: 25 },
		);
		const poi0 = tr().pointOfInterest.value;
		h.ok([{ type: 'camera.pan', clipId: id, dx: 100, dy: 0 }]);
		expect(tr().pointOfInterest.value).not.toEqual(poi0);
		expect(dist()).toBeCloseTo(d0, 6);
		h.ok([{ type: 'camera.dolly', clipId: id, amount: 500 }]);
		expect(dist()).toBeCloseTo(d0 - 500, 6);
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'camera', 'position'],
				animated: true,
				at: { frames: 0 },
			},
			{ type: 'camera.dolly', clipId: id, amount: 100, at: { frames: 30 } },
		]);
		expect(tr().position.keyframes).toHaveLength(2);
	});
});

describe('lights', () => {
	it('clip.addLight: types, settings, environment media validation', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addLight', at: 0, lightType: 'spot', coneAngle: 60, castsShadows: true, intensity: 150 },
			{ type: 'clip.addLight', at: 0, lightType: 'ambient', intensity: 20 },
		]);
		const [a, b] = r.results.map((x) => (x as { clipId: string }).clipId);
		const spot = h.seq.clips[a!] as LightClip;
		expect(spot.light.type).toBe('spot');
		expect(spot.light.coneAngle.value).toBe(60);
		expect(spot.light.castsShadows).toBe(true);
		expect(spot.light.transform.autoOrient).toBe('poi');
		expect((h.seq.clips[b!] as LightClip).light.transform.autoOrient).toBe('off');
		h.ok([
			{ type: 'light.settings', clipId: a!, lightType: 'point', falloff: 'inverse-square', radius: 200 },
		]);
		expect((h.seq.clips[a!] as LightClip).light.transform.autoOrient).toBe('off');
		expect(snap(h).scene3d?.lights).toHaveLength(2);
		expect(h.tx([{ type: 'light.settings', clipId: a!, environmentMediaId: 'med_x' }]).ok).toBe(false);
		const m = h.registerVideo({ kind: 'image' });
		h.ok([{ type: 'light.settings', clipId: a!, lightType: 'environment', environmentMediaId: m }]);
		expect((h.seq.clips[a!] as LightClip).light.environmentMediaId).toBe(m);
		expect(snap(h).media[m]).toBeTruthy();
		clean(h);
		const broken = JSON.parse(JSON.stringify(h.doc));
		const seq = Object.values(broken.sequences)[0] as { clips: Record<string, Record<string, unknown>> };
		(seq.clips[a!]!.light as { environmentMediaId: string }).environmentMediaId = 'med_gone';
		expect(checkInvariants(broken).length).toBeGreaterThan(0);
		const fixed = repairDocument(broken, createCounterIdSource(9));
		expect(fixed.report.some((r) => r.action === 'reset-environment')).toBe(true);
		expect(checkInvariants(fixed.document)).toEqual([]);
	});

	it('disabled and hidden-track lights are off', () => {
		const h = new Harness();
		const id = (h.ok([{ type: 'clip.addLight', at: 0, lightType: 'point' }]).results[0] as { clipId: string })
			.clipId;
		h.ok([{ type: 'clip.update', clipId: id, patch: { enabled: false } }]);
		expect(snap(h).scene3d).toBeUndefined();
	});
});

describe('runs and the renderer setting', () => {
	it('3D runs across tracks; a 2D layer between them splits them; sequence.set3dRenderer', () => {
		const h = new Harness();
		const a = solid(h, 0, 'V1');
		const b = solid(h, 0, 'V2');
		const c = solid(h, 0, 'V3');
		const d = solid(h, 0, 'V4');
		h.ok([{ type: 'clip.set3d', clipIds: [a, b, d], enabled: true }]);
		const s = snap(h);
		expect(runs3d(stackAt(s.videoTracks, 10))).toEqual([
			{ members: [a, b], topTrack: 1, bottomTrack: 0 },
			{ members: [d], topTrack: 3, bottomTrack: 3 },
		]);
		expect(c).toBeTruthy();
		h.ok([{ type: 'sequence.set3dRenderer', renderer: 'advanced', draft: true }]);
		expect(snap(h).scene3d?.renderer).toBe('advanced');
		expect(snap(h).scene3d?.draft).toBe(true);
	});

	it('a transition kept in an old document on a 3D layer is skipped with a warning', () => {
		const h = new Harness();
		const a = solid(h, 0);
		solid(h, 60);
		h.ok([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 60,
				effectId: 'jasper.cross-dissolve',
				duration: 10,
				handles: 'freeze',
			},
		]);
		const doc = JSON.parse(JSON.stringify(h.doc));
		const seq = Object.values(doc.sequences)[0] as { clips: Record<string, Record<string, unknown>> };
		h.ok([{ type: 'transition.remove', transitionIds: Object.keys(h.seq.transitions) }]);
		h.ok([{ type: 'clip.set3d', clipIds: [a], enabled: true }]);
		seq.clips[a]!.threeD = JSON.parse(JSON.stringify((h.seq.clips[a] as { threeD: unknown }).threeD));
		const r = resolveVideoTransitions(doc, Object.values(doc.sequences)[0] as never);
		expect(r.skipped.some((x) => /3D layers/.test(x.reason))).toBe(true);
	});
});
