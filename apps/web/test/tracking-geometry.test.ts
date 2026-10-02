// Tracking overlay geometry (S09:TRU-002/003): media px ↔ sequence px ↔ screen px through a plate's layer map and
// the monitor view, quad drags (corner / edge / body), corner-pin normalisation through the inverse
// Motion, confidence tones, trails and default placement.
import {
	boxToQuad,
	type ClipTracker,
	layerMatrix,
	type Mat3,
	mat3FromMat2D,
	multiplyMat3,
	type Quad,
	type Vec2,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import type { View } from '../src/panels/program/viewport.ts';
import {
	dragQuad,
	dragQuadInMedia,
	mediaToScreen,
	pinIsConvex,
	pinnedCornersSeq,
	quadToScreen,
	screenToMedia,
	seqToPinParam,
	trailAt,
} from '../src/tracking/geometry.ts';

const view: View = { scale: 0.5, x: 12, y: 30 };
/** Plate Motion: scale 150 %, rotation 10°, position (900, 500), anchor at the media centre. */
const motion: Mat3 = mat3FromMat2D(
	layerMatrix({
		position: [900, 500],
		anchor: [960, 540],
		scale: 150,
		scaleWidth: 150,
		uniformScale: true,
		rotation: 10,
		flipH: false,
		flipV: false,
	}),
);
const REF: Quad = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
];

const close = (a: Vec2, b: Vec2, eps = 1e-6) => {
	expect(a[0]).toBeCloseTo(b[0], -Math.log10(eps));
	expect(a[1]).toBeCloseTo(b[1], -Math.log10(eps));
};

describe('media px ↔ screen px', () => {
	it('round-trips through a projective plate map (plate with its own corner pin)', () => {
		const pin = boxToQuad(1920, 1080, [
			[100, 50],
			[1800, 120],
			[1700, 1000],
			[200, 1050],
		])!;
		const map = multiplyMat3(motion, pin);
		for (const p of REF) close(screenToMedia(map, view, mediaToScreen(map, view, p))!, p, 1e-4);
	});

	it('returns null for a singular map', () => {
		expect(screenToMedia([0, 0, 0, 0, 0, 0, 0, 0, 1], view, [10, 10])).toBeNull();
	});
});

describe('quad drags', () => {
	const screenQuad = quadToScreen(motion, view, REF);

	it('moves the two corners of a dragged edge', () => {
		const d: Vec2 = [5, -3];
		const edge = dragQuad(REF, { kind: 'edge', index: 3 }, d); // BL → TL
		expect(edge[3]).toEqual([695, 677]);
		expect(edge[0]).toEqual([705, 297]);
		expect(edge[1]).toEqual(REF[1]);
	});

	it('keeps a dragged corner under the pointer through the inverse plate map', () => {
		const start = screenQuad[0];
		const now: Vec2 = [start[0] + 40, start[1] + 25];
		const q = dragQuadInMedia(REF, { kind: 'corner', index: 0 }, motion, view, start, now)!;
		close(mediaToScreen(motion, view, q[0]), now, 1e-6);
		for (let i = 1; i < 4; i++) expect(q[i]).toEqual(REF[i]);
	});

	it('moves the body by the same screen delta for every corner', () => {
		const start = screenQuad[0];
		const q = dragQuadInMedia(REF, { kind: 'body' }, motion, view, start, [start[0] + 10, start[1]])!;
		for (const [i, p] of q.entries())
			close(mediaToScreen(motion, view, p), [screenQuad[i]![0] + 10, screenQuad[i]![1]], 1e-6);
	});
});

describe('corner pin', () => {
	const box = { width: 1280, height: 720 };
	const params: Quad = [
		[0.1, 0.05],
		[0.9, 0.1],
		[0.85, 0.95],
		[0.05, 0.9],
	];

	it('normalised corner-pin coordinates address sequence pixels', () => {
		const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
		expect(pinnedCornersSeq(identity, params, box)[0]).toEqual([128, 36]);
		expect(seqToPinParam(identity, [128, 36], box)).toEqual([0.1, 0.05]);
	});

	it('flags non-convex pins', () => {
		expect(pinIsConvex(params, box)).toBe(true);
		const crossed: Quad = [params[0], params[2], params[1], params[3]];
		expect(pinIsConvex(crossed, box)).toBe(false);
	});
});

describe('confidence, trails and placement', () => {
	it('keeps the last 30 tracked centres up to the current time', () => {
		const step = 100;
		const data: number[] = [];
		for (let i = 0; i < 50; i++) for (const p of REF) data.push(p[0] + i, p[1]);
		const tracker = {
			kind: 'planar',
			reference: { time: 0, corners: REF },
			samples: { start: 0, step, stride: 8, data, confidence: new Array(50).fill(1) },
		} as unknown as ClipTracker;
		const trail = trailAt(tracker, 40 * step);
		expect(trail).toHaveLength(30);
		expect(trail[29]![0] - trail[0]![0]).toBeCloseTo(29, 6);
		expect(trailAt(tracker, -5 * step)).toHaveLength(0);
		expect(trailAt({ ...tracker, samples: null }, 0)).toEqual([]);
	});
});
