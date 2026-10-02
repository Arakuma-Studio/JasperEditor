// S09:TRK-012: edge refinement must stay on the selected screen border and
// preserve a side when no corresponding edge is visible.
import { describe, expect, it } from 'vitest';
import {
	chooseEdgeModes,
	intersectLines,
	quadInsideDistance,
	quadInwardLines,
	quadMaxDistance,
	refineQuadEdges,
} from '../src/tracking/geometry.ts';

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

describe('planar edge refinement', () => {
	const W = 320;
	const H = 240;
	const truth = [60.3, 50.7, 262.6, 58.2, 255.4, 190.9, 66.8, 183.1];

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
			const r = refineQuadEdges(img, W, H, given, modes, EDGE_REF);
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
		const r = refineQuadEdges(img, W, H, predicted, modes, EDGE);
		expect(Math.hypot(r.quad[0]! - low[0]!, r.quad[1]! - low[1]!)).toBeLessThan(0.15);
		expect(Math.hypot(r.quad[4]! - predicted[4]!, r.quad[5]! - predicted[5]!)).toBeLessThan(1);
		// An edge 6 px away from the prediction is out of the ±4 px band / 3 px shift: nothing moves.
		const far = predicted.map((v, i) => (i % 2 ? v + 6 : v));
		const r2 = refineQuadEdges(img, W, H, far, ['rise', null, null, null], EDGE);
		expect(r2.quad).toEqual(far);
	});
});
