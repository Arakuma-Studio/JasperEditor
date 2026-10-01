// Tracking helpers (S09:TRK-011…013): geometry, edge refinement on synthetic images, robust line fit, confidence,
// request validation/spans/config, and the OpenCV.js worker protocol.
import type { TrackRequest } from '@jasper/api';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeArgs } from '../src/tracking/decode.ts';
import {
	chooseEdgeModes,
	featureMask,
	hApply,
	hInv,
	hMul,
	intersectLines,
	planarConfidence,
	quadInsideDistance,
	quadInwardLines,
	quadIsConvex,
	quadMaxDistance,
	refineQuadEdges,
	robustOffsetFit,
	toMediaPx,
	toTrackingPx,
	trackingSize,
} from '../src/tracking/geometry.ts';
import { trackerConfig, trackSpan, validateTrackRequest } from '../src/tracking/service.ts';
import { acquireWorker, releaseWorker, shutdownWorkers } from '../src/tracking/worker.ts';

afterAll(() => shutdownWorkers());

/** Anti-aliased (4x4 supersampled) render of a convex quad: `fg` inside, `bg` outside, plus a dark `rim` band. */
function renderQuad(
	w: number,
	h: number,
	quad: number[],
	opts: {
		fg: number;
		bg: number;
		rim?: { width: number; value: number };
		noise?: number;
		/** Value at signed distance d from the sides (positive inside); overrides fg/bg/rim. */
		valueAt?: (d: number) => number;
	},
): Uint8Array {
	const img = new Uint8Array(w * h);
	const lines = quadInwardLines(quad);
	let seed = 12345;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let acc = 0;
			for (let sy = 0; sy < 4; sy++)
				for (let sx = 0; sx < 4; sx++) {
					const d = quadInsideDistance(lines, x - 0.375 + sx * 0.25, y - 0.375 + sy * 0.25);
					acc += opts.valueAt
						? opts.valueAt(d)
						: d < 0
							? opts.bg
							: opts.rim && d < opts.rim.width
								? opts.rim.value
								: opts.fg;
				}
			const v = acc / 16 + (opts.noise ? (rnd() - 0.5) * 2 * opts.noise : 0);
			img[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
		}
	return img;
}

const EDGE = { band: 4, n: 48, maxShift: 3, maxResidual: 0.75, minFraction: 0.35, minContrast: 2 };
const EDGE_REF = { band: 6, n: 48, maxShift: 6, maxResidual: 1, minFraction: 0.35, minContrast: 2 };

/** The quad whose sides are those of `quad` moved inward by `inset[k]` px (side k: corner k → k+1). */
function insetQuad(quad: number[], inset: number[]): number[] {
	const lines = quadInwardLines(quad);
	const side = (k: number): [[number, number], [number, number]] => {
		const j = (k + 1) % 4;
		const [nx, ny] = [lines[k]![0]!, lines[k]![1]!];
		return [
			[quad[2 * k]! + nx * inset[k]!, quad[2 * k + 1]! + ny * inset[k]!],
			[quad[2 * j]! + nx * inset[k]!, quad[2 * j + 1]! + ny * inset[k]!],
		];
	};
	const out: number[] = [];
	for (let k = 0; k < 4; k++) {
		const a = side((k + 3) % 4);
		const b = side(k);
		out.push(...intersectLines(a[0], a[1], b[0], b[1])!);
	}
	return out;
}

/** Signed distance (positive inside `quad`) of side k of `refined` from side k of `quad`, at both ends. */
function sideOffsets(quad: number[], refined: number[], k: number): [number, number] {
	const l = quadInwardLines(quad)[k]!;
	const j = (k + 1) % 4;
	const d = (i: number) => l[0]! * refined[2 * i]! + l[1]! * refined[2 * i + 1]! + l[2]!;
	return [d(k), d(j)];
}

describe('homographies and mapping', () => {
	it('inverts, composes and maps points', () => {
		const H = [1.1, 0.05, 30, -0.02, 0.95, 12, 0.0002, -0.0001, 1];
		const I = hMul(H, hInv(H));
		for (let i = 0; i < 9; i++) expect(I[i]).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i]!, 9);
		const [x, y] = hApply(H, 100, 50);
		const back = hApply(hInv(H), x, y);
		expect(back[0]).toBeCloseTo(100, 9);
		expect(back[1]).toBeCloseTo(50, 9);
	});

	it('maps media px ↔ tracking px with pixel centres at integers', () => {
		const s = trackingSize(1920, 1080, 'balanced');
		expect(s).toEqual({ width: 1280, height: 720, sx: 1.5, sy: 1.5 });
		expect(trackingSize(1920, 1080, 'fast')).toMatchObject({ width: 960, height: 540 });
		expect(trackingSize(1920, 1080, 'best')).toEqual({ width: 1920, height: 1080, sx: 1, sy: 1 });
		expect(trackingSize(1280, 720, 'balanced')).toEqual({ width: 1280, height: 720, sx: 1, sy: 1 });
		expect(trackingSize(1080, 1920, 'fast')).toMatchObject({ width: 960, height: 1708 });
		// The centre of media pixel 1 (between tracking pixels 0 and 1 at 1.5x) and the image corners.
		expect(toTrackingPx([-0.5, -0.5, 1919.5, 1079.5], 1.5, 1.5)).toEqual([-0.5, -0.5, 1279.5, 719.5]);
		const v = [12.25, 700.5, 1500, 3];
		expect(toMediaPx(toTrackingPx(v, 1.5, 1.5), 1.5, 1.5).map((x) => Math.round(x * 1e9) / 1e9)).toEqual(v);
	});

	it('detects convex quads and builds feature masks (inside with inset, ring outside)', () => {
		const q = [20, 20, 80, 20, 80, 60, 20, 60];
		expect(quadIsConvex(q)).toBe(true);
		expect(quadIsConvex([20, 20, 80, 60, 80, 20, 20, 60])).toBe(false);
		const roi = { x: 0, y: 0, w: 100, h: 80 };
		const inside = featureMask(q, roi, 'inside', 5);
		expect(inside[40 * 100 + 50]).toBe(255);
		expect(inside[22 * 100 + 50]).toBe(0); // within the inset
		expect(inside[10 * 100 + 50]).toBe(0);
		const ring = featureMask(q, roi, 'surroundings', 5);
		expect(ring[40 * 100 + 50]).toBe(0);
		expect(ring[16 * 100 + 50]).toBe(255); // 4 px outside the top side (ring 5–25 % of the size)
		expect(ring[2 * 100 + 50]).toBe(0);
		const both = featureMask(q, roi, 'both', 5);
		expect(both[40 * 100 + 50]).toBe(255);
		expect(both[16 * 100 + 50]).toBe(255);
	});
});

describe('robust line fit and confidence', () => {
	it('fits off = a + b·t through 30 % outliers', () => {
		const t: number[] = [];
		const off: number[] = [];
		for (let i = 0; i < 40; i++) {
			const ti = 0.1 + (0.8 * i) / 39;
			t.push(ti);
			off.push(0.4 + 1.2 * ti + (i % 10 < 3 ? 3 + (i % 3) : ((i * 7919) % 11) * 0.004));
		}
		const fit = robustOffsetFit(t, off, 1);
		expect(fit.a).toBeCloseTo(0.42, 1);
		expect(fit.b).toBeCloseTo(1.2, 1);
		expect(fit.inliers).toBeGreaterThanOrEqual(28);
		expect(fit.median).toBeLessThan(0.05);
	});

	it('intersects lines', () => {
		expect(intersectLines([0, 0], [10, 0], [5, -5], [5, 5])).toEqual([5, 0]);
		expect(intersectLines([0, 0], [10, 0], [0, 1], [10, 1])).toBeNull();
	});

	it('planar confidence = inlier ratio × (1 − error/threshold)', () => {
		expect(planarConfidence(400, 400, 0, 2)).toBe(1);
		expect(planarConfidence(200, 400, 1, 2)).toBeCloseTo(0.25, 9);
		expect(planarConfidence(300, 400, 5, 2)).toBe(0);
		expect(planarConfidence(0, 400, 0, 2)).toBe(0);
		expect(planarConfidence(10, 0, 0, 2)).toBe(0);
	});
});

describe('edge refinement (planar refineEdges)', () => {
	const W = 320;
	const H = 240;
	const truth = [60.3, 50.7, 262.6, 58.2, 255.4, 190.9, 66.8, 183.1];

	it('snaps a 1–2 px-off predicted quad to the luminance steps within 0.15 px', () => {
		const img = renderQuad(W, H, truth, { fg: 200, bg: 60, noise: 3 });
		const predicted = [61.5, 49.6, 261.2, 59.9, 256.9, 189.5, 65.4, 184.6];
		const modes = chooseEdgeModes(img, W, H, predicted, EDGE_REF);
		expect(modes).toEqual(['rise', 'rise', 'rise', 'rise']);
		const r = refineQuadEdges(img, W, H, predicted, modes, EDGE);
		expect(r.sides.every((s) => s.accepted)).toBe(true);
		expect(quadMaxDistance(predicted, truth)).toBeGreaterThan(1.5);
		expect(quadMaxDistance(r.quad, truth)).toBeLessThan(0.15);
	});

	it('finds the dark valley of a bezel mask between two bright areas', () => {
		// Bright bezel outside, a 3 px dark mask just inside the quad's sides, bright picture inside.
		const img = renderQuad(W, H, truth, { fg: 210, bg: 190, rim: { width: 3, value: 20 }, noise: 2 });
		const predicted = insetQuad(truth, [1.9, 1.2, 1.6, 1.0]);
		const modes = chooseEdgeModes(img, W, H, predicted, EDGE_REF);
		expect(modes).toEqual(['valley', 'valley', 'valley', 'valley']);
		const r = refineQuadEdges(img, W, H, predicted, modes, EDGE);
		// The valley centre lies 1.5 px inside the true sides.
		for (let k = 0; k < 4; k++)
			for (const o of sideOffsets(truth, r.quad, k)) expect(Math.abs(o - 1.5)).toBeLessThan(0.15);
	});

	it('snaps to the edge nearest to the given side, never across the bezel (wall → bezel → mask → screen)', () => {
		// Wall 130 | bright bezel 177 (10 px) | dark mask 21 (3 px) | dark screen 35. The user placed the sides on the
		// mask; the strongest rise (wall → bezel, 10 px outward) must not win.
		const valueAt = (d: number) => (d < -10 ? 130 : d < 0 ? 177 : d < 3 ? 21 : 35);
		const img = renderQuad(W, H, truth, { fg: 0, bg: 0, valueAt, noise: 2 });
		for (const inset of [
			[1.5, 1.5, 1.5, 1.5],
			[0.8, 2.2, 1.1, 0.4],
		]) {
			const given = insetQuad(truth, inset);
			const modes = chooseEdgeModes(img, W, H, given, EDGE_REF);
			expect(modes.every((m) => m === 'valley' || m === 'fall')).toBe(true);
			const r = refineQuadEdges(img, W, H, given, modes, EDGE_REF);
			expect(r.sides.every((s) => s.accepted)).toBe(true);
			for (let k = 0; k < 4; k++)
				for (const o of sideOffsets(truth, r.quad, k)) {
					expect(o).toBeGreaterThan(-0.3); // not on the outer bezel edge (-10)
					expect(o).toBeLessThan(1.8); // at the bezel-inner/mask edge or the mask centre
				}
			// Per-frame refinement from a prediction 1 px off keeps the same edge.
			const next = refineQuadEdges(img, W, H, insetQuad(r.quad, [1, -1, 0.5, -0.8]), modes, EDGE);
			expect(quadMaxDistance(next.quad, r.quad)).toBeLessThan(0.2);
		}
	});

	it('keeps the predicted line for sides outside the frame and rejects far edges', () => {
		const low = [60.3, 50.7, 262.6, 58.2, 255.4, 300, 66.8, 290]; // bottom side below the frame
		const img = renderQuad(W, H, low, { fg: 200, bg: 60, noise: 2 });
		const predicted = low.map((v, i) => (i < 4 ? v + 1 : v + 0.8));
		const modes = chooseEdgeModes(img, W, H, predicted, EDGE_REF);
		expect(modes[2]).toBeNull();
		const r = refineQuadEdges(img, W, H, predicted, modes, EDGE);
		expect(r.sides.map((s) => s.accepted)).toEqual([true, true, false, true]);
		expect(Math.hypot(r.quad[0]! - low[0]!, r.quad[1]! - low[1]!)).toBeLessThan(0.15);
		// An edge 6 px away from the prediction is out of the ±4 px band / 3 px shift: nothing moves.
		const far = predicted.map((v, i) => (i % 2 ? v + 6 : v));
		const r2 = refineQuadEdges(img, W, H, far, ['rise', null, null, null], EDGE);
		expect(r2.sides[0]!.accepted).toBe(false);
		expect(r2.quad).toEqual(far);
	});
});

describe('requests, spans and tracker configuration', () => {
	const base: TrackRequest = {
		mediaKey: 'mk_x',
		kind: 'planar',
		reference: {
			frame: 50,
			corners: [
				[100, 100],
				[500, 110],
				[490, 400],
				[110, 390],
			],
		},
		range: { startFrame: 10, endFrame: 90 },
		direction: 'both',
		quality: 'balanced',
	};
	const facts = { display: { width: 1920, height: 1080 }, frameCount: 120 };

	it('spans: forward = ref…end, backward = start…ref, both = range', () => {
		expect(trackSpan(base)).toEqual({ start: 10, end: 90 });
		expect(trackSpan({ ...base, direction: 'forward' })).toEqual({ start: 50, end: 90 });
		expect(trackSpan({ ...base, direction: 'backward' })).toEqual({ start: 10, end: 51 });
	});

	it('validates the reference frame, range and geometry', () => {
		expect(validateTrackRequest(base, facts)).toBeNull();
		expect(validateTrackRequest({ ...base, range: { startFrame: 60, endFrame: 90 } }, facts)).toMatch(
			/contain/,
		);
		expect(validateTrackRequest({ ...base, range: { startFrame: 90, endFrame: 90 } }, facts)).toMatch(
			/greater/,
		);
		expect(
			validateTrackRequest(
				{ ...base, reference: { frame: 130, corners: base.reference.corners } },
				{ ...facts, frameCount: 120 },
			),
		).toMatch(/contain|beyond/);
		expect(validateTrackRequest({ ...base, reference: { frame: 50 } }, facts)).toMatch(/corners/);
		expect(
			validateTrackRequest({ ...base, kind: 'point', reference: { frame: 50, point: [3000, 5] } }, facts),
		).toMatch(/outside/);
		// A screen cut by the frame edge: corners outside the picture are fine.
		const cut = {
			...base,
			reference: {
				frame: 50,
				corners: [
					[886, 596],
					[1787, 616],
					[1790, 1180],
					[880, 1170],
				] as [number, number][],
			},
		};
		expect(validateTrackRequest(cut, facts)).toBeNull();
	});

	it('builds worker configurations in tracking px', () => {
		const size = trackingSize(1920, 1080, 'balanced');
		const p = trackerConfig({ ...base, options: { features: 'surroundings', refineEdges: true } }, size);
		expect(p).toMatchObject({
			kind: 'planar',
			width: 1280,
			height: 720,
			features: 'surroundings',
			refineEdges: true,
			ecc: false,
			maxFeatures: 400,
			winSize: 21,
			maxLevel: 3,
			fbMax: 1,
			ransacThreshold: 2,
			minSurvival: 0.3,
		});
		expect((p as { corners: number[] }).corners[0]).toBeCloseTo((100 + 0.5) / 1.5 - 0.5, 9);
		expect(trackerConfig({ ...base, quality: 'best' }, trackingSize(1920, 1080, 'best'))).toMatchObject({
			ecc: true,
			width: 1920,
		});
		const pt = trackerConfig(
			{ ...base, kind: 'point', reference: { frame: 50, point: [300, 200], patch: 33, search: 60 } },
			size,
		);
		expect(pt).toMatchObject({ kind: 'point', patch: 23, search: 40, minScore: 0.5 });
	});

	it('decodes with an input seek half a frame early, LGPL filters only', () => {
		const args = decodeArgs({
			file: '/m.mov',
			start: 30,
			count: 10,
			fps: { num: 30000, den: 1001 },
			width: 1280,
			height: 720,
			scale: true,
		});
		expect(args.slice(0, 2)).toEqual(['-ss', ((29.5 * 1001) / 30000).toFixed(6)]);
		expect(args).toContain('-fps_mode');
		expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:720:flags=area,format=gray');
		expect(args[args.indexOf('-frames:v') + 1]).toBe('10');
		expect(
			decodeArgs({
				file: '/m.mov',
				start: 0,
				count: 1,
				fps: { num: 25, den: 1 },
				width: 640,
				height: 360,
				scale: false,
			}),
		).not.toContain('-ss');
		const filters = args[args.indexOf('-vf') + 1]!.split(',').map((f) => f.split('=')[0]);
		for (const gpl of ['eq', 'perspective', 'boxblur', 'hqdn3d', 'smartblur', 'delogo'])
			expect(filters).not.toContain(gpl);
	});
});

describe('tracking worker (OpenCV.js in worker_threads)', () => {
	it('loads OpenCV, tracks a translated texture and reports errors without dying', async () => {
		const w = acquireWorker();
		await w.ready;
		const W = 160;
		const H = 120;
		const tex = (dx: number) => {
			const img = new Uint8Array(W * H);
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++) {
					const u = x - dx;
					img[y * W + x] = 128 + 60 * Math.sin(u * 0.31) * Math.cos(y * 0.23) + 40 * Math.sin((u + y) * 0.11);
				}
			return img;
		};
		const quad = [40, 30, 120, 30, 120, 90, 40, 90];
		await w.call({
			type: 'init',
			cfg: {
				kind: 'planar',
				width: W,
				height: H,
				corners: quad,
				features: 'inside',
				refineEdges: false,
				ecc: false,
				maxFeatures: 200,
				qualityLevel: 0.01,
				minDistance: 4,
				winSize: 15,
				maxLevel: 2,
				fbMax: 1,
				ransacThreshold: 2,
				minSurvival: 0.3,
			},
		});
		const send = async (type: 'reference' | 'frame', img: Uint8Array) =>
			w.result({ type, frame: 0, buf: img.buffer as ArrayBuffer }, [img.buffer as ArrayBuffer]);
		expect((await send('reference', tex(0))).values).toEqual(quad);
		const r = await send('frame', tex(2.5));
		expect(r.lost).toBe(false);
		expect(
			quadMaxDistance(
				r.values,
				quad.map((v, i) => (i % 2 ? v : v + 2.5)),
			),
		).toBeLessThan(0.2);
		// A flat reference region has nothing to track: a clear error, and the worker stays usable.
		await w.call({
			type: 'init',
			cfg: {
				kind: 'planar',
				width: W,
				height: H,
				corners: quad,
				features: 'inside',
				refineEdges: false,
				ecc: false,
				maxFeatures: 200,
				qualityLevel: 0.01,
				minDistance: 4,
				winSize: 15,
				maxLevel: 2,
				fbMax: 1,
				ransacThreshold: 2,
				minSurvival: 0.3,
			},
		});
		await expect(send('reference', new Uint8Array(W * H).fill(90))).rejects.toThrow(/Not enough texture/);
		await w.call({
			type: 'init',
			cfg: { kind: 'point', width: W, height: H, point: [80, 60], patch: 15, search: 10, minScore: 0.5 },
		});
		expect((await send('reference', tex(0))).values).toEqual([80, 60]);
		const p = await send('frame', tex(-3.25));
		expect(p.values[0]).toBeCloseTo(76.75, 0);
		expect(Math.abs(p.values[0]! - 76.75)).toBeLessThan(0.2);
		expect(p.confidence).toBeGreaterThan(0.9);
		await releaseWorker(w);
	}, 60_000);
});
