import { describe, expect, it } from 'vitest';
import {
	applyMatrix,
	buildRenderSnapshot,
	type Clip,
	engineAffinity,
	invertMatrix,
	type LayerTransformValues,
	layerMatrix,
	layerQuad,
	quadBounds,
	resolveSceneAt,
	visibleRect,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const base: LayerTransformValues = {
	position: [960, 540],
	anchor: [100, 50],
	scale: 100,
	scaleWidth: 100,
	uniformScale: true,
	rotation: 0,
	flipH: false,
	flipV: false,
};

describe('layer transform math (S03:DM-010…012)', () => {
	it('anchor lands on position', () => {
		for (const rotation of [0, 33, 90, -270, 725]) {
			const m = layerMatrix({ ...base, rotation, scale: 150, scaleWidth: 40, uniformScale: false });
			const p = applyMatrix(m, base.anchor);
			expect(p[0]).toBeCloseTo(960, 9);
			expect(p[1]).toBeCloseTo(540, 9);
		}
	});

	it('rotates clockwise on screen (y-down)', () => {
		const m = layerMatrix({ ...base, anchor: [0, 0], position: [0, 0], rotation: 90 });
		const p = applyMatrix(m, [10, 0]);
		expect(p[0]).toBeCloseTo(0, 9);
		expect(p[1]).toBeCloseTo(10, 9);
	});
	it('non-uniform scale: Scale is vertical, Scale Width horizontal (S01:FX-001)', () => {
		const m = layerMatrix({
			...base,
			anchor: [0, 0],
			position: [0, 0],
			scale: 200,
			scaleWidth: 50,
			uniformScale: false,
		});
		expect(applyMatrix(m, [10, 10])).toEqual([5, 20]);
	});
	it('quad, bounds and inverse are consistent; crop hides without moving', () => {
		const v = { ...base, rotation: 30, scale: 150, scaleWidth: 60, uniformScale: false };
		const m = layerMatrix(v);
		const box = { width: 200, height: 100 };
		const quad = layerQuad(m, visibleRect(box));
		const inv = invertMatrix(m)!;
		const back = applyMatrix(inv, quad[2]);
		expect(back[0]).toBeCloseTo(200, 9);
		expect(back[1]).toBeCloseTo(100, 9);
		const b = quadBounds(quad);
		for (const p of quad) {
			expect(p[0]).toBeGreaterThanOrEqual(b.x - 1e-9);
			expect(p[1]).toBeLessThanOrEqual(b.y + b.height + 1e-9);
		}
		const cropped = visibleRect(box, { left: 25, top: 0, right: 0, bottom: 50 });
		expect(cropped).toEqual({ x: 50, y: 0, width: 150, height: 50 });
		expect(invertMatrix(layerMatrix({ ...base, scale: 0 }))).toBeNull();
	});
});

describe('render snapshot and scene (ARCHITECTURE §5.5)', () => {
	it('builds tracks bottom→top, resolves mute/solo/output and evaluates layers per frame', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 0 },
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Hi' }, ref: '$t' },
			{ type: 'param.setAnimated', target: ['clip', '$t', 'opacity'], animated: true, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', '$t', 'opacity'], value: 0, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', '$t', 'opacity'], value: 100, at: { frames: 30 } },
			{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V3', color: [0, 1, 0, 1] },
			{ type: 'track.update', trackId: 'V3', patch: { output: false } },
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, {
			resolveMedia: (a) => ({
				url: `/media/${a.id}`,
				proxyUrl: null,
				kind: a.kind,
				width: 1920,
				height: 1080,
				durationFlicks: a.probe.durationFlicks,
				hasAudio: true,
				rotation: 0,
			}),
			resolveFont: (f) => `/fonts/${f.family}.woff2`,
		});
		expect(snap.videoTracks.map((t) => t.clips.length)).toEqual([1, 1]);
		expect(snap.audioClips).toHaveLength(1);
		expect(snap.fonts).toHaveLength(1);
		expect(snap.durationFrames).toBe(300);
		expect(snap.media[m]!.url).toBe(`/media/${m}`);
		const at15 = resolveSceneAt(snap, 15);
		expect(at15.map((l) => l.clip.kind)).toEqual(['video', 'text']);
		expect(at15[1]!.props.opacity).toBeCloseTo(50, 6);
		const at45 = resolveSceneAt(snap, 45);
		expect(at45[1]!.props.opacity).toBe(100);
		// Solo A2 silences A1.
		h.ok([{ type: 'track.update', trackId: 'A2', patch: { solo: true } }]);
		const solo = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(solo.audioClips).toHaveLength(0);
		expect(solo.media[m]).toBeNull();
		const aff = engineAffinity(snap);
		expect(aff.clips[(h.clips('V2')[0] as Clip).id]).toBe('remotion');
		expect(aff.ranges[0]).toEqual({ start: 0, end: 60, engines: ['native', 'remotion'] });
		expect(aff.ranges[1]).toEqual({ start: 60, end: 300, engines: ['native'] });
	});
	it('limits the snapshot to an export range', () => {
		const h = new Harness();
		h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 1, 1, 1] },
			{ type: 'clip.addSolid', at: 100, duration: 10, track: 'V1', color: [1, 1, 1, 1] },
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, {
			range: { start: 50, end: 150 },
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		expect(snap.videoTracks[0]!.clips).toHaveLength(1);
		expect(snap.durationFrames).toBe(100);
	});
});
